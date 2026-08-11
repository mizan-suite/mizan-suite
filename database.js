// database.js
// This file sets up our SQLite database and applies schema migrations.
// SQLite stores everything in a single file (mizan.db) - no server needed.

// Node has a built-in SQLite module since v22 - no extra install/compilation needed.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
// Absolute path, anchored to this file's folder - works whether started as
// "node server.js" (cwd = project folder) or via Electron (cwd can differ).
// When run from a packaged Electron app, electron/main.js sets PARAVIE_DB_PATH
// to the app's userData folder, because the app folder itself is read-only.
const DB_PATH = process.env.PARAVIE_DB_PATH || path.join(__dirname, 'mizan.db');

let db = new DatabaseSync(DB_PATH);

// WAL mode: readers never block writers and vice-versa, and writes are batched
// into a -wal file instead of hammering the main db file. busy_timeout makes a
// concurrent write wait (instead of failing with "database is locked") when two
// tabs/processes touch the DB at the same time.
try {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
} catch (err) {
  console.warn('[database] could not set pragmas:', err.message);
}

// ---------- MIGRATION FRAMEWORK ----------
// Every schema change is a numbered, one-way migration. Applied versions are
// recorded in the schema_migrations table, so each migration runs exactly once
// no matter how many times the app starts. This replaces the old approach of
// running every "ALTER TABLE ... ADD COLUMN" guarded by try/catch on startup.

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT DEFAULT (datetime('now'))
  )
