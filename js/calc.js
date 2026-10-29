// Landed-cost engine. Pure functions, no DOM: runs in the browser and in Node tests.

/** The journey of a shipment, in order. Each stage is a cost someone pays. */
export const STAGES = [
  'originInland',     // factory -> origin port/terminal
  'exportClearance',  // export customs formalities at origin
  'originHandling',   // terminal handling + loading on board at origin
  'freight',          // main international carriage
  'insurance',        // cargo insurance
  'destHandling',     // unloading + terminal handling at destination
  'importClearance',  // customs broker, port fees, documents
  'duties',           // import duties and taxes
  'destInland'        // destination port -> buyer's warehouse
];

/** Stages before the goods are on board at origin (the FOB point). */
const PRE_FOB = ['originInland', 'exportClearance', 'originHandling'];

/**
 * Incoterms 2020: which stages are included in the seller's price, where risk
 * passes to the buyer, and which transport modes the term is meant for.
 * Simplified to the common reading where D-terms name the buyer's premises and
 * FCA names the carrier's terminal at origin.
 */
export const INCOTERMS = {
  EXW: { seller: [], risk: 'sellerPremises', mode: 'any' },
  FCA: { seller: ['originInland', 'exportClearance'], risk: 'originTerminal', mode: 'any' },
  FAS: { seller: ['originInland', 'exportClearance'], risk: 'alongsideShip', mode: 'sea' },
  FOB: { seller: ['originInland', 'exportClearance', 'originHandling'], risk: 'onBoard', mode: 'sea' },
  CFR: { seller: ['originInland', 'exportClearance', 'originHandling', 'freight'], risk: 'onBoard', mode: 'sea' },
  CIF: { seller: ['originInland', 'exportClearance', 'originHandling', 'freight', 'insurance'], risk: 'onBoard', mode: 'sea' },
  CPT: { seller: ['originInland', 'exportClearance', 'originHandling', 'freight'], risk: 'originTerminal', mode: 'any' },
  CIP: { seller: ['originInland', 'exportClearance', 'originHandling', 'freight', 'insurance'], risk: 'originTerminal', mode: 'any' },
  DAP: { seller: ['originInland', 'exportClearance', 'originHandling', 'freight', 'insurance', 'destInland'], risk: 'destination', mode: 'any' },
  DPU: { seller: ['originInland', 'exportClearance', 'originHandling', 'freight', 'insurance', 'destHandling', 'destInland'], risk: 'destination', mode: 'any' },
  DDP: { seller: STAGES.slice(), risk: 'destination', mode: 'any' }
};

export const INCOTERM_CODES = Object.keys(INCOTERMS);

/**
 * Tax presets. Rates are typical general-regime values and are meant to be
 * edited: duty depends on the tariff code (NCM/HS) of each product.
 *
 * Every tax applies to the customs value; `cumulative` taxes (VAT and
 * perceptions) apply to customs value + duty + every non-cumulative fee.
 * `recoverable` taxes are advance payments a registered business can credit
 * later: they are cash out at customs, but not part of the final cost.
 */
export const PRESETS = {
  ar: {
    valuation: 'CIF',
    taxes: [
      { id: 'duty', rate: 0, cumulative: false, recoverable: false },
      // 3%, capped per declaration by customs-value tier (Decree 1140/2024, through 2027).
      { id: 'statistics', rate: 3, cumulative: false, recoverable: false,
        capTiers: [[10000, 180], [100000, 3000], [1000000, 30000], [Infinity, 150000]] },
      { id: 'vat', rate: 21, cumulative: true, recoverable: true },
      { id: 'vatPerception', rate: 20, cumulative: true, recoverable: true },
      { id: 'incomePerception', rate: 6, cumulative: true, recoverable: true },
      { id: 'grossIncomePerception', rate: 2.5, cumulative: true, recoverable: true }
    ]
  },
  generic: {
    valuation: 'CIF',
    taxes: [
      { id: 'duty', rate: 5, cumulative: false, recoverable: false },
      { id: 'vat', rate: 20, cumulative: true, recoverable: true }
    ]
  },
  fobBasis: {
    valuation: 'FOB',
    taxes: [
      { id: 'duty', rate: 5, cumulative: false, recoverable: false }
    ]
  }
};

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
};

/** Typical cargo insurance premium: rate% over 110% of (FOB + freight). */
export function estimateInsurance(fobValue, freight, ratePercent) {
  return round2((num(fobValue) + num(freight)) * 1.1 * (num(ratePercent) / 100));
}

function applyCap(amount, base, capTiers) {
  if (!capTiers) return amount;
  for (const [upTo, cap] of capTiers) {
    if (base <= upTo) return Math.min(amount, cap);
  }
  return amount;
}

/**
 * Compute a landed cost.
 *
 * @param {Object} input
 * @param {number} input.price           supplier price for the whole shipment (quote currency)
 * @param {string} input.incoterm        quote term, e.g. 'FOB'
 * @param {number} [input.quantity=1]
 * @param {Object} input.costs           amount per stage (quote currency). For stages included in
 *                                       the supplier price, the amount is an estimate used only to
 *                                       derive the customs value.
 * @param {Object} [input.insurance]     {mode: 'amount'|'rate', rate} - 'rate' estimates the premium
 * @param {Object} input.tax             {valuation:'CIF'|'FOB', taxes:[...], creditTaxes:boolean}
 * @param {number} [input.fxRate]        local currency per unit of quote currency
 * @param {number} [input.marginPercent] target gross margin on cost, for a suggested price
 */
