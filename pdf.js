// PDF invoice support: extract the line-item table from a PDF.
//
// Strategy:
//   1. If the PDF has a real text layer, read words (with positions) via MuPDF
//      and rebuild the table with the same column reconstruction used for OCR.
//   2. If there is no usable text (scanned/photographed PDF), render each page
//      to a PNG and run the normal OCR pipeline on it.
const path = require('path');

let mupdfPromise = null;
function getMupdf() {
  if (!mupdfPromise) mupdfPromise = import('mupdf');
  return mupdfPromise;
}

// Read every word from a PDF page. MuPDF's text walker reports one char at a
// time, so we group consecutive chars into words using the same gap heuristic
// that a word would have in printed text (a char is a new word when the gap to
// the previous char is larger than ~half the font size, or on a space).
function wordsFromChars(chars, lineBbox) {
  const words = [];
  let cur = null;
  const [, y0, , y1] = lineBbox;
  const size = chars[0] ? chars[0].size : 10;
  for (const ch of chars) {
    if (ch.c.trim() === '') {
      if (cur) { words.push(cur); cur = null; }
      continue;
    }
    if (cur && (ch.x - cur.lastX) > size * 0.55) {
      words.push(cur);
      cur = null;
    }
    if (!cur) {
      cur = { text: ch.c, x0: ch.x, x1: ch.x + size * 0.6, y0, y1, lastX: ch.x + size * 0.6 };
    } else {
      cur.text += ch.c;
      cur.x1 = ch.x + size * 0.6;
      cur.lastX = ch.x + size * 0.6;
    }
  }
  if (cur) words.push(cur);
  return words.map(({ lastX, ...w }) => w);
}

async function extractTextWords(doc) {
  const m = await getMupdf();
  const words = [];
  const pages = doc.countPages();
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    try {
      const st = page.toStructuredText();
      const lines = [];
      st.walk({
        beginLine(bbox) { lines.push({ bbox, chars: [] }); },
        onChar(c, origin, font, size) { if (lines.length) lines[lines.length - 1].chars.push({ c, x: origin.x, y: origin.y, size }); },
        endLine() {}
      });
      for (const ln of lines) {
        if (!ln.chars.length) continue;
        words.push(...wordsFromChars(ln.chars, ln.bbox));
      }
      st.destroy();
    } finally {
      page.destroy();
    }
  }
  return words;
}

// Render every page of a scanned PDF to a PNG buffer so the OCR pipeline can
// read it. ~2x zoom gives a good balance of accuracy and memory for A4 pages.
async function renderPages(doc) {
  const m = await getMupdf();
  const pngs = [];
  const pages = doc.countPages();
  for (let i = 0; i < pages; i++) {
    const page = doc.loadPage(i);
    try {
      const pix = page.toPixmap(m.Matrix.scale(2, 2), m.ColorSpace.DeviceRGB);
      pngs.push(pix.asPNG());
      pix.destroy();
    } finally {
      page.destroy();
    }
  }
  return pngs;
}

// Parse a PDF into { headers, rows } (rows are string arrays, matching the
// shape the rest of the import pipeline expects).
async function pdfToTable(buffer) {
  const m = await getMupdf();
  const doc = m.Document.openDocument(buffer, 'application/pdf');
  try {
    // Cap the number of pages: a scanned multi-hundred-page PDF would otherwise
    // render + OCR every page and exhaust memory. Real invoices are 1-3 pages.
    const pageCount = doc.countPages();
    if (pageCount > 40) {
      throw new Error(`PDF has too many pages (${pageCount}) - import only the invoice page`);
    }
    // 1) Text layer first.
    const words = await extractTextWords(doc);
    if (words.length >= 8) {
      try {
        const { tableFromWords } = require('./ocr');
        return tableFromWords(words);
      } catch (e) {
        // fall through to OCR on the rendered pages
      }
    }
    // 2) Scanned: OCR each rendered page and merge.
    const pngs = await renderPages(doc);
    const { ocrImageToTable } = require('./ocr');
    let headers = null;
    let rows = [];
    for (const png of pngs) {
      const table = await ocrImageToTable(png);
      if (!headers) headers = table.headers;
      rows = rows.concat(table.rows);
    }
    if (!headers) throw new Error('No readable content found in the PDF');
    return { headers, rows };
  } finally {
    try { doc.destroy(); } catch (e) {}
  }
}

async function shutdownPdf() {
  mupdfPromise = null;
}

module.exports = { pdfToTable, shutdownPdf };