`);

// Add a column only if it doesn't already exist (older installs vs fresh ones).
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

const MIGRATIONS = [
  {
    version: 1,
    name: 'products.max_stock (overstock alerts)',
    up() { ensureColumn('products', 'max_stock', 'INTEGER'); }
  },
  {
    version: 2,
    name: 'products.active (soft delete)',
    up() { ensureColumn('products', 'active', 'INTEGER NOT NULL DEFAULT 1'); }
  },
  {
    version: 3,
    name: 'products.wholesale_price (bulk price)',
    up() { ensureColumn('products', 'wholesale_price', 'REAL NOT NULL DEFAULT 0'); }
  },
  {
    version: 4,
    name: 'products.margin_type (markup mode)',
    up() { ensureColumn('products', 'margin_type', "TEXT NOT NULL DEFAULT ''"); }
  },
  {
    version: 5,
    name: 'products.margin_value (markup value)',
    up() { ensureColumn('products', 'margin_value', 'REAL NOT NULL DEFAULT 0'); }
  },
  {
    version: 6,
    name: 'products.min_stock (low-stock threshold)',
    up() { ensureColumn('products', 'min_stock', 'INTEGER NOT NULL DEFAULT 5'); }
  },
  {
    version: 7,
    name: 'rename old gross_price to wholesale_price',
    up() {
      const cols = db.prepare('PRAGMA table_info(products)').all();
      if (cols.some(c => c.name === 'gross_price')) {
        db.exec('UPDATE products SET wholesale_price = gross_price WHERE wholesale_price = 0 AND gross_price > 0');
      }
    }
  },
  {
    version: 8,
    name: 'backfill product_barcodes from products.barcode',
    up() {
      db.exec(`INSERT OR IGNORE INTO product_barcodes (product_id, barcode)
               SELECT id, barcode FROM products WHERE barcode IS NOT NULL AND barcode != ''`);
    }
  },
  {
    version: 9,
    name: 'suppliers.active (soft delete)',
    up() { ensureColumn('suppliers', 'active', 'INTEGER NOT NULL DEFAULT 1'); }
  },
  {
    version: 10,
    name: 'purchase_orders discount fields',
    up() {
      ensureColumn('purchase_orders', 'discount_type', 'TEXT');
      ensureColumn('purchase_orders', 'discount_value', 'REAL');
      ensureColumn('purchase_orders', 'discount_amount', 'REAL');
    }
  },
  {
    version: 11,
    name: 'sales subtotal/discount/status fields',
    up() {
      ensureColumn('sales', 'subtotal', 'REAL');
      ensureColumn('sales', 'discount_type', 'TEXT');
      ensureColumn('sales', 'discount_value', 'REAL');
      ensureColumn('sales', 'status', "TEXT NOT NULL DEFAULT 'completed'");
    }
  },
  {
    version: 12,
    name: 'sales client_id / loyalty points fields',
    up() {
      ensureColumn('sales', 'client_id', 'INTEGER');
      ensureColumn('sales', 'points_earned', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn('sales', 'points_redeemed', 'INTEGER NOT NULL DEFAULT 0');
    }
  },
  {
    version: 13,
    name: 'purchase_orders on-credit fields',
    up() {
      ensureColumn('purchase_orders', 'on_credit', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn('purchase_orders', 'due_date', 'TEXT');
    }
  },
  {
    version: 14,
    name: 'users.permissions (per-account access rights)',
    up() { ensureColumn('users', 'permissions', 'TEXT'); }
  },
  {
    version: 15,
    name: 'migrate old owner PIN into an owner account',
    up() {
      const ownerCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'owner'").get().c;
      const oldPin = db.prepare("SELECT value FROM settings WHERE key = 'owner_pin_hash'").get();
      if (ownerCount === 0 && oldPin && oldPin.value) {
        db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('Owner', ?, 'owner')").run(oldPin.value);
        db.prepare("DELETE FROM settings WHERE key = 'owner_pin_hash'").run();
      }
    }
  },
  {
    version: 16,
    name: 'persistent login sessions table',
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          role TEXT NOT NULL,
          exp INTEGER NOT NULL,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    }
  },
  {
    version: 17,
    name: 'users.salt (per-account scrypt PIN hashing)',
    up() { ensureColumn('users', 'salt', 'TEXT'); }
  },
  {
    version: 18,
    name: 'indexes on frequently-queried FK/date columns',
    up() {
      // Every one of these is hit by daily queries (sales detail, reports,
      // client history, reorder). Without indexes SQLite does a full table
      // scan each time, which slows down once a shop has years of history.
      // "IF NOT EXISTS" makes the migration idempotent on restored DBs.
      const indexes = [
        ['idx_sale_items_sale', 'CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id)'],
        ['idx_sale_items_product', 'CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id)'],
        ['idx_sale_payments_sale', 'CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id)'],
        ['idx_stock_movements_product', 'CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id)'],
        ['idx_sales_client', 'CREATE INDEX IF NOT EXISTS idx_sales_client ON sales(client_id)'],
        ['idx_sales_created', 'CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)'],
        ['idx_points_client', 'CREATE INDEX IF NOT EXISTS idx_points_client ON points_transactions(client_id)'],
        ['idx_refunds_sale', 'CREATE INDEX IF NOT EXISTS idx_refunds_sale ON refunds(original_sale_id)'],
        ['idx_refunds_product', 'CREATE INDEX IF NOT EXISTS idx_refunds_product ON refunds(product_id)'],
        ['idx_po_items_po', 'CREATE INDEX IF NOT EXISTS idx_po_items_po ON purchase_order_items(po_id)'],
        ['idx_po_items_product', 'CREATE INDEX IF NOT EXISTS idx_po_items_product ON purchase_order_items(product_id)'],
        ['idx_invoice_items_invoice', 'CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)'],
        ['idx_debt_payments_debt', 'CREATE INDEX IF NOT EXISTS idx_debt_payments_debt ON debt_payments(debt_id)'],
        ['idx_debts_status', 'CREATE INDEX IF NOT EXISTS idx_debts_status ON debts(status)']
      ];
      for (const [name, sql] of indexes) {
        const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
        if (!existing) db.exec(sql);
      }
    }
  },
  {
    version: 19,
    name: 'rename default shop identity to "Mizan Suite"',
    up() {
      // The app is now branded "Mizan Suite". If the shop still uses the old
      // MIZAN default name (never customized), adopt the new brand. A shop that
      // deliberately renamed itself keeps its own name.
      const row = db.prepare("SELECT value FROM settings WHERE key = 'shop_name'").get();
      if (row && String(row.value).trim() === 'MIZAN') {
        db.prepare("UPDATE settings SET value = 'Mizan Suite' WHERE key = 'shop_name'").run();
      }
    }
  },
  {
    version: 20,
    name: 'audit_log (who did what, when)',
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL DEFAULT (datetime('now')),
          actor TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT '',
          action TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT ''
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at)`);
    }
  },
  {
    version: 21,
    name: 'staff & time tracking (users pay fields, time_entries, payroll_payments)',
    up() {
      ensureColumn('users', 'hourly_rate', 'REAL NOT NULL DEFAULT 0');
      ensureColumn('users', 'monthly_salary', 'REAL NOT NULL DEFAULT 0');
      ensureColumn('users', 'active', 'INTEGER NOT NULL DEFAULT 1');
      db.exec(`
        CREATE TABLE IF NOT EXISTS time_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          clock_in TEXT NOT NULL,
          clock_out TEXT,
          notes TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_time_user_in ON time_entries(user_id, clock_in)`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS payroll_payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          month TEXT NOT NULL,
          amount REAL NOT NULL,
          paid_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(user_id, month),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
    }
  },
  {
    version: 23,
    name: 'products.selling unit (piece vs kg) + sale_items.unit for scale sales',
    up() {
      // 'piece' = normal item sold by unit (default). 'kg' = sold by weight:
      // the quantity is a decimal weight in kilograms and sale_price is the
      // price per kilogram, so supermarkets can sell produce/meat on a scale.
      ensureColumn('products', 'unit', "TEXT NOT NULL DEFAULT 'piece'");
      ensureColumn('sale_items', 'unit', "TEXT NOT NULL DEFAULT 'piece'");
    }
  },
  {
    version: 22,
    name: 'worker profiles, pay adjustments & leave (staff_advances, leave_entries)',
    up() {
      ensureColumn('users', 'job_title', "TEXT NOT NULL DEFAULT ''");
      ensureColumn('users', 'phone', "TEXT NOT NULL DEFAULT ''");
      ensureColumn('users', 'hire_date', 'TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS staff_advances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          amount REAL NOT NULL,
          month TEXT NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_adv_month ON staff_advances(user_id, month)`);
      db.exec(`
        CREATE TABLE IF NOT EXISTS leave_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          leave_date TEXT NOT NULL,
          type TEXT NOT NULL,
          note TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_leave_date ON leave_entries(user_id, leave_date)`);
    }
  }
];

function runMigrations() {
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
  const applied = new Set(appliedRows.map(r => r.version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      m.up();
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      console.error(`[database] migration ${m.version} ("${m.name}") failed:`, err.message);
      throw err;
    }
  }
}

// ---------- BASE SCHEMA ----------
// All tables are created with "IF NOT EXISTS", so this is safe to run every
// startup. Column additions and data backfills are handled by the migrations
// above (applied only once, even on old databases).

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT UNIQUE,
    name TEXT NOT NULL,
    category TEXT,
    cost_price REAL NOT NULL DEFAULT 0,
    sale_price REAL NOT NULL DEFAULT 0,
    wholesale_price REAL NOT NULL DEFAULT 0,
    margin_type TEXT NOT NULL DEFAULT '',
    margin_value REAL NOT NULL DEFAULT 0,
    quantity INTEGER NOT NULL DEFAULT 0,
    min_stock INTEGER NOT NULL DEFAULT 5,
    max_stock INTEGER,
    expiry_date TEXT,
    supplier TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// A "sale" is one checkout/transaction (e.g. one customer's purchase).
db.exec(`
  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// A "sale_item" is one product line within a sale (a sale can have many products).
// We store the price AT THE TIME OF SALE, so if you change sale_price later,
// old receipts still show what the customer actually paid.
db.exec(`
  CREATE TABLE IF NOT EXISTS sale_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    price_at_sale REAL NOT NULL,
    cost_at_sale REAL NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )
`);

// Multi-barcode support: one product (e.g. "Swasli Shampoo") can have many
// barcodes (different colors/variants). The primary barcode stays in
// products.barcode; EVERY barcode (including the primary) is also listed here
// so that a single lookup resolves any scanned barcode to the same product.
db.exec(`
  CREATE TABLE IF NOT EXISTS product_barcodes (
    product_id INTEGER NOT NULL,
    barcode TEXT UNIQUE NOT NULL,
    PRIMARY KEY (product_id, barcode)
  )
`);

// stock_movements logs EVERY change to a product's quantity, whatever the reason.
// This gives us a full audit trail: "why is stock at 7 right now?" is always answerable.
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    type TEXT NOT NULL,
    quantity_change INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )
`);

// A supplier you buy products from.
db.exec(`
  CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    contact_person TEXT,
    phone TEXT,
    email TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// A purchase order: an order placed with a supplier, which may later be received or cancelled.
db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER,
    supplier_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    invoice_number TEXT,
    total_cost REAL NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    received_at TEXT,
    FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
  )
`);

// One product line within a purchase order.
db.exec(`
  CREATE TABLE IF NOT EXISTS purchase_order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity_ordered INTEGER NOT NULL,
    unit_cost REAL NOT NULL,
    FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  )
`);

// A simple key/value settings table. Currently used for the shop's starting budget,
// but general enough to hold future settings too.
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Shop expenses - rent, electricity, salaries, etc. Tracked separately from
// purchase orders (which are specifically for restocking inventory).
db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    amount REAL NOT NULL,
    description TEXT,
    expense_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// One sale can be paid with multiple methods (split payment): cash + card, etc.
db.exec(`
  CREATE TABLE IF NOT EXISTS sale_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id INTEGER NOT NULL,
    method TEXT NOT NULL,
    amount REAL NOT NULL,
    FOREIGN KEY (sale_id) REFERENCES sales(id)
  )
