// OCR invoice support: turn a photo of a supplier invoice into a header/rows
// table so the normal import flow (column mapping + review) can reuse it.
const path = require('path');
const { createWorker } = require('tesseract.js');

const LANGS = 'fra+eng';
const LANGS_DIR = path.join(__dirname, 'ocr', 'traineddata');

const HEADER_LABELS = {
  barcode: 'Code barre',
  name: 'Designation',
  category: 'Famille',
  quantity: 'Qte',
  cost_price: 'Prix achat HT',
  wholesale_price: 'Prix de gros',
  sale_price: 'Prix vente',
  expiry_date: 'Date peremption',
  supplier: 'Fournisseur'
};

const KEYWORDS = {
  barcode: ['code barre', 'codebarre', 'barcode', 'ean', 'upc', 'code article', 'code produit', 'reference', 'reference', 'sku', 'code'],
  name: ['designation', 'designation article', 'produit', 'article', 'description', 'name', 'nom', 'libelle', 'label', 'item'],
  category: ['famille', 'categorie', 'category', 'cat'],
  quantity: ['quantite', 'quantity', 'qty', 'qte', 'qt', 'nbre', 'nombre', 'stock'],
  cost_price: ['prix achat', 'prixachat', 'prix de revient', 'cout', 'achat', 'cost'],
  wholesale_price: ['prix de gros', 'prix gros', 'wholesale', 'gros'],
  sale_price: ['prix de vente', 'prix vente', 'prixvente', 'prix public', 'prix de detail', 'prix', 'vente', 'price', 'selling'],
  expiry_date: ['peremption', 'expiration', 'expiry', 'dluo', 'dlc', 'exp'],
  supplier: ['fournisseur', 'supplier']
};

function normText(s) {
  return String(s || '').toLowerCase()
    .replace(/['’]/g, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function cleanCell(s) {
  return String(s || '').replace(/[|;=~_]{1,}/g, ' ').replace(/\s+/g, ' ').trim();
}

function isNumeric(s) { return /^-?[\d.,\s\u00a0]+$/.test(s.trim()) && s.trim() !== '' && !isNaN(parseFloat(s.replace(/[\s\u00a0]/g, '').replace(',', '.'))); }
function isInteger(s) { return /^-?\d+$/.test(s.trim()); }
function isDecimal(s) { return isNumeric(s) && !isInteger(s); }
function isDateLike(s) { return /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(s.trim()); }
function isBarcodeLike(s) { return /^\d{8,14}$/.test(s.trim()); }

function wordScore(w) {
  const norm = normText(w.text);
  let best = 0;
  for (const field of Object.keys(KEYWORDS)) {
    for (const k of KEYWORDS[field]) {
      if (norm === k) best = Math.max(best, 2);
      else if (k.length >= 4 && norm.includes(k)) best = Math.max(best, 1);
    }
  }
  return best;
}

function collectWords(data) {
  const words = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const w of line.words || []) {
          const text = String(w.text || '').trim();
          if (!text) continue;
          if (w.confidence < 30) continue;
          words.push({ text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 });
        }
      }
    }
  }
  return words;
}

function clusterLines(words) {
  const sorted = words.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2;
    let placed = false;
    for (const ln of lines) {
      const h = ln.y1 - ln.y0;
      if (cy >= ln.y0 - h * 0.35 && cy <= ln.y1 + h * 0.35) {
        ln.words.push(w);
        ln.y0 = Math.min(ln.y0, w.y0);
        ln.y1 = Math.max(ln.y1, w.y1);
        placed = true;
        break;
      }
    }
    if (!placed) lines.push({ y0: w.y0, y1: w.y1, words: [w] });
  }
  lines.forEach(l => l.words.sort((a, b) => a.x0 - b.x0));
  return lines;
}

function inferField(cells, decimalIdx, isWidestText) {
  const sample = cells.filter(c => c !== '');
  if (!sample.length) return null;
  if (sample.every(isDateLike)) return 'expiry_date';
  if (sample.every(isBarcodeLike)) return 'barcode';
  if (sample.every(isInteger)) return 'quantity';
  if (sample.every(isDecimal)) {
    const order = ['cost_price', 'wholesale_price', 'sale_price'];
    return order[decimalIdx] || 'sale_price';
  }
  if (sample.every(isNumeric)) return decimalIdx === 0 ? 'cost_price' : 'sale_price';
  if (isWidestText) return 'name';
  return 'category';
}

