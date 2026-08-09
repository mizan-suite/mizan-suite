# Mizan Suite

Pharmacy management software for Windows. Sales, inventory, barcode scanning,
invoices, loyalty points and reporting - all in one app that runs on your own
computer with no cloud subscription.

## Download

Get the free trial at the [landing page](https://mizansuite.com) or from
[GitHub Releases](https://github.com/YOUR_USERNAME/mizan-suite/releases).

## Features

- Fast checkout with barcode scanning (webcam or USB scanner)
- Smart inventory with expiry dates and reorder alerts
- Customer loyalty points and rewards
- Sales, daily and monthly reports
- Invoices, refunds, debts and purchasing
- Import products and supplier invoices from Excel
- Works fully offline - your data stays on your PC
- Multilingual: English, French, Arabic

## Free trial

14-day, one key per computer. The activation screen in the app has a
**Start free trial** button.

## Development

```powershell
npm install
npm test          # 105 tests
npm run dist      # build the Windows installer
```

## Repository structure

| Path | Purpose |
|---|---|
| `electron/` | Electron desktop shell, license gate, activation screen |
| `public/` | The web app (dashboard, sales, inventory, settings...) |
| `server.js` | Local Express server + API |
| `database.js` | SQLite schema + migrations |
| `license-tools/` | License key generator (master keys - never shared) |
| `trial/` | Public landing page + trial signup server + PC-side signer |
| `test/` | Automated tests |

## Contact

mizansuite@gmail.com

&copy; 2026 Mizan Suite. All rights reserved.