`);

// A "held" sale: a cart parked mid-checkout so the cashier can serve someone else
// and come back to it later. Stored as the raw cart JSON, not committed as a real sale.
db.exec(`
  CREATE TABLE IF NOT EXISTS held_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cart_json TEXT NOT NULL,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// A refund against a completed sale - full or partial. Restocks the product and
// is subtracted from profit/income in reports.
db.exec(`
  CREATE TABLE IF NOT EXISTS refunds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_sale_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    refund_amount REAL NOT NULL,
    refunded_cost REAL NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (original_sale_id) REFERENCES sales(id)
  )
`);

// ---------- CLIENTS & LOYALTY ----------

// A client/loyalty customer. Points are earned on purchases and can be redeemed
// as a discount at checkout. "Deleting" a client is a soft delete (active = 0)
// because past sales keep pointing to them and that history must stay intact.
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Every points change for a client: earned on a sale, redeemed at checkout,
// or manually adjusted by the owner (type 'adjustment', amount may be +/-).
// A client's current balance is derived from this log, never stored separately,
// so it can't drift out of sync.
db.exec(`
  CREATE TABLE IF NOT EXISTS points_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    sale_id INTEGER,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )
`);

// ---------- DEBTS ----------

// A debt is money owed either TO a supplier (we received goods/credit, must pay
// them - a "payable") or TO us BY a client (customer took goods on credit, must
// pay us - a "receivable"). Debts can be created automatically from a purchase
// order placed on credit or a sale paid with the 'credit' method, or manually
// from this page (e.g. a running balance). Payments are tracked separately.
db.exec(`
  CREATE TABLE IF NOT EXISTS debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_type TEXT NOT NULL,
    party_id INTEGER,
    party_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT,
    source_id INTEGER,
    original_amount REAL NOT NULL,
    amount_paid REAL NOT NULL DEFAULT 0,
    due_date TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// One payment against a debt (partial or full). The running "remaining balance"
// is always derived as original_amount - SUM(amount), so it can't drift.
db.exec(`
  CREATE TABLE IF NOT EXISTS debt_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    debt_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    payment_date TEXT NOT NULL,
    method TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (debt_id) REFERENCES debts(id)
  )
