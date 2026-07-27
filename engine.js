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

// Box–Muller. The old residual, ((r()+r()+r())/3-0.5)*2.6, has sd ≈ 0.43 and is
// hard-bounded at ±1.27; with the old het that capped any agent at ~1.6 logits
// from its segment mean, so any segment with |z|>1.6 came out unanimous — the
// stereotype complaint expressed as arithmetic. A real Gaussian has tails, so a
// dissenter is always possible.
function gauss(r){
  let u = 0, v = 0;
  while (u === 0) u = r();   // (0,1] so log is finite
  while (v === 0) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

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
   $108/year plan as the cheapest thing on the table. parsePrice reads the
   number; parseBillingUnit reads the period so the two can be put on one
   footing. */
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

/* Ranking a subscription against a one-time fee needs two things: a horizon to
   compare over, and — for monthly plans — a retention assumption, because a
   monthly subscriber can leave. That freedom to leave is the flip side of the
   flexibility that makes a monthly plan an easier "yes". The engine will not
   invent these silently (that was the whole point of the bug), so they are
   explicit defaults, adjustable by the caller and reported back to the UI. */
const DEFAULT_HORIZON = 3;        // years to compare revenue over
const DEFAULT_RETENTION = 0.7;    // share of the horizon a monthly subscriber stays
const horizonOf   = cfg => Math.max(0.25, Number(cfg.horizonYears) || DEFAULT_HORIZON);
const retentionOf = cfg => clamp(isFinite(Number(cfg.monthlyRetention)) ? Number(cfg.monthlyRetention) : DEFAULT_RETENTION, 0.05, 1);

/* What the buyer weighs at decision time. A monthly plan is annualised but
   discounted by expected retention: you commit to roughly what you expect to
   actually pay. So a monthly plan is an easier "yes" than a same-value annual
   one (full flexibility as retention → 0; no advantage as retention → 1). */
function decisionPrice(str, retention){
  const p = parsePrice(str);
  if (p === null) return null;
  return parseBillingUnit(str) === 'monthly' ? p * 12 * retention : p;
}
/* Expected revenue per converting customer over the horizon — the figure the
   options are ranked on, and the one the earlier bug got wrong by reading
   "$9/month" as $9 of one-off revenue. */
function revenueOverHorizon(str, years, retention){
  const p = parsePrice(str);
  if (p === null) return 0;
  switch (parseBillingUnit(str)){
    case 'monthly': return p * 12 * years * retention;   // annual value × horizon × retention
    case 'yearly':  return p * years;                    // renews across the horizon
    default:        return p;                             // one-time / unspecified: paid once
  }
}
function parseAgeRange(s){
  const m = String(s || '').match(/(\d{2})\s*(?:-|–|—|to)\s*(\d{2})/);
  if (m) return [+m[1], +m[2]];
  const one = String(s || '').match(/(\d{2})/);
  if (one) return [+one[1], +one[1] + 12];
  return [24, 62];
}

/* ---------------------------------------------------------------- scoring */

/* The response function USED to be this hash: latent() turns the stimulus into
   noise, so for message/product/policy the verdict was a random number behind a
   confident UI (two paraphrases of one claim scored differently; adding a '.'
   to the question flipped the winner). It survives only as a loud, flagged
   fallback — never the silent default. See loadings() below. */
function latent(text, dimList){
  const o = {};
  dimList.forEach(d => { o[d.key] = rng(h32(text + '#' + d.key))() * 2 - 1; });
  return o;
}

/* ---------------------------------------------------- stimulus loadings */

/* Judging what a claim MEANS needs semantics, and that is the one thing a hash
   cannot do. Loadings replace latent(): how strongly a specific option invokes
   each dimension, signed, judged by a model that can read the option. The
   engine stays pure — no fetch — so the app resolves loadings (a network call
   per option, cached) and passes the map in via cfg.loadings. These three
   helpers build the prompt, key the cache, and validate the reply, mirroring
   how validateMarket handles a generated population. Everything downstream is
   unchanged; contribs(), the WTP term, aggregation and the tie test do not
   know or care where the numbers came from. */

/* IMPORTANT: score ENGAGEMENT, not valence. The loading is "how strongly does
   this option invoke this dimension", and contribs() alone decides whether
   invoking it helps or hurts (via each dimension's `invert` flag and each
   agent's trait). Telling the model about `invert` here — e.g. "a high value
   RESISTS" — invites a valence answer instead, which contribs then flips a
   SECOND time on inverted dimensions: a well-formed, sign-reversed vector that
   validateLoadings can't catch. So the prompt never mentions invert, and says
   in as many ways as possible: rate engagement, not whether people will like
   it. */
function loadingsPrompt(question, option, type, dimList){
  const rows = dimList.map(d => '  "' + d.key + '": <number -1..1>   // ' + d.label).join('\n');
  return [
    'Score how strongly ONE option ENGAGES each behavioural dimension below.',
    'Decision type: ' + type + '.',
    'Question: ' + question,
    'Option under test: ' + option,
    '',
    'For each dimension return a number from -1 to 1:',
    '  +1  the option strongly invokes / leans on / activates this dimension',
    '   0  neutral — it neither engages the dimension nor works against it',
    '  -1  the option strongly pushes the opposite way',
    '',
    'Judge ONLY how much the option\'s content engages the dimension. Do NOT',
    'predict whether people will like, trust, approve, or buy it, and do NOT',
    'guess whether engaging the dimension helps or hurts — that is decided',
    'elsewhere. Example: a bold clinical claim scores HIGH on a claim-scepticism',
    'dimension because it engages scrutiny, whether or not scepticism is good.',
    '',
    'Return raw JSON only, one number per key, no commentary:',
    '{', rows, '}'
  ].join('\n');
}

// Cache key. Same question/option/type/model always resolves the same loadings,
// so a re-run is free and a committed prediction still reproduces byte-for-byte.
const loadingsKey = (question, option, type, model) =>
  'L' + h32(question + '|' + option + '|' + type + '|' + (model || 'hash')).toString(36);

/* Validate like validateMarket: clamp to [-1,1], default missing keys to 0,
   report repairs — and reject an all-zeros reply, which is the loadings version
   of a collapsed population (the option invokes nothing, so the model did not
   read it). */
function validateLoadings(o, dimList){
  const fix = [], errs = [], out = {};
  if (!o || typeof o !== 'object'){ errs.push('loadings response was not an object'); return {ok:false, errs, fix}; }
  dimList.forEach(d => {
    let v = Number(o[d.key]);
    if (!isFinite(v)){ v = 0; fix.push('loading "' + d.key + '" missing, defaulted to 0'); }
    else if (v > 1 || v < -1){ v = clamp(v, -1, 1); fix.push('loading "' + d.key + '" clamped to [-1,1]'); }
    out[d.key] = v;
  });
  const mag = dimList.reduce((a, d) => a + Math.abs(out[d.key]), 0) / dimList.length;
  if (mag < 0.04) errs.push('loadings are all ~0 — the option invokes nothing, so the model likely did not read it');
  return {ok: errs.length === 0, loadings: out, fix, errs};
}

/* Resolve one option's loadings for a run: the model-supplied vector from
   cfg.loadings when present, else the hash fallback with hash:true so the caller
   can raise a loud banner (and refuse non-pricing modes) rather than pass noise
   off as a reading. */
function optionLoadings(cfg, opt, dimList){
  const supplied = cfg.loadings && cfg.loadings[opt];
  if (supplied){
    const o = {};
    dimList.forEach(d => { o[d.key] = clamp(Number(supplied[d.key]) || 0, -1, 1); });
    return {load: o, hash: false};
  }
  return {load: latent(cfg.question + '|' + opt + '|' + cfg.type, dimList), hash: true};
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
/* The core score. Given one option's loadings and ONE trait vector, return its
   affinity and z. Called with the segment mean (for drivers and the tie
   explanation) and, since Change 2, with each agent's own trait vector (so two
   people in a segment genuinely differ). Pricing keeps its real WTP economics;
   the affinity term A is the part loadings made meaningful. */
function zAffinity(loadObj, traits, seg, opt, cfg, dimList){
  const c = contribs(loadObj, traits, dimList);
  const A = dimList.reduce((a, d) => a + c[d.key], 0) / dimList.length;
  let z, wtpTerm = 0;
  if (cfg.type === 'pricing'){
    // annualised for monthly, then discounted for retention: the flexibility of
    // a monthly plan makes it an easier yes than its full annual value implies
    const p = decisionPrice(opt, retentionOf(cfg));
    wtpTerm = p === null ? 0 : (seg.wtp - p) / (0.62 * seg.sd);
    z = 0.15 + 0.92 * clamp(wtpTerm, -4, 4) + 0.90 * A;
  } else {
    z = 0.10 + 2.30 * A;
  }
  return {z, c, wtpTerm, A};
}
// Segment-level score, on the segment mean traits. Loadings come from the model
// (cfg.loadings) when present, hash fallback otherwise.
function segZ(seg, opt, cfg, dimList){
  return zAffinity(optionLoadings(cfg, opt, dimList).load, seg.t, seg, opt, cfg, dimList);
}

/* ----------------------------------------------------------------- agents */

const AGENTS_SHOWN = 260;
const DEFAULT_SIGMA = 0.12;   // per-dimension within-segment trait spread
// Unmodeled variation splits in two. An agent-level propensity is shared across
// every option — some people just say yes to more things. An option-specific
// taste is drawn afresh for each (agent, option) — idiosyncratic liking the
// traits don't capture. Without the second term the shared residual dominates
// the small between-option differences and every agent votes the same way on
// everything: all-yes or all-no. The option term lets an agent like one option
// and reject another.
const DEFAULT_RESID = 0.80;     // agent-level propensity, shared across options
const DEFAULT_OPT_SIGMA = 1.00; // option-specific taste, per (agent, option)

/* Per-dimension trait spread. A population may declare its own (a number for
   all dimensions, or an object keyed by dimension); otherwise it is modest but
   non-zero, so a segment is a cloud, not a point. */
function sigmaFor(market, dimList){
  const s = market && market.sigma, out = {};
  dimList.forEach(d => {
    let v = DEFAULT_SIGMA;
    if (typeof s === 'number') v = s;
    else if (s && typeof s === 'object' && isFinite(Number(s[d.key]))) v = Number(s[d.key]);
    out[d.key] = clamp(v, 0, 0.5);
  });
  return out;
}

/* Names drawn without replacement within a run. The old code drew each name
   independently, so at N=260 on a 16×12 pool users saw five "Erin Calloway"s
   and read it as the model repeating itself. Shuffle the full combination pool
   with a run-level stream (same seed → same names) and assign in order; only if
   the pool is smaller than the run do names repeat. */
function uniqueNames(market, marketKey, seed, need){
  const f = (market.names && market.names.f) || [], l = (market.names && market.names.l) || [];
  const combos = [];
  for (let i = 0; i < f.length; i++) for (let j = 0; j < l.length; j++) combos.push(f[i] + ' ' + l[j]);
  if (!combos.length) return [];
  const r = rng(h32(marketKey + '|names|s' + seed));
  for (let i = combos.length - 1; i > 0; i--){ const k = Math.floor(r() * (i + 1)); const t = combos[i]; combos[i] = combos[k]; combos[k] = t; }
  const out = [];
  for (let x = 0; x < need; x++) out.push(combos[x % combos.length]);
  return out;
}

function buildAgents(cfg){
  const market = cfg.markets[cfg.marketKey];
  const dimList = dims(market);
  const segs = activeSegs(market, cfg.segsOn);
  const shown = cfg.agentsShown || AGENTS_SHOWN;
  const sigma = sigmaFor(market, dimList);
  const resid = isFinite(Number(cfg.residualSigma)) ? Number(cfg.residualSigma) : DEFAULT_RESID;

  // Counts first, so names can be drawn without replacement across the whole run.
  const counts = segs.map(sg => Math.max(4, Math.round(sg.w * shown)));
  const total = counts.reduce((a, b) => a + b, 0);
  const names = uniqueNames(market, cfg.marketKey, cfg.seed, total);

  const out = [];
  let id = 0;
  segs.forEach((sg, si) => {
    const count = counts[si];
    const range = parseAgeRange(sg.age);
    const ageLo = range[0], ageHi = Math.max(range[1], ageLo + 1);
    const midAge = (ageLo + ageHi) / 2, ageHalf = Math.max(1, (ageHi - ageLo) / 2);
    const urbanShare = sg.urban === undefined ? 0.62 : sg.urban;
    for (let k = 0; k < count; k++){
      // The seed controls WHICH agents are drawn, not how the population
      // behaves. Same seed -> same sample. New seed -> a fresh draw.
      const r = rng(h32(cfg.marketKey + '|' + sg.n + '|' + k + '|s' + cfg.seed));
      const age = ageLo + Math.floor(r() * (ageHi - ageLo + 1));
      const urban = r() < urbanShare;
      /* Each agent is a POINT in trait space, not the segment shifted along one
         axis: segment mean + Gaussian spread + demographic nudges that make the
         fields we already carry load-bearing. Nudges are centred within the
         segment (younger → more novel; more-urban → less switching effort), so
         the segment mean still reproduces. Income and geo are segment-level and
         already sit in the segment's own traits, so they are not re-applied. */
      const t = {};
      dimList.forEach(d => {
        let v = (sg.t[d.key] === undefined ? 0.5 : sg.t[d.key]) + sigma[d.key] * gauss(r);
        if (d.key === 'novelty') v += 0.10 * ((midAge - age) / ageHalf);
        if (d.key === 'effort')  v += 0.12 * (urbanShare - (urban ? 1 : 0));
        // Known bias: clamping truncates the tail nearest 0 or 1, so a segment
        // declared at 0.88 averages ~0.868 across the sample — the most
        // distinctive segments come out marginally less distinctive. ~0.012 at
        // sigma 0.12. Draw in logit space if this ever matters; for now it does
        // not move any verdict enough to care.
        t[d.key] = clamp(v, 0, 1);
      });
      out.push({
        id: id, seg: sg.i, segRef: sg, t, resid: resid * gauss(r), u: r(),
        name: names[id] || (sg.n + ' #' + k),
        age, urban, geo: sg.geo || '', income: sg.income || '',
        ctx: market.ctx[Math.floor(r() * market.ctx.length)],
        qi: Math.floor(r() * 2)
      });
      id++;
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

  // Option loadings: real semantics from the model (cfg.loadings), or the hash
  // fallback — flagged, never silent — when none were supplied.
  const optLoad = opts.map(o => optionLoadings(cfg, o, dimList));
  const hashFallback = optLoad.some(x => x.hash);

  // Segment-level scores, on the segment mean, drive the decomposition and the
  // tie explanation.
  const zmap = {};
  segs.forEach(sg => { zmap[sg.i] = opts.map((o, oi) => zAffinity(optLoad[oi].load, sg.t, sg, o, cfg, dimList)); });

  // Each agent votes on its OWN trait vector plus a real-Gaussian residual, so a
  // segment is a distribution of verdicts rather than one verdict cloned N times.
  agents.forEach(a => {
    const seg = a.segRef;
    const za = opts.map((o, oi) => zAffinity(optLoad[oi].load, a.t, seg, o, cfg, dimList));
    // agent-level propensity (a.resid, shared) + option-specific taste (its own
    // seeded draw per option) so an agent can say yes to one option and no to
    // another instead of voting the same way on all of them
    a.p = za.map((x, oi) => logistic(
      x.z + a.resid + DEFAULT_OPT_SIGMA * gauss(rng(h32(cfg.marketKey + '|oj|' + a.id + '|' + oi + '|s' + cfg.seed)))));
    // the dimension that moved THIS agent most for each option — lets a verbatim
    // be matched to why this specific person decided as they did (Change 3)
    a.drivers = za.map(x => {
      let best = dimList[0].key, bv = -1;
      dimList.forEach(d => { const av = Math.abs(x.c[d.key]); if (av > bv){ bv = av; best = d.key; } });
      return best;
    });
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

  // Billing cadence. Options can carry a period (/mo, /yr, flat). To rank them
  // together they are put on one footing: expected revenue per customer over a
  // comparison horizon, monthly plans annualised and discounted for retention.
  // The horizon and retention are explicit assumptions, reported back so the
  // number stays reconstructable rather than silently invented.
  let second = null, billing = null, assumptions = null;
  if (cfg.type === 'pricing'){
    billing = billingReport(opts);
    const H = horizonOf(cfg), RHO = retentionOf(cfg);
    const rev = opts.map((o, oi) => popRate[oi] * revenueOverHorizon(o, H, RHO));
    const mx = Math.max.apply(null, rev) || 1;
    second = {label:'Revenue index', vals: rev.map(v => Math.round(v / mx * 100)),
              suffix:'', best: rev.indexOf(Math.max.apply(null, rev))};
    assumptions = {
      horizonYears: H, monthlyRetention: RHO, mixed: billing.mixed,
      hasMonthly:   billing.units.indexOf('monthly') >= 0,
      hasRecurring: billing.units.some(u => u === 'monthly' || u === 'yearly'),
      // a bare number has no stated period; it is counted as a single purchase,
      // which is worth flagging when it sits next to a subscription
      unspecifiedAsOnetime: opts.filter((o, i) => billing.units[i] === 'unspecified')
    };
  }

  // winner is decided on revenue for pricing, on rate otherwise
  const rank = opts.map((o, i) => i).sort((a, b) =>
    second ? second.vals[b] - second.vals[a] : popRate[b] - popRate[a]);
  const win = rank[0], run = rank[1] !== undefined ? rank[1] : rank[0];

  // Is the lead real, or inside the noise? For pricing the decision metric is
  // revenue, so the tie test runs on revenue, not on the raw buy rate.
  const tie = opts.length < 2 ? false : (second
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
          agents, spread, splitSeg, tie, billing, assumptions, hashFallback,
          n: cfg.popN, seed: cfg.seed, ts: new Date()};
}

function quoteFor(agent, oi, opts){
  const bank = agent.yes[oi] ? agent.segRef.pos : agent.segRef.neg;
  return bank[agent.qi % bank.length].replace(/\{O\}/g, opts[oi]);
}

/* Trait-matched verbatim. The old path indexed a two-item bank by qi ∈ {0,1},
   so 260 agents produced at most four sentences per segment. A per-segment bank
   of ~20-30 quotes, each tagged with the dimension that drives it, lets each
   agent draw the quote whose driver matches its OWN largest contribution, with
   valence matching its verdict — variety from 4 to ~30, and the quote now
   reflects why this specific agent decided as it did. Falls back to the pos/neg
   pair when a population has no richer bank. Keeps the {O} substitution. */
function pickQuote(agent, oi, opts){
  const bank = agent.segRef && agent.segRef.bank;
  if (!Array.isArray(bank) || !bank.length) return quoteFor(agent, oi, opts);
  const valence = agent.yes[oi] ? 'pos' : 'neg';
  const driver = agent.drivers ? agent.drivers[oi] : null;
  const byValence = bank.filter(q => q.valence === valence);
  const pool = byValence.length ? byValence : bank;
  const matched = pool.filter(q => q.driver === driver);
  const choose = matched.length ? matched : pool;
  const r = rng(h32('q|' + agent.id + '|' + oi + '|' + (agent.qi || 0)));   // seeded tie-break
  const q = choose[Math.floor(r() * choose.length)];
  return String(q.text).replace(/\{O\}/g, opts[oi]);
}

/* Replicate bootstrap. popN was user-set but only ~260 agents were ever drawn,
   so the closed-form interval described a sample never taken, and its +0.016
   fudge was far too small for a model with a dozen hand-tuned constants. Measure
   the uncertainty instead: run many independent persona draws at moderate N and
   report the spread of what actually varies — which people you got. Prefer many
   moderate draws over one large one; between-draw variance is the signal, and a
   single huge population averages it away. */
function bootstrap(cfg, opt){
  opt = opt || {};
  const reps = opt.replicates || 20;
  const n = opt.n || 1000;
  const base = cfg.seed || 1;
  const O = cfg.opts.filter(o => String(o).trim()).length;
  const wins = new Array(O).fill(0), byOpt = Array.from({length: O}, () => []);
  let primary = null;
  for (let i = 0; i < reps; i++){
    const seed = h32('rep|' + base + '|' + i) >>> 0;   // an independent persona draw
    const r = simulate(Object.assign({}, cfg, {seed, agentsShown: n, popN: n}));
    if (i === 0) primary = r;                            // interview only this one
    wins[r.win]++;
    r.popRate.forEach((p, oi) => byOpt[oi].push(p));
  }
  const q = (xs, f) => { const s = xs.slice().sort((a, b) => a - b); return s[clamp(Math.floor(f * s.length), 0, s.length - 1)]; };
  const dist = byOpt.map(xs => ({
    median: q(xs, 0.5), p10: q(xs, 0.10), p90: q(xs, 0.90),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length
  }));
  const winShare = wins.map(w => w / reps);
  const topWin = winShare.indexOf(Math.max.apply(null, winShare));
  // A win-share threshold replaces the interval comparison: if the leader does
  // not take a clear majority of independent draws, the answer is unstable.
  const tie = O > 1 && winShare[topWin] < 0.70;
  return {replicates: reps, n, wins, winShare, dist, topWin, tie, primary};
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
  h32, rng, logistic, clamp, gauss,
  CORE_DIMS, TRAIT_KEYS, DIMLBL, dimLabel, dims,
  parsePrice, parseBillingUnit, normalizedPrice, billingReport,
  decisionPrice, revenueOverHorizon, parseAgeRange,
  latent, loadingsPrompt, loadingsKey, validateLoadings, optionLoadings,
  contribs, activeSegs, zAffinity, segZ, sigmaFor, uniqueNames,
  buildAgents, simulate, bootstrap, quoteFor, pickQuote,
  extractJSON, validateMarket, completenessGaps, coherenceWarning,
  ledgerStats, parseOutcome,
  AGENTS_SHOWN
};
});
