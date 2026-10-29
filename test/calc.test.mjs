import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLandedCost, estimateInsurance, responsibilities, PRESETS, INCOTERM_CODES, STAGES } from '../js/calc.js';

// One real-world shipment, worked out by hand:
// goods worth USD 10,000 on board, freight 1,500, insurance 50,
// destination handling 400, broker 600, delivery 300, duty 16%.
const arTax = (overrides = {}) => ({
  ...PRESETS.ar,
  taxes: PRESETS.ar.taxes.map((t) => (t.id === 'duty' ? { ...t, rate: 16 } : t)),
  creditTaxes: true,
  ...overrides
});
const allCosts = {
  originInland: 300, exportClearance: 100, originHandling: 100,
  freight: 1500, insurance: 50, destHandling: 400, importClearance: 600, destInland: 300
};

test('FOB quote: customs value, Argentine taxes and landed cost match the hand calculation', () => {
  const r = computeLandedCost({ price: 10000, incoterm: 'FOB', costs: allCosts, tax: arTax(), quantity: 100 });
  assert.equal(r.fob, 10000);
  assert.equal(r.customsValue, 11550);
  const byId = Object.fromEntries(r.taxLines.map((l) => [l.id, l.amount]));
  assert.deepEqual(byId, {
    duty: 1848, statistics: 346.5, vat: 2886.35, vatPerception: 2748.9,
    incomePerception: 824.67, grossIncomePerception: 343.61
  });
  assert.equal(r.taxLines.find((l) => l.id === 'vat').base, 13744.5, 'VAT base = CIF + duty + statistics');
  assert.equal(r.taxesTotal, 8998.03);
  assert.equal(r.taxesRecoverable, 6803.53);
  assert.equal(r.taxesCost, 2194.5);
  assert.equal(r.buyerServices, 3150 - 300, 'freight, insurance and destination costs');
  assert.equal(r.landedCost, 15044.5);
  assert.equal(r.cashOut, 21848.03);
  assert.equal(r.perUnit, 150.45);
  assert.equal(r.multiplier, 1.504);
});

test('the same shipment costs the same whether quoted EXW, FOB or CIF', () => {
  const fob = computeLandedCost({ price: 10000, incoterm: 'FOB', costs: allCosts, tax: arTax() });
  const exw = computeLandedCost({ price: 9500, incoterm: 'EXW', costs: allCosts, tax: arTax() });
  const cif = computeLandedCost({ price: 11550, incoterm: 'CIF', costs: allCosts, tax: arTax() });
  const fca = computeLandedCost({ price: 9900, incoterm: 'FCA', costs: allCosts, tax: arTax() });
  for (const r of [exw, cif, fca]) {
    assert.equal(r.fob, 10000, `${r.incoterm} FOB value`);
    assert.equal(r.customsValue, 11550, `${r.incoterm} customs value`);
    assert.equal(r.landedCost, fob.landedCost, `${r.incoterm} landed cost`);
  }
});

test('DDP: seller pays duties, so they are not added again', () => {
  const r = computeLandedCost({ price: 20000, incoterm: 'DDP', costs: allCosts, tax: arTax() });
  assert.equal(r.dutiesPaidBySeller, true);
  assert.equal(r.buyerServices, 0);
  assert.equal(r.landedCost, 20000);
  assert.equal(r.cashOut, 20000);
  assert.ok(r.taxesTotal > 0, 'taxes still estimated for reference');
});

test('without tax credit (consumer or small business) VAT and perceptions become cost', () => {
  const r = computeLandedCost({ price: 10000, incoterm: 'FOB', costs: allCosts, tax: arTax({ creditTaxes: false }) });
  assert.equal(r.taxesRecoverable, 0);
  assert.equal(r.taxesCost, 8998.03);
  assert.equal(r.landedCost, r.cashOut);
});