`);

// ---------- ACCOUNTS ----------

// App accounts. Two roles:
//   owner   - full access to every page and every setting.
//   cashier - only the Cashier, Refunds, Clients and Facturation (billing) pages.
// Every account logs in with its name + PIN. The owner account is created when
// the app first detects an old single-PIN (owner_pin_hash) setting, so existing
// shops keep working; on a brand-new install the first account is created from
// Settings -> Accounts (the app starts in "setup mode" with no accounts).
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'cashier',
    permissions TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ---------- FACTURATION (BILLING) ----------

// An invoice/bill ("facture") - a formal, printable statement for a customer.
// Unlike a sale it does not touch stock or the cash register: it's purely a
// billing document. Can be created from the Facturation page by either role.
db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_number TEXT NOT NULL UNIQUE,
    client_id INTEGER,
    client_name TEXT,
    client_phone TEXT,
    subtotal REAL NOT NULL DEFAULT 0,
    discount_type TEXT,
    discount_value REAL NOT NULL DEFAULT 0,
    discount_amount REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id)
  )
`);

// One product line within an invoice.
db.exec(`
  CREATE TABLE IF NOT EXISTS invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    product_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    unit_price REAL NOT NULL,
    FOREIGN KEY (invoice_id) REFERENCES invoices(id)
  )
`);

