// scale.js - weighing-scale support for supermarket-style sales.
// Loaded in the cashier as window.akScale and also required() by node tests.
//
// Two distinct jobs:
//   1. parseScaleBarcode() - reads the barcode a label-printing scale puts on
//      the pack (PLU + weight/price encoded in an EAN-13), so scanning the
//      label adds the right product at the right weight/price.
//   2. parseWeightLine() - reads the ASCII output of a scale connected over
//      serial/USB (CAS, Toledo, Dini Argeo, etc.), so the cashier can weigh an
//      item and have the kg amount typed in by the scale itself.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.akScale = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Scale-label barcode parsing
  // ---------------------------------------------------------------------------
  // Price-embedded EAN-13 labels (the common commercial format): the last five
  // digits before the check digit encode the item price, and the digits before
  // those are the PLU (the product's barcode, so we can look it up). A leading
  // prefix digit (usually '2' for "variable measure / price embedded") marks
  // the code as a scale label rather than a normal shop barcode. Both the
  // prefix and how many price digits are used are configurable via Settings,
  // because cheaper scales let the owner pick their own layout.

  function parseScaleBarcode(code, opts) {
    opts = opts || {};
    const str = String(code == null ? '' : code).trim();
    if (!/^\d{13}$/.test(str)) return null; // scale price labels are EAN-13 only
    const prefix = opts.prefix || '2';
    const priceDigits = parseInt(opts.priceDigits, 10) || 5;
    if (str[0] !== prefix[0]) return null;

    const digits = str.split('').map(Number);
    const checkDigit = digits.pop();
    const sum = digits.reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 1 : 3), 0);
    const computed = (10 - (sum % 10)) % 10;
    if (computed !== checkDigit) return null; // not a valid EAN-13

    const beforeCheck = str.slice(0, 12);
    const priceStr = beforeCheck.slice(12 - priceDigits);
    const plu = beforeCheck.slice(1, 12 - priceDigits);
    const priceNum = Number(priceStr);
    if (!Number.isFinite(priceNum) || priceNum <= 0) return null;

    const divisor = Number(opts.priceDivisor) || 100;
    return {
      kind: opts.mode === 'plu' ? 'plu' : 'price',
      plu: plu,
      price: Math.round(priceNum / divisor * 100) / 100, // DA (2 decimals)
      raw: str
    };
  }

  // ---------------------------------------------------------------------------
  // Serial/scale weight parsing
  // ---------------------------------------------------------------------------
  // Scales behave differently; the one thing they share is that the useful
  // number is a decimal followed by a mass unit. We scan each chunk for a
  // plausible "value unit" pair, ignore status words (ST, GS, kg on its own),
  // and return the mass in kilograms or null when nothing usable was seen.
  //   "0.500 kg"            -> 0.5
  //   "ST,GS,+000.600kg"    -> 0.6  (leading zeros + plus sign handled)
  //   "1.250 kg\r\n"        -> 1.25
  //   "S 12.5lb"            -> 5.67 (converted to kg)
  //   "UNSTABLE"            -> null (wait for a stable reading)

  const UNIT_TO_KG = { kg: 1, g: 0.001, lb: 0.45359237, oz: 0.0283495231 };

  function parseWeightLine(line) {
    const text = String(line == null ? '' : line).replace(/[\u0000-\u001f]+/g, ' ').trim();
    if (!text) return null;
    const m = text.match(/(-?\d+[.,]\d+|-?\d+)\s*(kg|g|lb|oz)\b/i);
    if (!m) return null;
    const value = Number(m[1].replace(',', '.'));
    if (!Number.isFinite(value) || value < 0) return null;
    const unit = m[2].toLowerCase();
    const kg = Math.round(value * UNIT_TO_KG[unit] * 1000) / 1000;
    // A hair under zero after rounding (e.g. -0.0004) is just an empty scale.
    if (kg < 0) return null;
    return kg;
  }

  return {
    parseScaleBarcode: parseScaleBarcode,
    parseWeightLine: parseWeightLine
  };
}));