test('statistics fee is capped by customs-value tier', () => {
  const stats = (price) => computeLandedCost({ price, incoterm: 'CIF', costs: {}, tax: arTax() })
    .taxLines.find((l) => l.id === 'statistics').amount;
  assert.equal(stats(9000), 180, 'up to USD 10k: capped at 180');
  assert.equal(stats(50000), 1500, 'under the USD 3,000 cap');
  assert.equal(stats(120000), 3600, 'tier up to USD 1M: cap 30,000');
  assert.equal(stats(2000000), 60000);
});

test('insurance can be estimated as a premium over 110% of FOB + freight', () => {
  assert.equal(estimateInsurance(10000, 1500, 0.3), 37.95);
  const r = computeLandedCost({
    price: 10000, incoterm: 'FOB', costs: { freight: 1500 }, insurance: { mode: 'rate', rate: 0.3 }, tax: PRESETS.generic
  });
  assert.equal(r.insurance, 37.95);
  assert.equal(r.customsValue, 11537.95);
});

test('FOB valuation basis (US-style) excludes freight and insurance from the duty base', () => {
  const r = computeLandedCost({ price: 10000, incoterm: 'FOB', costs: allCosts, tax: PRESETS.fobBasis });
  assert.equal(r.customsValue, 10000);
  assert.equal(r.taxLines[0].amount, 500);
});

test('generic preset: VAT applies on customs value plus duty', () => {
  const r = computeLandedCost({ price: 1000, incoterm: 'CIF', costs: {}, tax: { ...PRESETS.generic, creditTaxes: false } });
  assert.deepEqual(r.taxLines.map((l) => [l.id, l.amount]), [['duty', 50], ['vat', 210]]);
  assert.equal(r.landedCost, 1260);
});

test('local currency, per-unit and suggested selling price', () => {
  const r = computeLandedCost({
    price: 1000, incoterm: 'CIF', costs: {}, tax: { ...PRESETS.generic, creditTaxes: true },
    quantity: 40, fxRate: 1200, marginPercent: 35
  });
  assert.equal(r.landedCost, 1050);
  assert.equal(r.perUnit, 26.25);
  assert.equal(r.suggestedUnitPrice, 35.44);
  assert.deepEqual(r.local, { landedCost: 1260000, cashOut: 1512000, perUnit: 31500, suggestedUnitPrice: 42528 });
});

test('breakdown groups add up to the landed cost', () => {
  for (const code of INCOTERM_CODES) {
    const r = computeLandedCost({ price: 12000, incoterm: code, costs: allCosts, tax: arTax() });
    const sum = Math.round(r.breakdown.reduce((a, b) => a + b.amount, 0) * 100) / 100;
    assert.equal(sum, r.landedCost, code);
  }
});

test('handles messy input: strings, commas, negatives, missing fields', () => {
  const r = computeLandedCost({ price: '1000,5', incoterm: 'FOB', costs: { freight: '-20', destInland: 'abc' }, quantity: '0' });
  assert.equal(r.fob, 1000.5);
  assert.equal(r.freight, 0);
  assert.equal(r.quantity, 1);
  assert.throws(() => computeLandedCost({ price: 1, incoterm: 'XYZ' }), /Unknown Incoterm/);
});

test('responsibilities: who pays each stage under each term', () => {
  const payer = (code, stage) => responsibilities(code).find((r) => r.stage === stage).payer;
  assert.ok(STAGES.every((s) => payer('EXW', s) === 'buyer'));
  assert.ok(STAGES.every((s) => payer('DDP', s) === 'seller'));
  assert.equal(payer('FOB', 'originHandling'), 'seller');
  assert.equal(payer('FOB', 'freight'), 'buyer');
  assert.equal(payer('CFR', 'freight'), 'seller');
  assert.equal(payer('CFR', 'insurance'), 'buyer');
  assert.equal(payer('CIF', 'insurance'), 'seller');
  assert.equal(payer('DAP', 'importClearance'), 'buyer');
  assert.equal(payer('DPU', 'destHandling'), 'seller');
  assert.equal(payer('DAP', 'destHandling'), 'buyer');
});
