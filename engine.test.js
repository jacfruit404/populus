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

  // The demand-side price term must see the annualised figure, or the whole
  // point of the fix is lost. wtpTerm is latent-independent, so it isolates it.
  const bSeg = E.activeSegs(market(), [true,true])[0];
  const bDims = E.dims(market()), bCfg = cfg();
  const zMo = E.segZ(bSeg, '$9/month', bCfg, bDims);
  const zYr = E.segZ(bSeg, '$108', bCfg, bDims);
  const zBare = E.segZ(bSeg, '$9', bCfg, bDims);
  ok(near(zMo.wtpTerm, zYr.wtpTerm), 'demand sees $9/month as 108, exactly like $108');
  ok(!near(zMo.wtpTerm, zBare.wtpTerm), 'and not as the bare number 9');

  G('Mixed vs uniform billing');
  const uni = E.simulate(cfg({opts:['$19/year','$39/year','$99/year']}));
  ok(!uni.incomparable && uni.second, 'a uniform-unit run ranks as normal, with a revenue index');
  const recur = E.simulate(cfg({opts:['$120/year','$9/month']}));
  ok(!recur.incomparable, 'monthly and yearly share a basis and stay comparable');
  // Revenue index must be built on the normalised price: $9/month as 108.
  const revA = recur.popRate[0]*120, revB = recur.popRate[1]*108, mx = Math.max(revA, revB);
  ok(recur.second.vals[0] === Math.round(revA/mx*100) && recur.second.vals[1] === Math.round(revB/mx*100),
     'the revenue index uses the annualised price, not the raw number');

  const mixed = E.simulate(cfg({opts:['$19/year','$9/month','$39/year','$99 Flat']}));
  ok(mixed.incomparable && mixed.incomparable.reason === 'mixed-billing',
     'recurring mixed with one-time is refused, not ranked');
  ok(mixed.second === null, 'no revenue index is produced for incomparable options');
  ok(mixed.tie === false, 'a refusal to rank is not reported as a tie');
  const bases = mixed.incomparable.groups.map(g => g.basis);
  ok(bases.indexOf('recurring') >= 0 && bases.indexOf('onetime') >= 0,
     'the refusal names the incompatible bases so the UI can show which is which');

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
