import { computeLandedCost, INCOTERMS, INCOTERM_CODES, PRESETS, STAGES, responsibilities } from './calc.js';
import { STRINGS, pickLanguage } from './i18n.js';
import { encodeState, decodeState, toCsv } from './state.js';

const $ = (id) => document.getElementById(id);
const GROUP_COLORS = ['goods', 'origin', 'transport', 'destination', 'taxes'];
const ENTERED_STAGES = STAGES.filter((s) => s !== 'duties');

const storage = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: fine */ } }
};

function defaultState() {
  return {
    price: '10000', quantity: '500', incoterm: 'FOB',
    costs: { originInland: '', exportClearance: '', originHandling: '', freight: '1800', insurance: '',
      destHandling: '450', importClearance: '650', destInland: '350' },
    insMode: true, insRate: '0.3',
    preset: 'ar', valuation: PRESETS.ar.valuation,
    rates: Object.fromEntries(PRESETS.ar.taxes.map((t) => [t.id, String(t.id === 'duty' ? 18 : t.rate)])),
    creditTaxes: true, fx: '', margin: '40',
    explorer: 'FOB'
  };
}

let lang = pickLanguage(storage.get('lc-lang'), navigator.language);
let state = decodeState(location.hash.slice(1), defaultState()) || defaultState();
let lastResult = null;

