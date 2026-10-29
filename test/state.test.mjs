import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeState, decodeState, toCsv } from '../js/state.js';
import { computeLandedCost, PRESETS } from '../js/calc.js';
import { STRINGS, pickLanguage } from '../js/i18n.js';

const defaults = () => ({
  price: '10000', quantity: '500', incoterm: 'FOB',
  costs: { originInland: '', exportClearance: '', originHandling: '', freight: '1800', insurance: '', destHandling: '450', importClearance: '650', destInland: '350' },
  insMode: true, insRate: '0.3', preset: 'ar', valuation: 'CIF',
  rates: { duty: '18', statistics: '3', vat: '21', vatPerception: '20', incomePerception: '6', grossIncomePerception: '2.5' },
  creditTaxes: true, fx: '', margin: '40', explorer: 'FOB'
});

test('state survives a round trip through the URL', () => {
  const s = defaults();
  s.price = '25000,5'; s.incoterm = 'CIF'; s.explorer = 'DAP'; s.costs.freight = '2100';
  s.rates.duty = '35'; s.creditTaxes = false; s.fx = '1185.5';
  const back = decodeState(encodeState(s), defaults());
  assert.deepEqual(back, s);
});

test('empty or unknown hashes fall back to defaults', () => {
  assert.equal(decodeState('', defaults()), null);
  const s = decodeState('i=XYZ&p=abc&c.freight=<script>&nonsense=1&ps=mars', defaults());
  assert.equal(s.incoterm, 'FOB');
  assert.equal(s.price, '10000');
  assert.equal(s.costs.freight, '1800');
  assert.equal(s.preset, 'ar');
});

test('choosing a preset in the link loads its tax structure', () => {
  const s = decodeState('ps=generic&r.duty=12', defaults());
  assert.deepEqual(s.rates, { duty: '12', vat: '20' });
});

test('CSV uses ; and decimal commas in Spanish, quoting when needed', () => {
  const r = computeLandedCost({ price: 1000.5, incoterm: 'CIF', costs: {}, tax: { ...PRESETS.generic, creditTaxes: true }, quantity: 2, marginPercent: 30 });
  const es = toCsv(r, STRINGS.es, 'es');
  assert.match(es, /^Costo puesto en depósito;USD\r\n/);
  assert.match(es, /Mercadería;1000,5;Lo pagás vos/);
  assert.match(es, /Despachante, gastos y documentación;0;Lo pagás vos/, 'commas need no quotes with ; separator');
  assert.match(es, /IVA;210,11;20%;recuperable/);
  const en = toCsv(r, STRINGS.en, 'en');
  assert.match(en, /Goods,1000\.5,You pay/);
  assert.match(en, /"Customs broker, fees and documents",0,You pay/);
});

test('language defaults to Spanish unless the browser is in English', () => {
  assert.equal(pickLanguage(null, 'es-AR'), 'es');
  assert.equal(pickLanguage(null, 'en-US'), 'en');
  assert.equal(pickLanguage(null, 'pt-BR'), 'es');
  assert.equal(pickLanguage('en', 'es-AR'), 'en');
});

test('every Incoterm has an explanation in both languages', () => {
  for (const lang of ['es', 'en']) {
    for (const code of ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP']) {
      assert.ok(STRINGS[lang].terms[code]?.length > 60, `${lang} ${code}`);
    }
    assert.deepEqual(Object.keys(STRINGS[lang]).sort(), Object.keys(STRINGS.es).sort(), `${lang} has every key`);
  }
});
