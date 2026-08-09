// Validates the Arabic translations cover every EN key, then inserts the ar
// dict into public/i18n.js right after the fr block.
const fs = require('fs');
const path = require('path');
const ar = require('./ar-translations');

const file = path.join(__dirname, '..', 'public', 'i18n.js');
const src = fs.readFileSync(file, 'utf8');

// Extract EN keys.
const enStart = src.indexOf('en: {') + 5;
const frStart = src.indexOf('fr: {');
const enBlock = src.slice(enStart, frStart);
const re = /'([^']+)':\s*'/g;
const enKeys = new Set();
let m;
while ((m = re.exec(enBlock))) enKeys.add(m[1]);

const arKeys = Object.keys(ar);
const missing = [...enKeys].filter(k => !arKeys.includes(k));
const extra = arKeys.filter(k => !enKeys.has(k));

console.log('EN keys:', enKeys.size);
console.log('AR keys:', arKeys.length);
if (missing.length) {
  console.error('MISSING AR KEYS (' + missing.length + '):');
  console.error(missing.join('\n'));
}
if (extra.length) {
  console.error('EXTRA AR KEYS (' + extra.length + '):');
  console.error(extra.join('\n'));
}
if (missing.length || extra.length) process.exit(1);
console.log('Key coverage OK');

// Build the ar block as a JS object literal, preserving key order of the EN dict.
// We output keys in EN order so the block reads naturally.
const arBlockLines = [];
arBlockLines.push('    ar: {');
arBlockLines.push('      // ---------- Arabic translation ----------');
[...enKeys].forEach((key, i) => {
  const val = ar[key];
  // Escape single quotes and backslashes for a single-quoted JS string.
  const esc = String(val).replace(/\\/g, '\\\\').replace(/'/g, '\\\'');
  arBlockLines.push(`      '${key}': '${esc}'${i === enKeys.size - 1 ? '' : ','}`);
});
arBlockLines.push('    }');

// Insert after the fr block. The fr block ends with "    }," immediately
// before "  };" (dict close). We insert the ar block right after that line.
const frEndMarker = '\n  };';
const frCloseIdx = src.indexOf(frEndMarker);
if (frCloseIdx === -1) throw new Error('could not find dict close marker');
const frCloseLineIdx = src.lastIndexOf('\n    },', frCloseIdx);
if (frCloseLineIdx === -1) throw new Error('could not find fr block close');
const insertAt = frCloseLineIdx + '\n    },'.length;
const newSrc = src.slice(0, insertAt) + '\n' + arBlockLines.join('\n') + src.slice(insertAt);

fs.writeFileSync(file, newSrc);
console.log('Inserted ar dict into', file);
