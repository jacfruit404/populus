/* Populus simulation engine.
 *
 * Pure logic: no DOM, no globals, no fetch. Everything it needs arrives as an
 * argument and everything it produces is returned. That is what makes it
 * testable, and the reason it lives in its own file — the calibration ledger
 * scores the model's predictions, so something has to score the code that
 * produces them.
 *
 * Loads as a plain <script> in the browser (defines window.Engine) and as a
 * CommonJS module in Node. No build step either way.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

/* ------------------------------------------------------------------ maths */

// FNV-1a. Same string always yields the same seed, which is what makes a
// prediction reproducible and therefore auditable.
function h32(str){
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
// mulberry32
function rng(seed){
  let a = seed >>> 0;
  return function(){
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const logistic = z => 1 / (1 + Math.exp(-z));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------- dimensions */

/* Six core behavioural dimensions, always present. `invert` means a high trait
   value pushes AGAINST the option: high scepticism resists a claim, high
   switching friction resists change. */
const CORE_DIMS = [
  {key:'price',   label:'Price framing',       invert:false},
  {key:'novelty', label:'Novelty appetite',    invert:false},
  {key:'trust',   label:'Institutional trust', invert:false},
  {key:'skeptic', label:'Claim credibility',   invert:true },
  {key:'effort',  label:'Switching effort',    invert:true },
  {key:'social',  label:'Social proof',        invert:false}
];
const TRAIT_KEYS = CORE_DIMS.map(d => d.key);

// core driver labels read differently depending on what is being decided
const DIMLBL = {
  pricing:{price:'Price vs. reference point', effort:'Switching friction', trust:'Brand trust'},
  product:{price:'Perceived value for money', novelty:'Appetite for a new workflow', effort:'Adoption effort', trust:'Vendor trust'},
  message:{price:'Value framing in the claim', skeptic:'Claim credibility', trust:'Authority of the source', social:'Peer validation'},
  policy: {price:'Household cost impact', novelty:'Appetite for change', trust:'Trust it gets delivered', effort:'Disruption to routine', social:'Perceived fairness'}
};
const dimLabel = (type, key, fallback) => (DIMLBL[type] || {})[key] || fallback;

/* A population may declare extra domain dimensions — health consciousness,
   trust in imported goods, whatever the decision actually turns on. They enter
   the affinity calculation exactly like the core six. */
function dims(market){
  const extra = (market && market.traits) || [];
  return CORE_DIMS.concat(extra.map(t => ({key:t.key, label:t.label, invert:!!t.invert, custom:true})));
}

/* --------------------------------------------------------------- parsing */

function parsePrice(str){
  const m = String(str).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/* A pricing option can carry a billing period, and the number alone is not the
   price: "$9/month" is $108/year, not $9. Reading only the number ranked a
   $108/year plan as the cheapest thing on the table. parsePrice still reads the
   number; parseBillingUnit reads the period so the number can be put on a
   common footing — and so options on genuinely different footings can be
   refused rather than silently compared. */
function parseBillingUnit(str){
  const s = String(str).toLowerCase();
  // one-time first, so "$99 flat" is one-time rather than matching nothing
  if (/\b(one[\s-]?time|one[\s-]?off|once|flat|lifetime|outright)\b/.test(s)) return 'onetime';
  if (/\/\s*mo(nth)?\b|\bper\s+month\b|\ba\s+month\b|\bmonthly\b/.test(s))     return 'monthly';
  if (/\/\s*(yr|year)\b|\bper\s+(year|annum)\b|\ba\s+year\b|\bannual(ly)?\b|\byearly\b/.test(s)) return 'yearly';
  return 'unspecified';
}
// Common comparison period is one year: a monthly price is annualised (×12);
// yearly, one-time and unspecified prices are already on that footing.
const PERIOD_MULT = {monthly: 12, yearly: 1, onetime: 1, unspecified: 1};
function normalizedPrice(str){
  const p = parsePrice(str);
  return p === null ? null : p * PERIOD_MULT[parseBillingUnit(str)];
}
/* Monthly and yearly share a basis (recurring) — annualising makes them
   directly comparable. One-time is a different basis: a subscription against a
   one-off needs a time horizon and a retention assumption to compare, which the
   engine will not invent. A bare number is its own basis because it could be
   any period. */
function billingBasis(unit){ return (unit === 'monthly' || unit === 'yearly') ? 'recurring' : unit; }
function billingReport(opts){
  const list = (opts || []).map(String).filter(o => o.trim());
  const units = list.map(parseBillingUnit);
  const order = [], byBasis = {};
  list.forEach((o, i) => {
    const b = billingBasis(units[i]);
    if (!byBasis[b]){ byBasis[b] = []; order.push(b); }
    byBasis[b].push(o);
  });
  return {units, groups: order.map(b => ({basis: b, opts: byBasis[b]})), mixed: order.length > 1};
}
function parseAgeRange(s){
  const m = String(s || '').match(/(\d{2})\s*(?:-|–|—|to)\s*(\d{2})/);
  if (m) return [+m[1], +m[2]];
  const one = String(s || '').match(/(\d{2})/);
  if (one) return [+one[1], +one[1] + 12];
  return [24, 62];
}

/* ---------------------------------------------------------------- scoring */

// Each dimension is seeded independently, so adding a custom dimension to a
// population does not perturb the values of the existing ones.
function latent(text, dimList){
  const o = {};
  dimList.forEach(d => { o[d.key] = rng(h32(text + '#' + d.key))() * 2 - 1; });
  return o;
}
function contribs(l, t, dimList){
  const c = {};
  dimList.forEach(d => {
    const v = t[d.key] === undefined ? 0.5 : t[d.key];
    c[d.key] = l[d.key] * ((d.invert ? (0.5 - v) : (v - 0.5)) * 2);
  });
  return c;
}
function activeSegs(market, segsOn){
  const list = market.segs.map((sg, i) => Object.assign({}, sg, {i}))
                          .filter(sg => segsOn ? segsOn[sg.i] : true);
  const tot = list.reduce((a, b) => a + b.s, 0) || 1;
  return list.map(sg => Object.assign({}, sg, {w: sg.s / tot}));
}
function segZ(seg, opt, cfg, dimList){
  const l = latent(cfg.question + '|' + opt + '|' + cfg.type, dimList);
  const c = contribs(l, seg.t, dimList);
  const A = dimList.reduce((a, d) => a + c[d.key], 0) / dimList.length;
  let z, wtpTerm = 0;
  if (cfg.type === 'pricing'){
    const p = normalizedPrice(opt);   // annualised, so $9/month is compared at 108
    wtpTerm = p === null ? 0 : (seg.wtp - p) / (0.62 * seg.sd);
    z = 0.15 + 0.92 * clamp(wtpTerm, -4, 4) + 0.90 * A;
  } else {
    z = 0.10 + 2.30 * A;
  }
  return {z, c, wtpTerm, A};
}

/* ----------------------------------------------------------------- agents */

const AGENTS_SHOWN = 260;

function buildAgents(cfg){
  const market = cfg.markets[cfg.marketKey];
  const segs = activeSegs(market, cfg.segsOn);
  const shown = cfg.agentsShown || AGENTS_SHOWN;
  const out = [];
  let id = 0;
  segs.forEach(sg => {
    const count = Math.max(4, Math.round(sg.w * shown));
    const range = parseAgeRange(sg.age);
    const ageLo = range[0], ageHi = range[1];
    const urbanShare = sg.urban === undefined ? 0.62 : sg.urban;
    for (let k = 0; k < count; k++){
      // The seed controls WHICH agents are drawn, not how the population
      // behaves. Same seed -> same sample. New seed -> a fresh draw.
      const r = rng(h32(cfg.marketKey + '|' + sg.n + '|' + k + '|s' + cfg.seed));
      const n = ((r() + r() + r()) / 3 - 0.5) * 2.6;      // ~N(0,1)-ish, bounded
      const fn = market.names.f[Math.floor(r() * market.names.f.length)];
      const ln = market.names.l[Math.floor(r() * market.names.l.length)];
      out.push({
        id: id++, seg: sg.i, segRef: sg, n, u: r(),
        name: fn + ' ' + ln,
        age: ageLo + Math.floor(r() * (Math.max(ageHi, ageLo) - ageLo + 1)),
        urban: r() < urbanShare,
        geo: sg.geo || '', income: sg.income || '',
        ctx: market.ctx[Math.floor(r() * market.ctx.length)],
        qi: Math.floor(r() * 2)
      });
    }
  });
  return out;
}

/* -------------------------------------------------------------- simulate */

/* cfg: {markets, marketKey, question, type, opts, segsOn, popN, seed, agentsShown} */
function simulate(cfg){
  const market = cfg.markets[cfg.marketKey];
  const dimList = dims(market);
  const segs = activeSegs(market, cfg.segsOn);
  const agents = buildAgents(cfg);
  const opts = cfg.opts.filter(o => String(o).trim());
  const zmap = {};
  segs.forEach(sg => { zmap[sg.i] = opts.map(o => segZ(sg, o, cfg, dimList)); });

  const het = cfg.type === 'pricing' ? 1.60 : 1.25;   // within-segment heterogeneity
  agents.forEach(a => {
    a.p = opts.map((o, oi) => logistic(zmap[a.seg][oi].z + het * a.n));
    // Structural floor and ceiling: some agents are outside the category
    // entirely, a few act regardless. Nothing ever reaches 0% or 100%.
    a.out = a.u < 0.038;
    a.always = a.u > 0.972;
    a.yes = a.p.map(p => a.out ? false : a.always ? true : p >= 0.5);
  });

  // segment and population rates aggregate UP from individual verdicts
  const segRates = segs.map(sg => {
    const mine = agents.filter(a => a.seg === sg.i);
    return opts.map((o, oi) => mine.filter(a => a.yes[oi]).length / mine.length);
  });
  const popRate = opts.map((o, oi) => segs.reduce((acc, sg, si) => acc + sg.w * segRates[si][oi], 0));

  // sampling error shrinks with n; model error does not
  const ci = popRate.map(p => {
    const se = Math.sqrt(Math.max(p * (1 - p), 0.02) / cfg.popN);
    return clamp(1.96 * se + 0.016, 0.005, 0.18);
  });

  // Billing cadence. When pricing options sit on different bases — a
  // subscription against a one-time fee, or a bare number against either — they
  // cannot be ranked without inventing a time horizon, which is the same class
  // of error as reading "$9/month" as 9. Detect it and refuse rather than
  // produce a confident wrong number.
  let billing = null, incomparable = null;
  if (cfg.type === 'pricing'){
    billing = billingReport(opts);
    if (billing.mixed) incomparable = {reason: 'mixed-billing', groups: billing.groups};
  }

  // Revenue index, on the normalised (annualised) price. Withheld when the
  // options are not comparable — a cross-basis revenue number would be fiction.
  let second = null;
  if (cfg.type === 'pricing' && !incomparable){
    const rev = opts.map((o, oi) => (popRate[oi] * (normalizedPrice(o) || 0)));
    const mx = Math.max.apply(null, rev) || 1;
    second = {label:'Revenue index', vals: rev.map(v => Math.round(v / mx * 100)),
              suffix:'', best: rev.indexOf(Math.max.apply(null, rev))};
  }

  // Winner: on revenue for a rankable pricing decision, on buy rate otherwise.
  // A refused (mixed-billing) run has no revenue index, so it falls back to buy
  // rate only to keep a stable table order — the UI does not present it as the
  // decision.
  const rank = opts.map((o, i) => i).sort((a, b) =>
    second ? second.vals[b] - second.vals[a] : popRate[b] - popRate[a]);
  const win = rank[0], run = rank[1] !== undefined ? rank[1] : rank[0];

  // Is the lead real, or inside the noise? For pricing the decision metric is
  // revenue, so the tie test runs on revenue, not the raw buy rate. A refusal to
  // rank is not a tie — it is a decline to compare at all.
  const tie = (opts.length < 2 || incomparable) ? false : (second
    ? Math.abs(second.vals[win] - second.vals[run]) <= 4
    : (popRate[win] - popRate[run]) <= (ci[win] + ci[run]) * 0.55);

  const drivers = dimList.map(dim => {
    const d = segs.reduce((acc, sg) => acc + sg.w * (zmap[sg.i][win].c[dim.key] - zmap[sg.i][run].c[dim.key]), 0);
    return {label: dim.custom ? dim.label : dimLabel(cfg.type, dim.key, dim.label),
            v: d * 0.38, custom: !!dim.custom};
  });
  if (cfg.type === 'pricing'){
    const d = segs.reduce((acc, sg) => acc + sg.w *
      (clamp(zmap[sg.i][win].wtpTerm, -4, 4) - clamp(zmap[sg.i][run].wtpTerm, -4, 4)), 0);
    drivers.push({label:'Willingness-to-pay headroom', v: d * 0.42});
  }
  drivers.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));

  // which segment disagrees most with the population
  let spread = 0, splitSeg = segs[0];
  segs.forEach((sg, si) => {
    const d = Math.abs(segRates[si][win] - popRate[win]);
    if (d > spread){ spread = d; splitSeg = sg; }
  });

  return {opts, segs, segRates, popRate, ci, second, win, run, rank, drivers,
          agents, spread, splitSeg, tie, incomparable, billing,
          n: cfg.popN, seed: cfg.seed, ts: new Date()};
}

function quoteFor(agent, oi, opts){
  const bank = agent.yes[oi] ? agent.segRef.pos : agent.segRef.neg;
  return bank[agent.qi % bank.length].replace(/\{O\}/g, opts[oi]);
}

/* ------------------------------------------------- model output handling */

function extractJSON(txt){
  const t = String(txt).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < 0) throw new Error('no JSON object in response');
  return JSON.parse(t.slice(a, b + 1));
}

/* Validate and repair. Small models drift on schemas, so anything safely
   fixable is fixed and reported rather than thrown away. */
function validateMarket(o){
  const errs = [], fix = [];
  if (!o || typeof o !== 'object'){ errs.push('response was not an object'); return {ok:false, errs, fix}; }
  const m = {
    name:     String(o.name || 'Custom population').slice(0, 80),
    universe: String(o.universe || 'size not specified').slice(0, 60),
    frame:    String(o.frame || 'Generated by a local model; not grounded in collected evidence.').slice(0, 200),
    unit:     String(o.unit || '$').slice(0, 12),
    cur:      String(o.cur || '$').slice(0, 3),
    ctx: Array.isArray(o.ctx) ? o.ctx.filter(x => typeof x === 'string' && x.trim()).map(x => x.slice(0, 48)) : [],
    names: {f:[], l:[]}, traits: [], segs: []
  };

  const seen = {};
  (Array.isArray(o.traits) ? o.traits : []).forEach(t => {
    if (!t) return;
    const key = String(t.key || t.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!key || TRAIT_KEYS.indexOf(key) >= 0 || seen[key]){
      if (TRAIT_KEYS.indexOf(key) >= 0) fix.push('custom trait "' + key + '" collides with a core trait, dropped');
      return;
    }
    seen[key] = 1;
    m.traits.push({key, label: String(t.label || key).slice(0, 44), invert: !!t.invert});
  });
  if (m.traits.length > 6){ m.traits = m.traits.slice(0, 6); fix.push('trimmed to 6 custom dimensions'); }
  const allKeys = TRAIT_KEYS.concat(m.traits.map(t => t.key));

  const nf = o.names && Array.isArray(o.names.f) ? o.names.f.filter(x => typeof x === 'string' && x.trim()) : [];
  const nl = o.names && Array.isArray(o.names.l) ? o.names.l.filter(x => typeof x === 'string' && x.trim()) : [];
  m.names.f = nf.length >= 4 ? nf : (fix.push('first names padded'), nf.concat(['Alex','Sam','Jordan','Riley','Casey','Morgan','Taylor','Jamie']));
  m.names.l = nl.length >= 4 ? nl : (fix.push('surnames padded'), nl.concat(['Hayes','Okonkwo','Novak','Silva','Bennett','Iqbal']));
  if (!m.ctx.length){ m.ctx = ['no context given']; fix.push('context phrases missing'); }

  let segs = Array.isArray(o.segs) ? o.segs : [];
  if (segs.length < 2){ errs.push('need at least 2 segments, got ' + segs.length); return {ok:false, errs, fix}; }
  if (segs.length > 10){ segs = segs.slice(0, 10); fix.push('trimmed to 10 segments'); }

  segs.forEach((sg, i) => {
    const t = {}, st = (sg && sg.t) || {};
    allKeys.forEach(k => {
      let v = Number(st[k] !== undefined ? st[k] : sg[k]);   // models often hoist traits to the top level
      if (!isFinite(v)){ v = 0.5; fix.push('seg ' + (i+1) + ': trait "' + k + '" missing'); }
      if (v > 1 && v <= 100){ v = v / 100; fix.push('seg ' + (i+1) + ': trait "' + k + '" rescaled from 0-100'); }
      t[k] = clamp(v, 0, 1);
    });
    let wtp = Number(sg.wtp), sd = Number(sg.sd);
    if (!isFinite(wtp) || wtp <= 0){ wtp = 10; fix.push('seg ' + (i+1) + ': wtp defaulted'); }
    if (!isFinite(sd)  || sd  <= 0){ sd = Math.max(1, wtp * 0.3); fix.push('seg ' + (i+1) + ': sd defaulted'); }

    /* A quote that never mentioned the option is not a response to the option.
       Welding "— {O}." onto the end produces gibberish, so prefer to drop it,
       and only reshape a quote into a reply when nothing else survives. */
    const clean = (arr, kind) => {
      const raw = Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.trim().length > 8).map(x => x.trim()) : [];
      const kept = raw.filter(x => x.indexOf('{O}') >= 0);
      if (kept.length){
        if (kept.length < raw.length) fix.push('seg ' + (i+1) + ': dropped ' + (raw.length - kept.length) + ' ' + kind + ' quote(s) that never referenced the option');
        return kept.slice(0, 4);
      }
      if (raw.length){
        fix.push('seg ' + (i+1) + ': no ' + kind + ' quote referenced the option, reshaped as a reply');
        return ['{O}? ' + raw[0]];
      }
      fix.push('seg ' + (i+1) + ': no ' + kind + ' quotes');
      return [kind === 'pos' ? '{O}? Yes, that works for me.' : '{O}? No, not for me.'];
    };

    // {O} belongs only in quotes; models leak it into names and descriptions
    let nm = String(sg.n || ('Segment ' + (i+1))).slice(0, 42);
    let bl = String(sg.b || 'No description given.').slice(0, 150);
    if (nm.indexOf('{O}') >= 0 || bl.indexOf('{O}') >= 0){
      fix.push('seg ' + (i+1) + ': stripped {O} from name/description');
      nm = nm.replace(/\{O\}/g, 'this').trim();
      bl = bl.replace(/\{O\}/g, 'it').trim();
    }

    // urban/rural mix may arrive as 0.7, as 70, or as "70% urban"
    let urb = sg.urban !== undefined ? sg.urban : sg.urban_rural;
    if (typeof urb === 'string'){ const mm = urb.match(/(\d+(\.\d+)?)/); urb = mm ? Number(mm[1]) : undefined; }
    urb = Number(urb);
    if (isFinite(urb)){ if (urb > 1 && urb <= 100) urb = urb / 100; urb = clamp(urb, 0, 1); } else urb = undefined;

    let geo = String(sg.geo || sg.country || sg.market || '').slice(0, 40);
    if (/[,;/]/.test(geo)){
      geo = geo.split(/[,;/]+/).map(x => x.trim()).filter(Boolean).join(' / ');
      fix.push('seg ' + (i+1) + ': covers several markets at once (' + geo + ') — the per-country breakdown will be coarse');
    }

    m.segs.push({
      n: nm, s: Math.max(Number(sg.s) || 0, 0.01), b: bl, t, wtp, sd, geo,
      age: String(sg.age || sg.age_range || '').slice(0, 20),
      income: String(sg.income || sg.income_level || '').slice(0, 24),
      urban: urb,
      pos: clean(sg.pos, 'pos'), neg: clean(sg.neg, 'neg')
    });
  });

  const tot = m.segs.reduce((a, b) => a + b.s, 0);
  if (Math.abs(tot - 1) > 0.02) fix.push('shares summed to ' + tot.toFixed(2) + ', renormalised');
  m.segs.forEach(s => { s.s = s.s / tot; });

  // a population whose segments all behave alike cannot produce a useful answer
  const spread = allKeys.reduce((acc, k) => {
    const vals = m.segs.map(s => s.t[k]);
    return acc + (Math.max.apply(null, vals) - Math.min.apply(null, vals));
  }, 0) / allKeys.length;
  if (spread < 0.12) errs.push('segments are nearly identical (mean trait spread ' + spread.toFixed(2) + ') — the model collapsed them');

  /* Asked to "split" a segment, a model will often duplicate it and change only
     the label. Two segments that behave identically are one segment wearing two
     names, and the segment table would imply a distinction that is not there. */
  const dupes = [];
  for (let i = 0; i < m.segs.length; i++) for (let j = i + 1; j < m.segs.length; j++){
    const a = m.segs[i], b = m.segs[j];
    const d = allKeys.reduce((acc, k) => acc + Math.abs(a.t[k] - b.t[k]), 0) / allKeys.length;
    const wd = Math.abs(a.wtp - b.wtp) / Math.max(a.wtp, b.wtp, 1e-9);
    // segments in different countries are legitimately distinct even if alike
    if (d < 0.03 && wd < 0.03 && (a.geo || '') === (b.geo || '')) dupes.push([a.n, b.n]);
  }
  dupes.forEach(pair => fix.push('"' + pair[0] + '" and "' + pair[1] + '" are behaviourally identical — the split is cosmetic'));

  return {ok: errs.length === 0, market: m, errs, fix, spread, dupes};
}