const t = () => STRINGS[lang];
const fmt = (n, opts = {}) => new Intl.NumberFormat(lang === 'es' ? 'es-AR' : 'en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2, ...opts }).format(n);
const money = (n) => 'US$ ' + fmt(n);
const pct = (n) => fmt(n, { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' %';

// ---- building the static parts -------------------------------------------

function termButtons(container, name, selected, onPick) {
  container.innerHTML = '';
  for (const code of INCOTERM_CODES) {
    const label = document.createElement('label');
    label.className = 'term';
    label.innerHTML = `<input type="radio" name="${name}" value="${code}"><span>${code}</span>`;
    const input = label.firstElementChild;
    input.checked = code === selected;
    input.addEventListener('change', () => onPick(code));
    container.append(label);
  }
}

function buildStages() {
  const ol = $('stages');
  ol.innerHTML = '';
  for (const s of ENTERED_STAGES) {
    const li = document.createElement('li');
    li.className = 'stage';
    li.dataset.stage = s;
    li.innerHTML = `
      <label for="c-${s}" class="stage-name"></label>
      <span class="badge"></span>
      <span class="money"><span class="cur" aria-hidden="true">US$</span><input id="c-${s}" inputmode="decimal" placeholder="0"></span>`;
    const input = li.querySelector('input');
    input.value = state.costs[s] ?? '';
    input.addEventListener('input', () => { state.costs[s] = input.value; update(); });
    ol.append(li);
  }
}

function buildPresets() {
  const sel = $('preset');
  sel.innerHTML = '';
  for (const key of [...Object.keys(PRESETS), 'custom']) {
    const o = document.createElement('option');
    o.value = key;
    sel.append(o);
  }
  sel.value = state.preset;
}

function onPresetChange() {
  const sel = $('preset');
  if (sel.value !== 'custom') {
    const p = PRESETS[sel.value];
    state.valuation = p.valuation;
    state.rates = Object.fromEntries(p.taxes.map((x) => [x.id, String(x.rate)]));
  }
  state.preset = sel.value;
  buildTaxes();
  syncValuation();
  update();
}

function onPickIncoterm(code) {
  state.incoterm = code;
  state.explorer = code;
  termButtons($('explorerTerms'), 'explorer', state.explorer, onPickExplorer);
  renderExplorer();
  update();
}

function onPickExplorer(code) {
  state.explorer = code;
  renderExplorer();
}

/** Tax rows come from the base preset (custom keeps the Argentine structure). */
function currentTaxDefs() {
  const base = PRESETS[state.preset] || PRESETS.ar;
  return base.taxes.map((x) => ({ ...x, rate: parseFloat(String(state.rates[x.id] ?? x.rate).replace(',', '.')) || 0 }));
}

function buildTaxes() {
  const box = $('taxes');
  box.innerHTML = '';
  for (const def of currentTaxDefs()) {
    const row = document.createElement('label');
    row.className = 'tax-row';
    row.dataset.tax = def.id;
    row.innerHTML = `
      <span class="tax-name"></span>
      <span class="money pct"><input inputmode="decimal"><span class="cur" aria-hidden="true">%</span></span>
      ${def.id === 'duty' ? '<small class="duty-hint"></small>' : ''}`;
    const input = row.querySelector('input');
    input.value = state.rates[def.id] ?? def.rate;
    input.addEventListener('input', () => {
      state.rates[def.id] = input.value;
      update();
    });
    box.append(row);
  }
  applyText();
}

function syncValuation() {
  for (const r of document.querySelectorAll('input[name="valuation"]')) r.checked = r.value === state.valuation;
}

// ---- text ------------------------------------------------------------------

function applyText() {
  const s = t();
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const v = s[el.dataset.i18n];
    if (typeof v === 'string') el.textContent = v;
  }
  for (const li of document.querySelectorAll('.stage')) li.querySelector('.stage-name').textContent = s.stages[li.dataset.stage];
  for (const o of $('preset').options) o.textContent = s.presets[o.value];
  for (const row of document.querySelectorAll('.tax-row')) {
    row.querySelector('.tax-name').textContent = s.taxNames[row.dataset.tax];
    const hint = row.querySelector('.duty-hint');
    if (hint) hint.textContent = s.dutyHint;
  }
  document.title = lang === 'es'
    ? 'Costo puesto en depósito: calculadora de importación e Incoterms'
    : 'Landed cost calculator for imports and Incoterms';
}

// ---- rendering -------------------------------------------------------------

function render(r) {
  const s = t();
  $('outLanded').textContent = money(r.landedCost);
  $('outPerUnit').textContent = money(r.perUnit);
  $('miniLanded').textContent = money(r.landedCost);
  $('miniUnit').textContent = money(r.perUnit) + ' ' + s.perUnit;
  const local = $('outLocal');
  if (r.local) {
    local.hidden = false;
    local.textContent = `${s.local}: $ ${fmt(r.local.landedCost, { maximumFractionDigits: 0, minimumFractionDigits: 0 })}, $ ${fmt(r.local.perUnit)} ${s.perUnit}`;
  } else local.hidden = true;

  // Container stack: one corrugated block per cost group, width = share of cost.
  const total = r.breakdown.reduce((a, b) => a + b.amount, 0) || 1;
  const stack = $('stack');
  const legend = $('legend');
  stack.innerHTML = '';
  legend.innerHTML = '';
  const described = [];
  r.breakdown.forEach((b) => {
    const share = b.amount / total;
    if (b.amount > 0) {
      const box = document.createElement('div');
      box.className = `box g-${b.group}`;
      box.style.flexGrow = String(share);
      box.title = `${s.groups[b.group]}: ${money(b.amount)}`;
      stack.append(box);
    }
    const li = document.createElement('li');
    li.className = `g-${b.group}${b.amount === 0 ? ' zero' : ''}`;
    li.innerHTML = `<span class="sw"></span><span class="nm"></span><span class="am"></span><span class="sh"></span>`;
    li.querySelector('.nm').textContent = s.groups[b.group];
    li.querySelector('.am').textContent = money(b.amount);
    li.querySelector('.sh').textContent = pct(share * 100);
    legend.append(li);
    described.push(`${s.groups[b.group]} ${pct(share * 100)}`);
  });
  stack.setAttribute('aria-label', described.join(', '));

  const figures = [
    [s.cashOut, money(r.cashOut), s.cashOutHint],
    [s.customsValue, money(r.customsValue)],
    [s.fobValue, money(r.fob)],
    [s.taxCost, money(r.dutiesPaidBySeller ? 0 : r.taxesCost)],
    [s.multiplier, r.multiplier === null ? '—' : fmt(r.multiplier, { minimumFractionDigits: 3, maximumFractionDigits: 3 }), s.multiplierHint]
  ];
  if (r.suggestedUnitPrice !== null) {
    figures.push([s.suggested, money(r.suggestedUnitPrice) + ' ' + s.perUnit,
      r.local?.suggestedUnitPrice ? `$ ${fmt(r.local.suggestedUnitPrice)}` : '']);
  }
  const dl = $('figures');
  dl.innerHTML = '';
  for (const [k, v, hint] of figures) {
    const div = document.createElement('div');
    div.innerHTML = '<dt></dt><dd></dd>';
    div.querySelector('dt').textContent = k;
    div.querySelector('dd').textContent = v;
    if (hint) {
      const sm = document.createElement('small');
      sm.textContent = hint;
      div.querySelector('dt').append(sm);
    }
    dl.append(div);
  }

  const tb = $('taxTable');
  tb.innerHTML = '';
  for (const l of r.taxLines) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<th scope="row"></th><td></td><td></td><td></td>';
    const name = tr.children[0];
    name.textContent = s.taxNames[l.id];
    if (l.recoverable) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = s.recoverable;
      name.append(' ', tag);
    }
    tr.children[1].textContent = pct(l.rate);
    tr.children[2].textContent = money(l.base);
    tr.children[3].textContent = money(l.amount);
    tb.append(tr);
  }
  $('ddpNote').hidden = !r.dutiesPaidBySeller;
}