function tableFromWords(words) {
  if (words.length < 8) throw new Error('No readable text found - try a clearer document');

  const lines = clusterLines(words);
  lines.forEach(l => { l.score = l.words.reduce((s, w) => s + wordScore(w), 0); });

  // Header = one or more consecutive top lines that contain header keywords.
  let headerStart = -1, headerEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].score >= 3) {
      if (headerStart === -1) headerStart = i;
      headerEnd = i + 1;
      if (headerEnd - headerStart > 2) break;
    } else if (headerStart !== -1) break;
  }
  const hasHeader = headerStart >= 0;

  const headerWords = hasHeader ? lines.slice(headerStart, headerEnd).flatMap(l => l.words) : [];
  const dataLines = hasHeader ? lines.filter((_, i) => i < headerStart || i >= headerEnd) : lines;
  const dataWords = dataLines.flatMap(l => l.words);

  // Build column layout from the DATA rows' word x-positions (more reliable
  // than the header, which may wrap or be partially misread).
  const xs = dataWords.map(w => w.x0).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < xs.length; i++) gaps.push(xs[i] - xs[i - 1]);
  gaps.sort((a, b) => a - b);
  const baseGap = gaps.length ? gaps[Math.floor(gaps.length * 0.8)] : 0;

  let colGroups = null;
  for (const mult of [1.2, 1.6, 2.2, 3.2, 4.5]) {
    const threshold = Math.max(22, baseGap * mult);
    const spans = [];
    let cur = null;
    for (const x of xs) {
      if (!cur) cur = { x0: x, x1: x };
      else if (x - cur.x1 <= threshold) cur.x1 = x;
      else { spans.push({ x0: cur.x0, x1: cur.x1 }); cur = { x0: x, x1: x }; }
    }
    if (cur) spans.push({ x0: cur.x0, x1: cur.x1 });
    colGroups = spans.map(s => ({ minX: s.x0, maxX: s.x1, center: (s.x0 + s.x1) / 2, words: [] }));
    if (colGroups.length <= 14) break;
  }

  // Attach header words to the nearest column so they can name the columns.
  for (const w of headerWords) {
    let best = 0, bestD = Infinity;
    const cx = (w.x0 + w.x1) / 2;
    colGroups.forEach((g, i) => {
      const d = Math.abs(cx - g.center);
      if (d < bestD) { bestD = d; best = i; }
    });
    colGroups[best].words.push(w);
  }

  const assign = (x) => {
    let best = 0, bestD = Infinity;
    colGroups.forEach((g, i) => {
      const d = Math.abs(x - g.center);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };

  let rows = [];
  for (let i = 0; i < lines.length; i++) {
    if (hasHeader && i >= headerStart && i < headerEnd) continue;
    const cells = colGroups.map(() => []);
    for (const w of lines[i].words) cells[assign((w.x0 + w.x1) / 2)].push(w.text);
    rows.push(cells.map(a => cleanCell(a.join(' '))));
  }

  // Merge adjacent TEXT columns: a wide product name often splits across
  // several narrow x-clusters (e.g. one per word). Collapse them into one.
  const textness = colGroups.map((g, i) => {
    const vals = rows.map(r => r[i] || '').filter(v => v !== '');
    if (!vals.length) return 0;
    return vals.filter(v => !isNumeric(v) && !isDateLike(v)).length / vals.length;
  });
  const newGroups = [];
  const ranges = [];
  let k = 0;
  while (k < colGroups.length) {
    let j = k;
    while (j + 1 < colGroups.length && textness[k] >= 0.5 && textness[j + 1] >= 0.5) j++;
    const range = [];
    for (let t = k; t <= j; t++) range.push(t);
    const group = {
      minX: colGroups[range[0]].minX,
      maxX: colGroups[range[range.length - 1]].maxX,
      words: range.flatMap(t => colGroups[t].words)
    };
    group.center = (group.minX + group.maxX) / 2;
    newGroups.push(group);
    ranges.push(range);
    k = j + 1;
  }
  colGroups = newGroups;
  rows = rows.map(r => ranges.map(rt => cleanCell(rt.map(t => r[t] || '').join(' '))));

  // Merge wrapped continuation lines (product name split across rows).
  const merged = [];
  for (const r of rows) {
    const hasNumber = r.some(c => isNumeric(c) || isDateLike(c));
    if (!hasNumber && merged.length) {
      const prev = merged[merged.length - 1];
      const prevHasNumber = prev.some(c => isNumeric(c) || isDateLike(c));
      if (prevHasNumber) {
        const nameIdx = prev.findIndex(c => !isNumeric(c) && !isDateLike(c) && c !== '');
        const rIdx = r.findIndex(c => c !== '');
        if (nameIdx >= 0 && rIdx >= 0) {
          prev[nameIdx] = cleanCell(prev[nameIdx] + ' ' + r[rIdx]);
          continue;
        }
      }
    }
    merged.push(r);
  }

  const keptRows = merged
    .filter(r => r.some(c => isNumeric(c) || isDateLike(c) || isBarcodeLike(c)))
    .filter(r => !/^(total|tva|remise|net a payer|net apayer|arrhes|acompte|report|prix|montant)/i.test(normText(r.join(' '))));
  if (!keptRows.length) throw new Error('No product rows recognized in the image - try a clearer photo');

  // Drop fully-empty leading/trailing columns (based on the kept rows).
  const nCols = colGroups.length;
  let firstCol = 0, lastCol = nCols - 1;
  while (firstCol < nCols && keptRows.every(r => (r[firstCol] || '').trim() === '')) firstCol++;
  while (lastCol >= firstCol && keptRows.every(r => (r[lastCol] || '').trim() === '')) lastCol--;
  const keepIdx = colGroups.map((_, i) => i >= firstCol && i <= lastCol);

  // Name columns: known header text first, then infer from content.
  const headerNames = colGroups.map((g, i) => {
    if (g.words.length) {
      const joined = cleanCell(g.words.map(w => w.text).join(' '));
      const norm = normText(joined);
      for (const field of Object.keys(KEYWORDS)) {
        if (KEYWORDS[field].some(k => norm === k || (k.length >= 5 && norm.includes(k)))) {
          return HEADER_LABELS[field];
        }
      }
      return joined || null;
    }
    return null;
  });

  const textCols = colGroups
    .map((g, i) => ({ i, w: g.maxX - g.minX }))
    .filter(({ i }) => !headerNames[i])
    .sort((a, b) => b.w - a.w);
  const widestIdx = textCols.length ? textCols[0].i : -1;

  let decimalIdx = 0;
  for (let i = 0; i < headerNames.length; i++) {
    if (headerNames[i]) continue;
    const cells = keptRows.map(r => (r[i] !== undefined ? r[i] : ''));
    const field = inferField(cells, decimalIdx, i === widestIdx);
    headerNames[i] = HEADER_LABELS[field] || 'Colonne ' + (i + 1);
    if (field === 'cost_price' || field === 'wholesale_price' || field === 'sale_price') decimalIdx++;
  }

  const finalHeaders = headerNames.filter((_, i) => keepIdx[i]);
  const finalRows = keptRows.map(r => r.filter((_, i) => keepIdx[i]));

  return { headers: finalHeaders, rows: finalRows };
}

function dataToTable(data) {
  return tableFromWords(collectWords(data));
}

let queue = Promise.resolve();
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker(LANGS, 1, { langPath: LANGS_DIR });
  }
  return workerPromise;
}

function ocrImageToTable(buffer) {
  const run = async () => {
    const worker = await getWorker();
    const { data } = await worker.recognize(buffer, {}, { blocks: true });
    return dataToTable(data);
  };
  const task = queue.then(run);
  queue = task.catch(() => {});
  return task;
}

async function shutdownOcr() {
  if (workerPromise) {
    try { await (await workerPromise).terminate(); } catch (e) {}
    workerPromise = null;
  }
}

module.exports = { ocrImageToTable, tableFromWords, shutdownOcr };
