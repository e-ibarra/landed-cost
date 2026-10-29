// Shareable state in the URL hash, and CSV export. No DOM here so it is testable.
import { INCOTERMS, PRESETS, STAGES } from './calc.js';

const NUMERIC = /^-?\d{0,12}(?:[.,]\d{0,6})?$/;
const clean = (v) => (typeof v === 'string' && NUMERIC.test(v.trim()) ? v.trim() : '');

/** Compact, human-readable query string: p=10000&i=FOB&c.freight=1800... */
export function encodeState(s) {
  const q = new URLSearchParams();
  const put = (k, v) => { if (v !== '' && v !== undefined && v !== null) q.set(k, String(v)); };
  put('p', s.price); put('q', s.quantity); put('i', s.incoterm);
  for (const k of STAGES) put('c.' + k, s.costs?.[k]);
  put('im', s.insMode ? 1 : 0); put('ir', s.insRate);
  put('ps', s.preset); put('v', s.valuation);
  for (const [k, v] of Object.entries(s.rates || {})) put('r.' + k, v);
  put('ct', s.creditTaxes ? 1 : 0); put('fx', s.fx); put('m', s.margin); put('e', s.explorer);
  return q.toString();
}

/**
 * Parse a hash produced by encodeState. Anything unknown or malformed falls
 * back to the defaults, so a hand-edited or truncated link never breaks the page.
 * @returns {Object|null} null when the hash is empty
 */
export function decodeState(hash, defaults) {
  if (!hash) return null;
  let q;
  try { q = new URLSearchParams(hash); } catch { return null; }
  if (![...q.keys()].length) return null;
  const s = structuredClone(defaults);
  const num = (k, target, key) => { if (q.has(k)) { const v = clean(q.get(k)); if (v !== '' || q.get(k) === '') target[key] = v; } };
  num('p', s, 'price'); num('q', s, 'quantity'); num('ir', s, 'insRate'); num('fx', s, 'fx'); num('m', s, 'margin');
  if (INCOTERMS[q.get('i')]) s.incoterm = q.get('i');
  if (INCOTERMS[q.get('e')]) s.explorer = q.get('e'); else s.explorer = s.incoterm;
  for (const k of STAGES) num('c.' + k, s.costs, k);
  if (q.has('im')) s.insMode = q.get('im') === '1';
  if (q.has('ct')) s.creditTaxes = q.get('ct') === '1';
  const preset = q.get('ps');
  if (preset && (PRESETS[preset] || preset === 'custom')) {
    s.preset = preset;
    const base = PRESETS[preset] || PRESETS.ar;
    s.rates = Object.fromEntries(base.taxes.map((t) => [t.id, String(t.rate)]));
  }
  for (const id of Object.keys(s.rates)) num('r.' + id, s.rates, id);
  if (q.get('v') === 'CIF' || q.get('v') === 'FOB') s.valuation = q.get('v');
  return s;
}

const csvCell = (v, sep) => {
  const s = String(v ?? '');
  return (s.includes(sep) || /["\r\n]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/**
 * Spreadsheet-friendly export. Spanish uses ';' as separator and ',' decimals
 * so Excel opens it correctly with an Argentine locale.
 */
export function toCsv(r, text, lang) {
  const sep = lang === 'es' ? ';' : ',';
  const n = (x) => (lang === 'es' ? String(x).replace('.', ',') : String(x));
  const rows = [[text.title, 'USD'], []];
  rows.push(['Incoterm', r.incoterm]);
  rows.push([text.quantity, r.quantity]);
  rows.push([]);
  for (const l of r.lines) {
    const name = l.id === 'goods' ? text.groups.goods : text.stages[l.id];
    rows.push([name, n(l.amount), l.included ? text.included : text.youPay]);
  }
  rows.push([]);
  rows.push([text.fobValue, n(r.fob)]);
  rows.push([text.customsValue, n(r.customsValue)]);
  for (const t of r.taxLines) {
    rows.push([text.taxNames[t.id], n(t.amount), `${n(t.rate)}%`, t.recoverable ? text.recoverable : '']);
  }
  rows.push([]);
  rows.push([text.landed, n(r.landedCost)]);
  rows.push([`${text.landed} (${text.perUnit})`, n(r.perUnit)]);
  rows.push([text.cashOut, n(r.cashOut)]);
  if (r.suggestedUnitPrice !== null) rows.push([text.suggested, n(r.suggestedUnitPrice)]);
  return rows.map((row) => row.map((c) => csvCell(c, sep)).join(sep)).join('\r\n') + '\r\n';
}