/** Mark each journey stage as "in the price" or "you pay" for the quote term. */
function renderStageBadges() {
  const s = t();
  const seller = new Set(INCOTERMS[state.incoterm].seller);
  for (const li of document.querySelectorAll('.stage')) {
    const included = seller.has(li.dataset.stage);
    li.classList.toggle('included', included);
    li.querySelector('.badge').textContent = included ? s.included : s.youPay;
    const input = li.querySelector('input');
    input.placeholder = included ? s.estimateOnly : '0';
    if (li.dataset.stage === 'insurance') input.disabled = state.insMode;
  }
  $('insMode').checked = state.insMode;
  $('insRateField').hidden = !state.insMode;
}

// ---- Incoterms explorer -----------------------------------------------------

const RISK_AFTER = { sellerPremises: -1, originTerminal: 1, alongsideShip: 1, onBoard: 2, destination: 8 };

function renderExplorer() {
  const s = t();
  const code = state.explorer;
  const term = INCOTERMS[code];
  const resp = responsibilities(code);
  const route = $('route');
  route.innerHTML = '';

  const places = document.createElement('div');
  places.className = 'places';
  for (const p of ['seller', 'origin', 'sea', 'dest', 'buyer']) {
    const span = document.createElement('span');
    span.textContent = s.route[p];
    places.append(span);
  }
  route.append(places);

  const strip = document.createElement('ol');
  strip.className = 'strip';
  const riskAfter = RISK_AFTER[term.risk];
  const lastSeller = resp.reduce((acc, r, i) => (r.payer === 'seller' ? i : acc), -1);
  resp.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = `cell ${r.payer}`;
    li.innerHTML = '<span class="cell-name"></span><span class="cell-payer"></span>';
    li.querySelector('.cell-name').textContent = s.stages[r.stage];
    li.querySelector('.cell-payer').textContent = r.payer === 'seller' ? s.seller : s.buyer;
    if (i === riskAfter) li.classList.add('risk-after');
    if (i === lastSeller) li.classList.add('cost-after');
    strip.append(li);
  });
  if (riskAfter === -1) strip.classList.add('risk-start');
  route.append(strip);

  const keys = document.createElement('p');
  keys.className = 'route-keys';
  keys.innerHTML = '<span class="k-risk"></span><span class="k-cost"></span>';
  keys.children[0].textContent = s.riskPoint;
  keys.children[1].textContent = s.costPoint;
  route.append(keys);

  $('termName').textContent = code;
  $('termText').textContent = s.terms[code];
  $('termMode').textContent = term.mode === 'sea' ? s.modeSea : s.modeAny;
}

