/* Tests for the Populus simulation engine.
 *
 *   node engine.test.js          (exits non-zero on failure)
 *   open http://localhost:8765/test.html
 *
 * No framework, no dependencies. These assert invariants that should hold for
 * any correct version of the engine, not the specific numbers today's
 * coefficients happen to produce — so tuning the model does not break them,
 * but breaking the model does.
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./engine.js'));
  else root.EngineTests = factory(root.Engine);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (E) {
'use strict';

function run(){
  const log = [];
  let passed = 0, failed = 0, group = '';
  const G = name => { group = name; log.push({type:'group', text:name}); };
  const ok = (cond, msg) => {
    if (cond){ passed++; log.push({type:'pass', text:msg}); }
    else { failed++; log.push({type:'fail', text:msg}); }
  };
  const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

  /* ---------------------------------------------------------- fixtures */
  const market = () => ({
    name:'Test market', universe:'x', frame:'y', unit:'$', cur:'$',
    ctx:['ctx one','ctx two'],
    names:{f:['Ada','Bo','Cy','Di'], l:['Lin','Mo','Ng','Oz']},
    segs:[
      {n:'Thrifty', s:0.6, geo:'UK', age:'25-34', income:'low', urban:0.3, b:'desc',
       t:{price:.9,novelty:.2,trust:.3,skeptic:.8,effort:.7,social:.2}, wtp:5, sd:1.5,
       pos:['{O} is a bargain.'], neg:['{O} is too dear.']},
      {n:'Spendy', s:0.4, geo:'US', age:'45-60', income:'affluent', urban:0.9, b:'desc',
       t:{price:.2,novelty:.8,trust:.7,skeptic:.2,effort:.3,social:.8}, wtp:20, sd:5,
       pos:['{O} suits me.'], neg:['{O} is not for me.']}
    ]
  });
  const cfg = over => Object.assign({
    markets:{m: market()}, marketKey:'m', question:'What should we charge?',
    type:'pricing', opts:['$4','$8','$16'], segsOn:[true,true], popN:12000, seed:1
  }, over || {});

  /* ------------------------------------------------------------- hash */
  G('Determinism primitives');
  ok(E.h32('abc') === E.h32('abc'), 'h32 is stable for the same input');
  ok(E.h32('abc') !== E.h32('abd'), 'h32 separates near-identical inputs');
  const r1 = E.rng(42), r2 = E.rng(42);
  const s1 = [r1(), r1(), r1()], s2 = [r2(), r2(), r2()];
  ok(s1.join() === s2.join(), 'rng replays exactly from the same seed');
  ok(s1.every(v => v >= 0 && v < 1), 'rng stays in [0,1)');
  ok(E.rng(42)() !== E.rng(43)(), 'different seeds diverge');
  ok(near(E.logistic(0), 0.5) && E.logistic(10) > 0.99 && E.logistic(-10) < 0.01, 'logistic behaves');
  ok(E.clamp(5,0,1) === 1 && E.clamp(-5,0,1) === 0 && E.clamp(.5,0,1) === .5, 'clamp bounds');

  /* ------------------------------------------------------- dimensions */
  G('Dimensions');
  ok(E.dims(market()).length === 6, 'a plain population has the six core dimensions');
  const withTraits = market();
  withTraits.traits = [{key:'health', label:'Health', invert:true}, {key:'imp', label:'Imports'}];
  const d8 = E.dims(withTraits);
  ok(d8.length === 8, 'declared dimensions are appended');
  ok(d8[6].custom === true && d8[6].invert === true, 'custom flag and invert survive');
  ok(d8.slice(0,6).every((d,i) => d.key === E.CORE_DIMS[i].key), 'core dimensions keep their order');

  // This is why each dimension is hashed separately: adding one must not move
  // the others, or every existing population would silently change.
  const la = E.latent('same text', E.dims(market()));
  const lb = E.latent('same text', d8);
  ok(E.TRAIT_KEYS.every(k => la[k] === lb[k]), 'adding a dimension does not perturb existing ones');
  ok(Object.keys(lb).length === 8 && lb.health !== undefined, 'the new dimension gets its own value');
  ok(Object.values(la).every(v => v >= -1 && v <= 1), 'latent values stay in [-1,1]');

  G('Contribution sign');
  const dimsCore = E.dims(market());
  const lat = {}; dimsCore.forEach(d => { lat[d.key] = 1; });   // all latents +1
  const cHi = E.contribs(lat, {price:1,novelty:1,trust:1,skeptic:1,effort:1,social:1}, dimsCore);
  ok(cHi.price > 0, 'a non-inverted trait at max pushes toward the option');
  ok(cHi.skeptic < 0, 'scepticism is inverted: high scepticism resists');
  ok(cHi.effort < 0, 'switching friction is inverted: high friction resists');
  const cMid = E.contribs(lat, {price:.5,novelty:.5,trust:.5,skeptic:.5,effort:.5,social:.5}, dimsCore);
  ok(Object.values(cMid).every(v => near(v, 0)), 'a neutral segment contributes nothing either way');

  /* ---------------------------------------------------------- parsing */
  G('Parsing');
  ok(E.parsePrice('$8.99') === 8.99, 'price with symbol');
  ok(E.parsePrice('£1,299') === 1299, 'price with thousands separator');
  ok(E.parsePrice('free') === null, 'non-numeric price is null, not zero');
  ok(E.parseAgeRange('25-34').join() === '25,34', 'hyphen range');
  ok(E.parseAgeRange('18–24').join() === '18,24', 'en-dash range');
  ok(E.parseAgeRange('45 to 60').join() === '45,60', 'worded range');
  ok(E.parseAgeRange('').join() === '24,62', 'missing age falls back to a broad band');

  G('Segment weighting');
  const all = E.activeSegs(market(), [true,true]);
  ok(near(all.reduce((a,b) => a + b.w, 0), 1), 'weights sum to 1');
  const one = E.activeSegs(market(), [false,true]);
  ok(one.length === 1 && near(one[0].w, 1), 'excluding a segment renormalises the rest to 1');
  ok(one[0].i === 1, 'the surviving segment keeps its original index (colours stay stable)');

  /* --------------------------------------------------------- simulate */
  G('Simulation invariants');
  const R = E.simulate(cfg());
  ok(R.popRate.length === 3 && R.segRates.length === 2, 'shape matches options and segments');
  ok(R.popRate.every(v => v >= 0 && v <= 1), 'every rate is a probability');

  // The headline number must be exactly the share-weighted segment rates. If
  // this drifts, the segment table and the headline are telling different
  // stories and the ledger would be scoring a number nobody can reconstruct.
  const identity = R.popRate.every((v, i) =>
    near(v, R.segs.reduce((acc, sg, si) => acc + sg.w * R.segRates[si][i], 0)));
  ok(identity, 'population rate equals the share-weighted segment rates, exactly');

  ok(JSON.stringify(E.simulate(cfg()).popRate) === JSON.stringify(R.popRate),
     'same seed reproduces the same prediction');
  ok(JSON.stringify(E.simulate(cfg({seed:2})).popRate) !== JSON.stringify(R.popRate),
     'a new seed draws a different sample');

  const wide = E.simulate(cfg({popN:1000})).ci[0];
  const tight = E.simulate(cfg({popN:50000})).ci[0];
  ok(tight < wide, 'the interval narrows as the sample grows');
  ok(tight > 0.015, 'but never collapses — model error does not shrink with n');

  G('Demand curve');
  const curve = E.simulate(cfg({opts:['$2','$4','$6','$9','$14','$22','$40']}));
  let monotone = true;
  for (let i = 1; i < curve.popRate.length; i++)
    if (curve.popRate[i] > curve.popRate[i-1] + 0.02) monotone = false;
  ok(monotone, 'raising the price never raises demand: ' +
     curve.popRate.map(v => (v*100).toFixed(0)).join(' > '));
  ok(curve.popRate[0] < 0.995, 'a giveaway price still does not convert everyone (some are not in the category)');
  ok(curve.popRate[curve.popRate.length-1] > 0.004, 'an absurd price still converts a few (some act regardless)');
  ok(curve.second && curve.second.vals.length === 7, 'pricing runs produce a revenue index');
  ok(curve.second.vals[curve.second.best] === 100, 'the revenue index peaks at 100');

  G('Winner selection and ties');
  ok(curve.rank[0] === curve.win, 'the winner is the top-ranked option');
  ok(curve.win !== curve.run, 'winner and runner-up are different options');
  const far = E.simulate(cfg({opts:['$4','$40']}));
  ok(far.tie === false, 'a decisive gap is not called a tie');
  const twin = E.simulate(cfg({opts:['$8','$8.05']}));
  ok(twin.tie === true, 'two effectively identical prices are called a tie');
  const nonPricing = E.simulate(cfg({type:'product', opts:['Alpha','Beta','Gamma'], question:'Which feature first?'}));
  ok(nonPricing.second === null, 'only pricing gets a revenue index');
  ok(typeof nonPricing.tie === 'boolean', 'non-pricing decisions still get a tie verdict');

  /* ------------------------------------------------- billing units */
  // "$9/month" is not $9. Reading only the number ranked a $108/year plan as
  // the cheapest option on the table; the period has to be read too.
  G('Billing unit detection');
  ok(E.parseBillingUnit('$9/month') === 'monthly', '/month is monthly');
  ok(E.parseBillingUnit('$9/mo') === 'monthly', '/mo is monthly');
  ok(E.parseBillingUnit('$9 per month') === 'monthly', 'per month is monthly');
  ok(E.parseBillingUnit('$99 monthly') === 'monthly', 'the word monthly is monthly');
  ok(E.parseBillingUnit('$19/year') === 'yearly', '/year is yearly');
  ok(E.parseBillingUnit('$19/yr') === 'yearly', '/yr is yearly');
  ok(E.parseBillingUnit('$19 per year') === 'yearly', 'per year is yearly');
  ok(E.parseBillingUnit('$199 annual') === 'yearly', 'annual is yearly');
  ok(E.parseBillingUnit('$99 Flat') === 'onetime', 'flat is one-time');
  ok(E.parseBillingUnit('$99 one-time') === 'onetime', 'one-time is one-time');
  ok(E.parseBillingUnit('$299 lifetime') === 'onetime', 'lifetime is one-time');
  ok(E.parseBillingUnit('$6.99') === 'unspecified', 'a bare number states no period');

  G('Price normalisation');
  ok(E.parsePrice('$9/month') === 9, 'parsePrice still reads only the number');
  ok(E.normalizedPrice('$9/month') === 108, 'a monthly price is annualised to a common period');
  ok(E.normalizedPrice('$19/year') === 19, 'a yearly price is already on that period');
  ok(E.normalizedPrice('$99 Flat') === 99, 'a one-time price is taken at face value');
  ok(E.normalizedPrice('$6.99') === 6.99, 'a bare number is unchanged');
  ok(E.normalizedPrice('free') === null, 'a non-numeric price stays null');

  G('Decision price and monthly flexibility');
  const rho = 0.7;
  ok(E.decisionPrice('$9/month', rho) === 9*12*rho, 'a monthly plan is annualised then discounted for retention');
  ok(E.decisionPrice('$9/month', 1) === 108, 'at full retention a monthly plan is a full annual commitment');
  ok(E.decisionPrice('$19/year', rho) === 19, 'a yearly price is its own decision price');
  ok(E.decisionPrice('$99 Flat', rho) === 99, 'a one-time price is its own decision price');

  // wtpTerm is latent-independent, so it isolates the price the buyer weighs.
  // Flexibility puts a monthly plan below its full annual value but above its
  // bare monthly number — an easier yes than $108, a harder one than $9.
  const bSeg = E.activeSegs(market(), [true,true])[0], bDims = E.dims(market());
  const zMo   = E.segZ(bSeg, '$9/month', cfg({monthlyRetention:rho}), bDims);
  const zFull = E.segZ(bSeg, '$108',     cfg({monthlyRetention:rho}), bDims);
  const zBare = E.segZ(bSeg, '$9',       cfg({monthlyRetention:rho}), bDims);
  ok(zMo.wtpTerm < zBare.wtpTerm && zMo.wtpTerm > zFull.wtpTerm,
     'a monthly plan is weighed between its bare number and its full annual value');
  ok(near(zMo.wtpTerm, (bSeg.wtp - 9*12*rho)/(0.62*bSeg.sd)),
     'the monthly decision price is exactly annualised × retention');

  G('Standardising mixed billing');
  const uni = E.simulate(cfg({opts:['$19/year','$39/year','$99/year']}));
  ok(uni.second && uni.assumptions, 'a uniform recurring run ranks and reports its assumptions');
  ok(uni.assumptions.horizonYears === 3 && uni.assumptions.monthlyRetention === 0.7,
     'the defaults are a 3-year horizon at 0.7 retention');

  // Recurring mixed with one-time now standardises instead of refusing.
  const mixed = E.simulate(cfg({opts:['$19/year','$9/month','$39/year','$99 Flat']}));
  ok(mixed.second && mixed.second.vals.length === 4, 'recurring mixed with one-time is ranked, not refused');
  ok(mixed.assumptions.mixed === true, 'the run is flagged mixed so the UI can surface the assumptions');
  ok(typeof mixed.tie === 'boolean', 'a mixed run still gets a tie verdict');

  // The revenue index is expected revenue over the horizon: monthly annualised
  // × horizon × retention, yearly × horizon, one-time once.
  ok(E.revenueOverHorizon('$9/month', 3, 0.7) === 9*12*3*0.7, 'monthly revenue is annual value × horizon × retention');
  ok(E.revenueOverHorizon('$19/year', 3, 0.7) === 57, 'yearly revenue renews across the horizon');
  ok(E.revenueOverHorizon('$99 Flat', 3, 0.7) === 99, 'a one-time fee is paid once regardless of horizon');
  const rev = mixed.popRate.map((p,i) => p * E.revenueOverHorizon(mixed.opts[i], 3, 0.7));
  const mxr = Math.max.apply(null, rev);
  ok(mixed.opts.every((o,i) => mixed.second.vals[i] === Math.round(rev[i]/mxr*100)),
     'the revenue index is that expected revenue, normalised to 100');

  // The horizon actually moves the ranking (demand is unchanged by it, revenue is not).
  const shortH = E.simulate(cfg({opts:['$9/month','$99 Flat'], horizonYears:0.25}));
  const longH  = E.simulate(cfg({opts:['$9/month','$99 Flat'], horizonYears:5}));
  ok(shortH.second.vals.join() !== longH.second.vals.join(), 'changing the horizon changes the revenue ranking');

  // A bare number beside a subscription is counted one-time and flagged, not refused.
  const bare = E.simulate(cfg({opts:['$50','$9/month']}));
  ok(bare.second, 'a bare number alongside a subscription still ranks');
  ok(bare.assumptions.unspecifiedAsOnetime.indexOf('$50') >= 0,
     'the bare number is flagged as counted one-time so it can be corrected');

  G('Drivers');
  ok(nonPricing.drivers.length === 6, 'six dimensions produce six drivers');
  ok(E.simulate(cfg()).drivers.length === 7, 'pricing adds the willingness-to-pay driver');
  const custom = market(); custom.traits = [{key:'health', label:'Health consciousness', invert:true}];
  const cr = E.simulate(cfg({markets:{m:custom}, type:'product', opts:['A','B']}));
  ok(cr.drivers.length === 7 && cr.drivers.some(d => d.custom && d.label === 'Health consciousness'),
     'a declared dimension appears as a driver under its own label');
  const sorted = cr.drivers.every((d, i) => i === 0 || Math.abs(cr.drivers[i-1].v) >= Math.abs(d.v));
  ok(sorted, 'drivers are ordered by magnitude');

  G('Agents');
  ok(R.agents.length >= 250 && R.agents.length <= 275, 'roughly the requested number of agents (' + R.agents.length + ')');
  const uk = R.agents.filter(a => a.geo === 'UK'), us = R.agents.filter(a => a.geo === 'US');
  ok(uk.length > 0 && us.length > 0, 'agents carry their segment’s country');
  ok(uk.every(a => a.age >= 25 && a.age <= 34), 'ages fall inside the segment’s band');
  ok(us.every(a => a.age >= 45 && a.age <= 60), 'a second band is respected too');
  ok(uk.every(a => a.income === 'low'), 'income is inherited from the segment');
  const urbanShare = us.filter(a => a.urban).length / us.length;
  ok(Math.abs(urbanShare - 0.9) < 0.2, 'urban share approximates the segment figure (' + urbanShare.toFixed(2) + ')');
  ok(R.agents.every(a => a.yes.length === 3 && a.p.length === 3), 'every agent answers every option');
  ok(R.agents.some(a => a.out) && R.agents.some(a => a.always), 'the population contains both never- and always-buyers');
  ok(E.simulate(cfg({agentsShown:60})).agents.length < 80, 'agent count is configurable');

  G('Verbatims');
  const withOpt = E.quoteFor(R.agents[0], 0, ['$4','$8','$16']);
  ok(withOpt.indexOf('{O}') === -1 && withOpt.indexOf('$4') >= 0, 'the option is substituted into the quote');
  ok(R.agents.every(a => E.quoteFor(a, 1, ['$4','$8','$16']).indexOf('{O}') === -1),
     'no agent produces an unsubstituted quote');

  /* ----------------------------------------- stimulus loadings (Change 1) */
  // The original bug: for message/product/policy the response function was a
  // hash of the question, so two paraphrases scored differently and appending
  // "." to the question flipped the winner. These are the invariants that would
  // have caught it.
  G('Stimulus loadings');
  const dl6 = E.dims(market());
  const fullLoad = {}; dl6.forEach(d => { fullLoad[d.key] = 0.3; });
  ok(E.validateLoadings(fullLoad, dl6).ok, 'a complete loadings vector validates');

  // The prompt must ask for ENGAGEMENT, not valence, and must never leak the
  // `invert` flag — telling the model "a high value resists" makes it return
  // sign-flipped loadings that contribs() double-flips and validateLoadings
  // cannot catch (a well-formed but wrong vector).
  const withInvert = market(); withInvert.traits = [{key:'health', label:'Health', invert:true}];
  const prompt = E.loadingsPrompt('Which claim?', 'Clinically proven', 'message', E.dims(withInvert));
  ok(!/resist/i.test(prompt) && !/invert/i.test(prompt),
     'the loadings prompt never mentions invert/resist — that caused silent sign inversion');
  ok(/engage/i.test(prompt) && /\bdo not\b/i.test(prompt) && /(like|approve|buy)/i.test(prompt),
     'the prompt frames loadings as engagement and forbids predicting whether people will like it');
  const clamped = E.validateLoadings(Object.assign({}, fullLoad, {price: 5, novelty: -9}), dl6);
  ok(clamped.loadings.price === 1 && clamped.loadings.novelty === -1 && clamped.fix.length >= 2,
     'out-of-range loadings are clamped to [-1,1] and every repair reported');
  const partial = {}; dl6.slice(1).forEach(d => { partial[d.key] = 0.3; });
  ok(E.validateLoadings(partial, dl6).loadings[dl6[0].key] === 0, 'a missing loading defaults to 0');
  const zeroLoad = {}; dl6.forEach(d => { zeroLoad[d.key] = 0; });
  ok(!E.validateLoadings(zeroLoad, dl6).ok, 'an all-zero reply is rejected — the option invoked nothing, so the model did not read it');

  ok(E.loadingsKey('Q', 'A', 'product', 'm') === E.loadingsKey('Q', 'A', 'product', 'm'), 'the cache key is stable');
  ok(E.loadingsKey('Q', 'A', 'product', 'm') !== E.loadingsKey('Q.', 'A', 'product', 'm'), 'a reworded question keys differently');

  // The engine reads loadings, not the wording. With loadings supplied, the
  // response function no longer touches the question text.
  const twoLoad = {Alpha:{price:.7,novelty:.6,trust:.4,skeptic:-.5,effort:-.3,social:.5},
                   Beta:{price:-.6,novelty:-.4,trust:-.2,skeptic:.6,effort:.4,social:-.5}};
  const wA = E.simulate(cfg({type:'product', opts:['Alpha','Beta'], question:'Which feature first?', loadings:twoLoad}));
  const wB = E.simulate(cfg({type:'product', opts:['Alpha','Beta'], question:'Which feature first?.', loadings:twoLoad}));
  ok(wA.hashFallback === false, 'supplied loadings are used, not the hash');
  ok(wA.win === wB.win && JSON.stringify(wA.popRate) === JSON.stringify(wB.popRate),
     'appending "." to the question no longer changes the verdict — the wording is out of the response function');
  ok(E.simulate(cfg({type:'product', opts:['Alpha','Beta'], question:'Q'})).hashFallback === true,
     'without loadings the hash fallback is used AND flagged, never silent');
  // committed prediction still reproduces from the cached loadings
  ok(JSON.stringify(E.simulate(cfg({type:'product', opts:['Alpha','Beta'], loadings:twoLoad})).popRate)
     === JSON.stringify(wA.popRate), 'a committed prediction reproduces with cached loadings');

  // Loadings aligned with a population outrank their mirror image — the verdict
  // now responds to what the option means, not to a hash.
  const segA = E.activeSegs(market(), [true,true])[0];
  const aligned = {}, mirror = {};
  dl6.forEach(d => {
    const v = segA.t[d.key], factor = (d.invert ? (0.5 - v) : (v - 0.5)) * 2;
    aligned[d.key] = factor >= 0 ? 0.8 : -0.8;   // point with the population's tilt
    mirror[d.key] = -aligned[d.key];
  });
  const zAl = E.zAffinity(aligned, segA.t, segA, 'X', cfg({type:'product'}), dl6);
  const zAn = E.zAffinity(mirror,  segA.t, segA, 'X', cfg({type:'product'}), dl6);
  ok(zAl.A > 0 && zAn.A < 0 && zAl.z > zAn.z, 'loadings aligned with the population outrank their opposite');

  /* ----------------------------------------- per-agent trait vectors (Change 2) */
  G('Per-agent individuation');
  // real Gaussian tails: the old residual was hard-bounded at ±1.27, which made
  // any segment with |z|>1.6 structurally unanimous
  const gr = E.rng(7); let gmax = 0;
  for (let i = 0; i < 5000; i++) gmax = Math.max(gmax, Math.abs(E.gauss(gr)));
  ok(gmax > 3, 'the residual has real tails (was hard-bounded at ±1.27, forcing unanimity)');

  // agent traits average back to the segment mean — individuation without moving
  // the population. Use a mid-range market so clamping does not bias the mean.
  const midMkt = {name:'mid', unit:'$', cur:'$', ctx:['c'],
    names:{f:['A','B','C','D'], l:['E','F','G','H']},
    segs:[{n:'Lo', s:0.5, age:'30-40', urban:0.5, t:{price:.4,novelty:.4,trust:.4,skeptic:.4,effort:.4,social:.4}, wtp:10, sd:3, pos:['{O} ok'], neg:['{O} no']},
          {n:'Hi', s:0.5, age:'30-40', urban:0.5, t:{price:.6,novelty:.6,trust:.6,skeptic:.6,effort:.6,social:.6}, wtp:10, sd:3, pos:['{O} ok'], neg:['{O} no']}]};
  const midCfg = {markets:{m:midMkt}, marketKey:'m', question:'Q', type:'product', opts:['X'], segsOn:[true,true], popN:12000, seed:3, agentsShown:5000};
  const midAgents = E.buildAgents(midCfg), midDims = E.dims(midMkt);
  let meanOk = true;
  [0,1].forEach(si => {
    const mine = midAgents.filter(a => a.seg === si);
    midDims.forEach(d => {
      const avg = mine.reduce((s,a)=>s+a.t[d.key],0)/mine.length;
      if (Math.abs(avg - midMkt.segs[si].t[d.key]) > 0.02) meanOk = false;
    });
  });
  ok(meanOk, 'per-agent traits average back to the segment mean within tolerance');
  ok(midAgents.every(a => a.t && midDims.every(d => a.t[d.key] >= 0 && a.t[d.key] <= 1)),
     'every agent carries a full trait vector in [0,1]');

  // no segment is unanimous even when it leans hard: among agents who are in the
  // category and not forced buyers, both verdicts appear
  const leanMkt = {name:'lean', unit:'$', cur:'$', ctx:['c'], sigma:0.12,
    names:{f:['A','B','C','D'], l:['E','F','G','H']},
    segs:[{n:'Keen', s:1, age:'30-40', urban:0.5, t:{price:1,novelty:1,trust:1,skeptic:0,effort:0,social:1}, wtp:10, sd:3, pos:['{O} ok'], neg:['{O} no']},
          {n:'Cool', s:0.001, age:'30-40', urban:0.5, t:{price:.5,novelty:.5,trust:.5,skeptic:.5,effort:.5,social:.5}, wtp:10, sd:3, pos:['{O} ok'], neg:['{O} no']}]};
  const strongLoad = {O:{price:1,novelty:1,trust:1,skeptic:-1,effort:-1,social:1}};
  const lean = E.simulate({markets:{m:leanMkt}, marketKey:'m', question:'Q', type:'product', opts:['O'], segsOn:[true,true], popN:12000, seed:2, agentsShown:3000, loadings:strongLoad});
  const keen = lean.agents.filter(a => a.seg === 0 && !a.out && !a.always);
  ok(keen.some(a => a.yes[0]) && keen.some(a => !a.yes[0]),
     'a strongly-leaning segment still contains dissenters (not just the structural floor)');

  // Agents discriminate BETWEEN options, not just within a segment. Even when
  // the options are near-identical, a real share vote yes on some and no on
  // others — rather than the shared residual forcing every agent all-yes or
  // all-no (the bug: without a per-option taste term, that is exactly what
  // happened once loadings made similar options score alike).
  const simMkt = {name:'sim', unit:'$', cur:'$', ctx:['c'], names:{f:['A','B','C','D'], l:['E','F','G','H']},
    segs:[{n:'S1', s:0.5, age:'30-40', urban:0.5, t:{price:.5,novelty:.6,trust:.5,skeptic:.4,effort:.4,social:.6}, wtp:10, sd:3, pos:['{O} ok'], neg:['{O} no']},
          {n:'S2', s:0.5, age:'30-40', urban:0.5, t:{price:.4,novelty:.4,trust:.6,skeptic:.5,effort:.5,social:.4}, wtp:10, sd:3, pos:['{O} ok'], neg:['{O} no']}]};
  const simL = {A:{price:.3,novelty:.5,trust:.2,skeptic:-.3,effort:-.2,social:.4},
                B:{price:.3,novelty:.55,trust:.2,skeptic:-.25,effort:-.2,social:.45},
                C:{price:.25,novelty:.5,trust:.15,skeptic:-.3,effort:-.15,social:.4}};
  const disc = E.simulate({markets:{m:simMkt}, marketKey:'m', question:'Which first?', type:'product',
    opts:['A','B','C'], segsOn:[true,true], popN:12000, seed:7, agentsShown:3000, loadings:simL});
  const norm = disc.agents.filter(a => !a.out && !a.always);
  const mixedVotes = norm.filter(a => { const y = a.yes.filter(Boolean).length; return y > 0 && y < a.yes.length; }).length;
  ok(mixedVotes / norm.length > 0.25,
     'agents discriminate between options — a real share vote yes on some and no on others, not all-yes/all-no (' + (100*mixedVotes/norm.length).toFixed(0) + '%)');

  /* ----------------------------------------- dynamic range */
  // The response function must SEPARATE stimuli. It used to divide affinity by
  // the dimension count, so a strong signal on a few dimensions vanished — every
  // message/product/policy verdict pinned near 52%, and adding dimensions made it
  // worse. Engagement-normalisation fixed it; this is the test that would have
  // caught the bug on day one.
  G('Dynamic range');
  const rangeMkt = (extra) => {
    const traits = [];
    for (let i = 0; i < extra; i++) traits.push({key:'v'+i, label:'V'+i});
    const seg = (n, s) => {
      const t = {price:.5,novelty:.5,trust:.5,skeptic:.5,effort:.5,social:.5};
      traits.forEach(tr => { t[tr.key] = 0.9; });   // the population holds these values strongly
      return {n, s, age:'30-50', urban:0.5, t, wtp:10, sd:3, pos:['{O} y'], neg:['{O} n']};
    };
    return {name:'r', unit:'', cur:'', ctx:['c'], names:{f:['A','B','C','D'], l:['E','F','G','H']},
            traits, segs:[seg('S1',0.5), seg('S2',0.5)]};
  };
  const rangeRate = (mkt, sign, engageN) => {
    const load = {}; E.dims(mkt).forEach(d => { load[d.key] = 0; });
    mkt.traits.slice(0, engageN).forEach(tr => { load[tr.key] = sign; });   // engage only a few
    return E.simulate({markets:{m:mkt}, marketKey:'m', question:'Q', type:'policy', opts:['X'],
      segsOn:[true,true], popN:12000, seed:4, agentsShown:4000, loadings:{X:load}}).popRate[0];
  };
  const rWide = rangeMkt(8);   // 8 custom dims, engage just 2
  const hiR = rangeRate(rWide, 0.9, 2), loR = rangeRate(rWide, -0.9, 2);
  ok(hiR > 0.72 && loR < 0.28,
     'a strong signal on 2 of ~14 dimensions still separates the verdict (' + (hiR*100).toFixed(0) + '% vs ' + (loR*100).toFixed(0) + '%) — not diluted to 50%');
  ok(hiR - loR > 0.45, 'the favourable and opposing stimuli span a wide range, not a compressed band');
  // a neutral stimulus lands near 50 — the range is real, not a constant offset
  const midR = E.simulate({markets:{m:rWide}, marketKey:'m', question:'Q', type:'policy', opts:['X'],
    segsOn:[true,true], popN:12000, seed:4, agentsShown:4000, loadings:{X:(()=>{const o={};E.dims(rWide).forEach(d=>o[d.key]=0);return o;})()}}).popRate[0];
  ok(midR > 0.42 && midR < 0.60, 'a neutral stimulus lands near 50% (' + (midR*100).toFixed(0) + '%)');

  /* ----------------------------------------- ephemeral personas (Change 9) */
  G('Ephemeral personas');
  const bigNames = {f: Array.from({length:40}, (_,i)=>'F'+i), l: Array.from({length:30}, (_,i)=>'L'+i)};
  const nameMkt = Object.assign({}, market(), {names: bigNames});
  const nameCfg = over => Object.assign({markets:{m:nameMkt}, marketKey:'m', question:'Q', type:'product', opts:['X'], segsOn:[true,true], popN:12000, seed:1, agentsShown:260}, over||{});
  const names1 = E.buildAgents(nameCfg()).map(a => a.name);
  ok(new Set(names1).size === names1.length, 'names are unique within a run when the pool is large enough (N=260)');
  const names1b = E.buildAgents(nameCfg({seed:1})).map(a => a.name);
  const names2 = E.buildAgents(nameCfg({seed:2})).map(a => a.name);
  ok(names1.join('|') === names1b.join('|'), 'the same seed reproduces the same personas exactly');
  ok(names1.join('|') !== names2.join('|'), 'a new seed draws different personas');

  /* ----------------------------------------- verbatim bank (Change 3) */
  G('Trait-matched verbatims');
  const bankMkt = JSON.parse(JSON.stringify(market()));
  bankMkt.segs[0].bank = [
    {driver:'skeptic', valence:'neg', text:'{O}? "Clean" is just a marketing word.'},
    {driver:'price',   valence:'pos', text:'{O} is a fair price for what it is.'},
    {driver:'trust',   valence:'pos', text:'I already trust the brand, so {O} is fine.'},
    {driver:'effort',  valence:'neg', text:'Switching to {O} is more hassle than it is worth.'}
  ];
  const bankR = E.simulate(cfg({markets:{m:bankMkt}, opts:['$4','$8','$16']}));
  const bankAgent = bankR.agents.find(a => a.seg === 0);
  const bq = E.pickQuote(bankAgent, 0, bankR.opts);
  ok(bq.indexOf('{O}') === -1 && bq.indexOf('$4') >= 0, 'a bank quote has the option substituted in');
  const wantValence = bankAgent.yes[0] ? 'pos' : 'neg';
  const allowedTexts = bankMkt.segs[0].bank.filter(b => b.valence === wantValence).map(b => b.text.replace(/\{O\}/g, '$4'));
  ok(allowedTexts.length === 0 || allowedTexts.indexOf(bq) >= 0, 'the bank quote matches the agent\'s verdict valence');
  const noBankAgent = bankR.agents.find(a => a.seg === 1);   // segment 1 has no richer bank
  ok(E.pickQuote(noBankAgent, 0, bankR.opts) === E.quoteFor(noBankAgent, 0, bankR.opts),
     'with no bank, pickQuote falls back to the pos/neg pair');

  // Bank generation contract (the model side of Change 3).
  const bp = E.bankPrompt('Which claim?', ['A','B'], {n:'Seg', b:'desc'}, E.dims(market()));
  ok(/\{O\}/.test(bp) && /bank/i.test(bp), 'the bank prompt asks for {O}-tagged quotes in a bank');
  const vb = E.validateBank([
    {driver:'skeptic', valence:'neg', text:'{O}? no way.'},
    {driver:'price', valence:'pos', text:'{O} is fair for what it is.'},
    {driver:'bogus', valence:'pos', text:'{O} works for me even so.'},        // unknown driver
    {driver:'trust', valence:'pos', text:'no option token here so this drops'},
    {driver:'social', valence:'weird', text:'{O} — everyone I know has it.'}   // bad valence
  ], E.dims(market()));
  ok(vb.length === 4, 'a quote that never references the option is dropped; the rest kept');
  ok(vb.every(q => q.text.indexOf('{O}') >= 0), 'every kept quote references the option');
  ok(vb.every(q => q.driver !== 'bogus'), 'an unknown driver is remapped to a real dimension');
  ok(vb.every(q => q.valence === 'pos' || q.valence === 'neg'), 'valence is normalised to pos/neg');

  /* ----------------------------------------- replicate bootstrap (Change 8) */
  G('Replicate bootstrap');
  const boot = E.bootstrap(cfg({opts:['$4','$8','$16']}), {replicates: 12, n: 600});
  ok(boot.replicates === 12 && boot.winShare.length === 3, 'the bootstrap returns a win-share per option');
  ok(Math.abs(boot.winShare.reduce((a,b)=>a+b,0) - 1) < 1e-9, 'win shares sum to 1');
  ok(boot.dist.every(d => d.p10 <= d.median && d.median <= d.p90), 'the per-option distribution is ordered p10 ≤ median ≤ p90');
  ok(typeof boot.tie === 'boolean' && boot.primary && boot.primary.popRate, 'it exposes a win-share tie verdict and a primary run to interview');
  const bootRepro = E.bootstrap(cfg({opts:['$4','$8','$16']}), {replicates: 12, n: 600});
  ok(boot.winShare.join() === bootRepro.winShare.join(), 'the bootstrap reproduces from the same base seed');

  /* --------------------------------------------------- model output */
  G('Reading model output');
  ok(E.extractJSON('```json\n{"a":1}\n```').a === 1, 'markdown fences stripped');
  ok(E.extractJSON('Sure! {"a":2} hope that helps').a === 2, 'surrounding prose stripped');
  let threw = false; try { E.extractJSON('no json here'); } catch (e) { threw = true; }
  ok(threw, 'garbage throws rather than returning something empty');

  G('Validation — accepting good input');
  const good = {name:'Pop', segs: market().segs};
  const v = E.validateMarket(good);
  ok(v.ok, 'a well-formed population is accepted');
  ok(near(v.market.segs.reduce((a,b) => a + b.s, 0), 1), 'shares normalise to 1');
  const pct100 = {name:'Pop', segs: market().segs.map((s,i) => Object.assign({}, s, {s: i ? 40 : 60}))};
  ok(near(E.validateMarket(pct100).market.segs[0].s, 0.6), 'shares given as percentages are accepted');

  G('Validation — repairing');
  const messy = JSON.parse(JSON.stringify(market()));
  messy.segs[0].t.price = 88;                      // 0-100 scale
  delete messy.segs[1].t.trust;                    // missing trait
  messy.segs[0].pos = ['No mention of the thing at all', '{O} is a bargain.'];
  messy.segs[1].neg = ['Nothing here references it either'];
  messy.segs[0].n = 'Fans of {O}';
  messy.segs[1].urban = '70% urban';
  messy.names = {f:['Solo'], l:[]};
  const mv = E.validateMarket({name:'M', segs: messy.segs, names: messy.names, ctx: []});
  ok(mv.ok, 'repairable problems do not reject the population');
  ok(near(mv.market.segs[0].t.price, 0.88), 'a 0-100 trait is rescaled');
  ok(mv.market.segs[1].t.trust === 0.5, 'a missing trait defaults to neutral');
  ok(mv.market.segs[0].pos.length === 1 && mv.market.segs[0].pos[0].indexOf('{O}') >= 0,
     'a quote that never mentions the option is dropped when a good one exists');
  ok(mv.market.segs[1].neg[0].indexOf('{O}?') === 0,
     'when no quote mentions the option, one is reshaped into a reply rather than having the option welded on');
  ok(mv.market.segs[0].n.indexOf('{O}') === -1, 'the token is stripped from segment names');
  ok(near(mv.market.segs[1].urban, 0.7), '"70% urban" is understood');
  ok(mv.market.names.f.length >= 4 && mv.market.names.l.length >= 4, 'short name pools are padded');
  ok(mv.market.ctx.length > 0, 'missing context is filled');
  ok(mv.fix.length >= 7, 'every repair is reported (' + mv.fix.length + ')');

  G('Validation — rejecting');
  ok(!E.validateMarket(null).ok, 'null is rejected');
  ok(!E.validateMarket({segs:[]}).ok, 'a population with no segments is rejected');
  ok(!E.validateMarket({segs:[market().segs[0]]}).ok, 'one segment is not a population');
  const flat = JSON.parse(JSON.stringify(market()));
  E.TRAIT_KEYS.forEach(k => { flat.segs[0].t[k] = 0.5; flat.segs[1].t[k] = 0.5; });
  const fv = E.validateMarket({segs: flat.segs});
  ok(!fv.ok && fv.errs.join(' ').indexOf('nearly identical') >= 0,
     'segments that all behave alike are rejected — they cannot produce a segment split');

  G('Validation — custom dimensions');
  const ct = E.validateMarket({segs: market().segs, traits:[
    {key:'health', label:'Health'}, {key:'health', label:'Dup'},
    {key:'price', label:'Collides with core'}, {label:'No Key Given'}
  ]});
  ok(ct.market.traits.length === 2, 'duplicates dropped, core collision dropped, label-only key derived');
  ok(ct.market.traits.map(t => t.key).indexOf('price') === -1, 'a custom dimension cannot shadow a core trait');
  ok(ct.fix.some(f => f.indexOf('collides') >= 0), 'the collision is reported');
  ok(ct.market.segs.every(s => s.t.health !== undefined), 'every segment gets a value for the new dimension');

  G('Validation — cosmetic splits');
  const twins = JSON.parse(JSON.stringify(market()));
  twins.segs.push(Object.assign({}, twins.segs[0], {n:'Thrifty (again)'}));
  const tv = E.validateMarket({segs: twins.segs});
  ok(tv.dupes.length === 1, 'two behaviourally identical segments are detected');
  ok(tv.fix.some(f => f.indexOf('cosmetic') >= 0), 'and reported as a cosmetic split');
  const abroad = JSON.parse(JSON.stringify(market()));
  abroad.segs.push(Object.assign({}, abroad.segs[0], {n:'Thrifty FR', geo:'France'}));
  ok(E.validateMarket({segs: abroad.segs}).dupes.length === 0,
     'the same behaviour in a different country is a legitimate segment, not a duplicate');

  G('Completeness');
  ok(E.completenessGaps({segs:[{}], traits:[]}).length === 5, 'all five missing field groups are reported');
  ok(E.completenessGaps(v.market).length === 1, 'a population with demographics only lacks declared dimensions');
  ok(E.completenessGaps(ct.market).length === 0, 'nothing is reported when the population is complete');

  G('Population / decision coherence');
  const snacks = Object.assign({}, market(), {name:'Snack buyers', brief:'people who buy imported snacks', frame:''});
  ok(E.coherenceWarning(snacks, 'Which AI clinical documentation feature ships first?', ['ambient notes']) !== null,
     'an unrelated decision is flagged');
  ok(E.coherenceWarning(snacks, 'How should we price the imported snack range?', ['$3']) === null,
     'a related decision passes');
  ok(E.coherenceWarning(market(), 'anything at all', ['x']) === null,
     'built-in populations never warn — only ones generated from a brief');

  /* ----------------------------------------------------------- ledger */
  G('Calibration ledger');
  ok(E.ledgerStats([]) === null, 'no closed predictions means no statistics');
  ok(E.ledgerStats([{predicted:.5, ci:.02, outcome:null}]) === null, 'open predictions are not scored');
  const rows = [
    {predicted:0.50, ci:0.03, outcome:{observed:0.52}},   // +2pt, inside
    {predicted:0.60, ci:0.02, outcome:{observed:0.55}},   // -5pt, outside
    {predicted:0.40, ci:0.05, outcome:{observed:0.43}}    // +3pt, inside
  ];
  const st = E.ledgerStats(rows);
  ok(st.n === 3, 'closed predictions are counted');
  ok(near(st.mae, (0.02 + 0.05 + 0.03) / 3, 1e-12), 'mean absolute error');
  ok(near(st.bias, (0.02 - 0.05 + 0.03) / 3, 1e-12), 'bias keeps its sign');
  ok(st.inside === 2 && near(st.coverage, 2/3), 'coverage counts outcomes inside the stated interval');

  G('Outcome entry');
  ok(E.parseOutcome('58.4') === 0.584, 'a percentage becomes a fraction');
  ok(E.parseOutcome('0') === 0, 'zero is a legitimate outcome');
  ok(E.parseOutcome('') === null, 'empty is rejected — Number("") is 0 and would record a false result');
  ok(E.parseOutcome('   ') === null, 'whitespace is rejected');
  ok(E.parseOutcome('abc') === null, 'non-numeric is rejected');
  ok(E.parseOutcome('-5') === null, 'negative is rejected');
  ok(E.parseOutcome('101') === null, 'above 100 is rejected');
  ok(E.parseOutcome(undefined) === null, 'undefined is rejected');

  return {passed, failed, log};
}

return {run};
});

/* auto-run under Node */
if (typeof module !== 'undefined' && require.main === module) {
  const res = module.exports.run();
  let group = '';
  res.log.forEach(l => {
    if (l.type === 'group'){ group = l.text; console.log('\n' + l.text); }
    else console.log((l.type === 'pass' ? '  ok   ' : '  FAIL ') + l.text);
  });
  console.log('\n' + res.passed + ' passed, ' + res.failed + ' failed');
  process.exit(res.failed ? 1 : 0);
}