/* A 14B model answers the minimum it can get away with: ask for optional
   demographics and it returns none. Detect what is missing so it can be
   asked for again. */
function completenessGaps(mkt){
  const g = [], segs = mkt.segs;
  if (!segs.some(s => s.geo))                 g.push('"geo" — the country or region, on every segment');
  if (!segs.some(s => s.age))                 g.push('"age" — a range like "25-34", on every segment');
  if (!segs.some(s => s.income))              g.push('"income" — "low", "middle" or "affluent", on every segment');
  if (!segs.some(s => s.urban !== undefined)) g.push('"urban" — share living in cities, 0 to 1, on every segment');
  if (!(mkt.traits || []).length)             g.push('a "traits" array of 2-4 domain dimensions, each with a matching value inside every segment\'s "t"');
  return g;
}

/* The decision and the population are chosen in separate steps, so nothing
   stops you running a snack audience against a decision about medical
   software. Cheap content-word overlap catches the obvious cases. */
const STOPW = new Set(('the and for our your what which should would could when where ' +
 'that this with from they them their have has been will can not are was were ' +
 'much many more most less into onto over under about than then also just very ' +
 'new first next best good great make made take does did you it is be to of in on at a an or if we my'
).split(/\s+/));
const contentWords = s => (String(s || '').toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOPW.has(w));