// Apply pending migrations (must run after the base schema exists).
runMigrations();

// Restore the database from a backup file: close the live connection, replace
// the file, reopen, then re-apply migrations so the restored copy is upgraded
// to the current schema. The swap is done via a temp file + rename so a crash
// mid-copy never leaves a half-written live database. Returns nothing, throws.
function restore(backupPath) {
  // Validate backupPath is a real SQLite file before we swap anything
  try {
    const probe = new (require('node:sqlite').DatabaseSync)(backupPath, { readOnly: true });
    probe.prepare('SELECT 1').get();
    probe.close();
  } catch (err) {
    throw new Error('Backup file is not a valid database');
  }

  db.close();
  const tmpPath = DB_PATH + '.restore-tmp';
  // Clean up any existing tmpPath before starting to avoid conflicts.
  // A leftover .restore-tmp file could indicate a previous failed restore,
  // which would cause VACUUM INTO to overwrite it (acceptable).
  // However, we want to ensure we start fresh each time, so delete if it exists.
  if (fs.existsSync(tmpPath)) {
    try { fs.unlinkSync(tmpPath); } catch (e) {}
  }
  // Use SQLite's VACUUM INTO for atomic consistency, like createBackup does.
  // This copies the backup file to tmpPath in a single, consistent operation,
  // eliminating the race condition of fs.copyFileSync where the source could
  // be mid-write and we'd capture a partial file.
  try {
    const target = tmpPath.replace(/'/g, "''");
    const stmt = `VACUUM INTO '${target}'`;
    const probe2 = new (require('node:sqlite').DatabaseSync)(backupPath, { readOnly: true });
    probe2.exec(stmt);
    probe2.close();
  } catch (err) {
    // If VACUUM INTO fails, ensure we clean up and rethrow.
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) {}
    }
    throw err;
  }
  fs.renameSync(tmpPath, DB_PATH); // atomic rename on the same volume (Windows + POSIX)
  db = new DatabaseSync(DB_PATH);
  runMigrations();
}

module.exports = {
  prepare(sql) { return db.prepare(sql); },
  exec(sql) { return db.exec(sql); },
  get path() { return DB_PATH; },
  restore
};
