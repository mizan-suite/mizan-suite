// license-tools/check-i18n.js
// Scans all HTML/JS files for every i18n key used, then reports which keys are
// MISSING from the French dictionary (those would render in English).
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const files = fs.readdirSync(PUBLIC).filter(f => /\.(html|js)$/.test(f) && f !== 'i18n.js');

// Extract keys from I18N.t('key') calls and data-i18n="key" attributes.
const used = new Set();
const byFile = {};
for (const f of files) {
  const src = fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  const found = new Set();
  const tRe = /I18N\.t\('([^']+)'\)/g;
  let m;
  while ((m = tRe.exec(src))) found.add(m[1]);
  const tRe2 = /I18N\.t\("([^"]+)"\)/g;
  while ((m = tRe2.exec(src))) found.add(m[1]);
  const attrRe = /data-i18n="([^"]+)"/g;
  while ((m = attrRe.exec(src))) found.add(m[1]);
  // I18N.t with concatenation handled above; also catch template usage I18N.t(`...`)
  const tRe3 = /I18N\.t\(`([^`]+)`\)/g;
  while ((m = tRe3.exec(src))) found.add(m[1]);
  for (const k of found) { used.add(k); (byFile[k] = byFile[k] || []).push(f); }
}

// Load the i18n dictionaries.
const i18nSrc = fs.readFileSync(path.join(PUBLIC, 'i18n.js'), 'utf8');
const enBlock = i18nSrc.match(/en:\s*\{(.*?)\n\s*\},\n\s*fr:/s);
const frBlock = i18nSrc.match(/fr:\s*\{(.*?)\n\s*\}\s*\n/s);
if (!enBlock || !frBlock) { console.error('could not parse i18n.js blocks'); process.exit(1); }

function keysOf(block) {
  const keys = new Set();
  const re = /^\s*'([^']+)':/gm;
  let m;
  while ((m = re.exec(block))) keys.add(m[1]);
  return keys;
}
const enKeys = keysOf(enBlock[1]);
const frKeys = keysOf(frBlock[1]);

const missingFr = [...used].filter(k => !frKeys.has(k)).sort();
const missingEn = [...used].filter(k => !enKeys.has(k)).sort();

console.log('Used keys total:', used.size);
console.log('Missing from EN:', missingEn.length);
if (missingEn.length) missingEn.forEach(k => console.log('  EN MISSING:', k, '(used in ' + byFile[k].join(', ') + ')'));

console.log('\n=== KEYS MISSING FROM FRENCH (render in English in FR mode) ===');
if (!missingFr.length) console.log('NONE - all used keys exist in French.');
missingFr.forEach(k => console.log('  ' + k + '  <- ' + byFile[k].join(', ')));

// Also list keys present in EN dict but absent in FR dict (even if unused now).
const enOnly = [...enKeys].filter(k => !frKeys.has(k)).sort();
console.log('\n=== EN dict keys that have NO French entry (' + enOnly.length + ') ===');
enOnly.forEach(k => console.log('  ' + k));