// ---- update loop ------------------------------------------------------------

function readInputs() {
  return {
    price: state.price,
    quantity: state.quantity,
    incoterm: state.incoterm,
    costs: state.costs,
    insurance: state.insMode ? { mode: 'rate', rate: state.insRate } : { mode: 'amount' },
    tax: { valuation: state.valuation, taxes: currentTaxDefs(), creditTaxes: state.creditTaxes },
    fxRate: state.fx,
    marginPercent: state.margin
  };
}

let hashTimer = null;
function update() {
  renderStageBadges();
  lastResult = computeLandedCost(readInputs());
  render(lastResult);
  if (state.insMode) $('c-insurance').value = lastResult.insurance ? String(lastResult.insurance) : '';
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => history.replaceState(null, '', '#' + encodeState(state)), 250);
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
}

function bind() {
  const simple = { price: 'price', quantity: 'quantity', insRate: 'insRate', fx: 'fx', margin: 'margin' };
  for (const [id, key] of Object.entries(simple)) {
    const el = $(id);
    el.value = state[key] ?? '';
    el.addEventListener('input', () => { state[key] = el.value; update(); });
  }
  $('insMode').addEventListener('change', (e) => {
    state.insMode = e.target.checked;
    if (!state.insMode) state.costs.insurance = $('c-insurance').value;
    update();
  });
  $('creditTaxes').checked = state.creditTaxes;
  $('creditTaxes').addEventListener('change', (e) => { state.creditTaxes = e.target.checked; update(); });
  for (const r of document.querySelectorAll('input[name="valuation"]')) {
    r.addEventListener('change', () => { state.valuation = r.value; update(); });
  }
  syncValuation();

  $('preset').addEventListener('change', onPresetChange);

  $('lang').addEventListener('click', () => {
    lang = lang === 'es' ? 'en' : 'es';
    storage.set('lc-lang', lang);
    applyText();
    renderExplorer();
    update();
  });

  $('share').addEventListener('click', async () => {
    const url = location.href.split('#')[0] + '#' + encodeState(state);
    try { await navigator.clipboard.writeText(url); toast(t().shared); }
    catch { prompt(t().share, url); }
  });
  $('csv').addEventListener('click', () => {
    const blob = new Blob(['﻿' + toCsv(lastResult, t(), lang)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `landed-cost-${state.incoterm}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('print').addEventListener('click', () => window.print());
  $('reset').addEventListener('click', () => {
    const keepLang = lang;
    state = defaultState();
    history.replaceState(null, '', location.pathname);
    lang = keepLang;
    init();
  });

  // Mobile: a slim bar with the result until the result panel scrolls into view.
  const bar = $('minibar');
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => bar.classList.toggle('show', !e.isIntersecting && window.innerWidth < 900))
      .observe($('result'));
  }
  bar.addEventListener('click', () => $('result').scrollIntoView({ behavior: 'smooth' }));
}

let bound = false;
function init() {
  buildStages();
  buildPresets();
  buildTaxes();
  if (!bound) { bind(); bound = true; } else {
    for (const id of ['price', 'quantity', 'insRate', 'fx', 'margin']) $(id).value = state[id] ?? '';
    $('creditTaxes').checked = state.creditTaxes;
    syncValuation();
  }
  termButtons($('incoterm'), 'incoterm', state.incoterm, onPickIncoterm);
  termButtons($('explorerTerms'), 'explorer', state.explorer, onPickExplorer);
  applyText();
  renderExplorer();
  update();
}

init();