function coherenceWarning(market, question, opts){
  if (!market || !market.brief) return null;          // only model-generated populations
  const pop = new Set(contentWords(market.name + ' ' + market.brief + ' ' + market.frame));
  const dec = contentWords(question + ' ' + (opts || []).join(' '));
  if (!dec.length || !pop.size) return null;
  if (dec.some(w => pop.has(w))) return null;
  return 'This population was built for “' + market.brief.slice(0, 110) + (market.brief.length > 110 ? '…' : '') +
         '” — nothing in it relates to the decision you are testing. Its traits, willingness-to-pay figures and ' +
         'verbatims were written for a different question, so any result will be meaningless.';
}

/* ---------------------------------------------------------------- ledger */

/* Mean absolute error says how wrong we are. Coverage says whether the stated
   intervals mean anything: if they are honest, ~95% of outcomes land inside. */
function ledgerStats(rows){
  const closed = (rows || []).filter(r => r && r.outcome);
  if (!closed.length) return null;
  const signed = closed.map(r => r.outcome.observed - r.predicted);
  const inside = closed.filter(r => Math.abs(r.outcome.observed - r.predicted) <= r.ci).length;
  return {
    n: closed.length,
    mae: signed.reduce((a, b) => a + Math.abs(b), 0) / closed.length,
    bias: signed.reduce((a, b) => a + b, 0) / closed.length,
    coverage: inside / closed.length,
    inside
  };
}

/* Number('') is 0, which would silently record a 0% outcome for an empty
   field. Returns a fraction, or null if the input is not a usable figure. */
function parseOutcome(entered){
  if (entered === undefined || entered === null || String(entered).trim() === '') return null;
  const raw = Number(entered);
  if (!isFinite(raw) || raw < 0 || raw > 100) return null;
  return raw / 100;
}

return {
  h32, rng, logistic, clamp,
  CORE_DIMS, TRAIT_KEYS, DIMLBL, dimLabel, dims,
  parsePrice, parseBillingUnit, normalizedPrice, billingReport, parseAgeRange,
  latent, contribs, activeSegs, segZ, buildAgents, simulate, quoteFor,
  extractJSON, validateMarket, completenessGaps, coherenceWarning,
  ledgerStats, parseOutcome,
  AGENTS_SHOWN
};
});