export function computeLandedCost(input) {
  const term = INCOTERMS[input.incoterm];
  if (!term) throw new Error(`Unknown Incoterm "${input.incoterm}"`);
  const price = num(input.price);
  const quantity = Math.max(1, Math.round(num(input.quantity) || 1));
  const costs = {};
  for (const s of STAGES) costs[s] = Math.max(0, num(input.costs?.[s]));
  const sellerPays = new Set(term.seller);

  // FOB-equivalent value of the goods: what they are worth on board at origin.
  let fob = price;
  for (const s of STAGES) {
    if (s === 'duties') continue; // duties are computed below, never entered
    const isPre = PRE_FOB.includes(s);
    if (isPre && !sellerPays.has(s)) fob += costs[s];     // buyer pays to get them to FOB
    if (!isPre && sellerPays.has(s)) fob -= costs[s];     // price includes post-FOB services
  }
  fob = round2(Math.max(0, fob));

  if (input.insurance?.mode === 'rate') {
    costs.insurance = estimateInsurance(fob, costs.freight, input.insurance.rate);
  }

  const tax = input.tax || PRESETS.generic;
  const customsValue = round2(tax.valuation === 'FOB' ? fob : fob + costs.freight + costs.insurance);

  // Taxes: non-cumulative first (duty, fees), then cumulative ones on the enlarged base.
  const taxLines = [];
  let nonCumulativeTotal = 0;
  for (const t of tax.taxes || []) {
    if (t.cumulative) continue;
    const amount = round2(applyCap(customsValue * num(t.rate) / 100, customsValue, t.capTiers));
    nonCumulativeTotal += amount;
    taxLines.push({ id: t.id, rate: num(t.rate), base: customsValue, amount, recoverable: false });
  }
  const cumulativeBase = round2(customsValue + nonCumulativeTotal);
  for (const t of tax.taxes || []) {
    if (!t.cumulative) continue;
    const amount = round2(cumulativeBase * num(t.rate) / 100);
    // Only a registered business can credit VAT and perceptions later.
    const recoverable = !!t.recoverable && !!tax.creditTaxes;
    taxLines.push({ id: t.id, rate: num(t.rate), base: cumulativeBase, amount, recoverable });
  }
  const taxesTotal = round2(taxLines.reduce((a, l) => a + l.amount, 0));
  const taxesRecoverable = round2(taxLines.filter((l) => l.recoverable).reduce((a, l) => a + l.amount, 0));
  const taxesCost = round2(taxesTotal - taxesRecoverable);
  costs.duties = taxesTotal;

  // What the buyer actually pays, stage by stage.
  const lines = [{ id: 'goods', amount: round2(price), paidBy: 'buyer', included: false }];
  for (const s of STAGES) {
    if (s === 'duties') continue;
    lines.push({ id: s, amount: round2(costs[s]), paidBy: sellerPays.has(s) ? 'seller' : 'buyer', included: sellerPays.has(s) });
  }
  const buyerServices = round2(lines.filter((l) => l.id !== 'goods' && l.paidBy === 'buyer').reduce((a, l) => a + l.amount, 0));
  const dutiesPaidBySeller = sellerPays.has('duties');

  const landedCost = round2(price + buyerServices + (dutiesPaidBySeller ? 0 : taxesCost));
  const cashOut = round2(price + buyerServices + (dutiesPaidBySeller ? 0 : taxesTotal));
  const perUnit = round2(landedCost / quantity);
  const margin = num(input.marginPercent);
  const suggestedUnitPrice = margin > 0 ? round2(perUnit * (1 + margin / 100)) : null;
  const fx = num(input.fxRate);

  // Composition of the final cost, for the container-stack chart.
  const breakdown = [
    { group: 'goods', amount: round2(price) },
    { group: 'origin', amount: round2(PRE_FOB.filter((s) => !sellerPays.has(s)).reduce((a, s) => a + costs[s], 0)) },
    { group: 'transport', amount: round2(['freight', 'insurance'].filter((s) => !sellerPays.has(s)).reduce((a, s) => a + costs[s], 0)) },
    { group: 'destination', amount: round2(['destHandling', 'importClearance', 'destInland'].filter((s) => !sellerPays.has(s)).reduce((a, s) => a + costs[s], 0)) },
    { group: 'taxes', amount: dutiesPaidBySeller ? 0 : taxesCost }
  ];

  return {
    incoterm: input.incoterm,
    quantity,
    fob,
    freight: round2(costs.freight),
    insurance: round2(costs.insurance),
    customsValue,
    taxLines,
    taxesTotal,
    taxesRecoverable,
    taxesCost,
    dutiesPaidBySeller,
    lines,
    buyerServices,
    landedCost,
    cashOut,
    perUnit,
    suggestedUnitPrice,
    breakdown,
    // Landed cost over the goods price: the classic "multiplier" importers quote.
    multiplier: price > 0 ? Math.round((landedCost / price) * 1000) / 1000 : null,
    local: fx > 0 ? {
      landedCost: round2(landedCost * fx), cashOut: round2(cashOut * fx), perUnit: round2(perUnit * fx),
      suggestedUnitPrice: suggestedUnitPrice === null ? null : round2(suggestedUnitPrice * fx)
    } : null
  };
}

/** Which party pays each stage under a term (for the Incoterms explorer). */
export function responsibilities(code) {
  const term = INCOTERMS[code];
  if (!term) throw new Error(`Unknown Incoterm "${code}"`);
  return STAGES.map((s) => ({ stage: s, payer: term.seller.includes(s) ? 'seller' : 'buyer' }));
}
