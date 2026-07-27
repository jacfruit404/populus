#!/usr/bin/env node
/* Retrodiction benchmark — the only honest answer to "how do you know it works".
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node benchmark.js
 *   POPULUS_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=... node benchmark.js
 *
 * Forty-odd public survey items with published marginals, encoded as decisions
 * and scored against the KNOWN human answer. This is calibration on day one —
 * the calibration ledger cannot start until a real decision ships, this cannot
 * wait. It also catches the failure the ledger never would: an engine pinned at
 * ~52% cannot reproduce an 88/12 split, so the headline metric here is the
 * COMPRESSION RATIO — sd(predicted) / sd(actual). ~1.0 means the engine spans
 * the real range; << 1 means it flattens everything toward the middle.
 *
 * Toplines are approximate published figures (Pew / Gallup / GSS, recent years)
 * and drift year to year — verify against the cited source before trusting a
 * single row. The benchmark's value is the SPREAD and the CORRELATION, which are
 * robust to a few points of error in any one topline. Pricing rows are
 * willingness-to-pay anchors, not survey marginals — lower-confidence, and there
 * to exercise the WTP curve across price points.
 *
 * Non-pricing rows need a model (they resolve stimulus loadings the same way the
 * app does). Pricing rows run on the WTP term and need no model.
 */
'use strict';
const E = require('./engine.js');

const KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.POPULUS_MODEL || 'claude-opus-5').trim();

/* -------------------------------------------------------------- populations */

// A US general-public population with values/belief dimensions. Attitudes turn
// on these, not on the consumer core six (which the model will score ~0).
const PUBLIC = {
  name:'US adults', universe:'≈258M', unit:'', cur:'', frame:'general-public panel',
  ctx:['works full time','retired','raising kids','renting','small town','big city','commutes by car'],
  names:{f:['Dana','Marcus','Priya','Kelly','Ruben','Alicia','Trevor','Nadia','Curtis','Sofia','Malik','Erin','Diego','Bethany','Grant','Yara'],
         l:['Whitfield','Okafor','Delgado','Brennan','Nakamura','Sanders','Vasquez','Holloway','Pierce','Mensah','Freeman','Alvarado','Nguyen','Bishop','Castillo','Rivera']},
  traits:[
    {key:'prog',     label:'Social progressivism'},
    {key:'econleft', label:'Economic redistribution'},
    {key:'liberty',  label:'Personal-freedom / anti-state'},
    {key:'relig',    label:'Religiosity'},
    {key:'populist', label:'Anti-establishment'}
  ],
  segs:[
    seg('Progressive', 0.26, {prog:.88, econleft:.82, liberty:.60, relig:.20, populist:.50}, '25-45', .82),
    seg('Liberal-lean',0.16, {prog:.68, econleft:.62, liberty:.55, relig:.35, populist:.45}, '25-55', .70),
    seg('Moderate',    0.22, {prog:.50, econleft:.50, liberty:.50, relig:.50, populist:.50}, '30-60', .60),
    seg('Conservative',0.28, {prog:.18, econleft:.28, liberty:.48, relig:.78, populist:.56}, '40-70', .45),
    seg('Libertarian', 0.08, {prog:.50, econleft:.20, liberty:.92, relig:.35, populist:.62}, '25-55', .55)
  ]
};

// A consumer population for adoption (product) items.
const CONSUMER = {
  name:'US consumers', universe:'≈260M', unit:'', cur:'$', frame:'consumer panel',
  ctx:['streams daily','shops online weekly','early to new apps','sticks to what works','shares everything','privacy-minded'],
  names: PUBLIC.names,
  traits:[{key:'digital', label:'Digital engagement'}],
  segs:[
    seg('Digital natives', 0.30, {novelty:.82, social:.80, trust:.55, skeptic:.35, effort:.30, digital:.92}, '18-34', .85),
    seg('Mainstream',      0.42, {novelty:.50, social:.55, trust:.55, skeptic:.50, effort:.50, digital:.55}, '30-55', .62),
    seg('Late adopters',   0.28, {novelty:.22, social:.35, trust:.55, skeptic:.62, effort:.70, digital:.22}, '50-75', .40)
  ]
};

function seg(n, s, extra, age, urban){
  const t = {price:.5, novelty:.5, trust:.5, skeptic:.5, effort:.5, social:.5};
  Object.keys(extra).forEach(k => { t[k] = extra[k]; });
  return {n, s, b:n, age, urban, income:'middle', geo:'US', t, wtp:10, sd:3,
          pos:['{O}? yes, that speaks to me.'], neg:['{O}? no, not for me.']};
}

/* -------------------------------------------------------------------- items */
// { type, q, opt, actual, src }.  actual = published share (0-1) that agree/favor/use/buy.

const ITEMS = [
  // ---- POLICY: favor/oppose, general public ---------------------------------
  {type:'policy', q:'Do you favor requiring background checks for all gun buyers?', opt:'Require background checks for all gun sales', actual:0.88, src:'Pew/Gallup ~85-90'},
  {type:'policy', q:'Should same-sex marriage be legally recognized?', opt:'Same-sex marriage should be legal', actual:0.70, src:'Gallup 2023 ~71'},
  {type:'policy', q:'Should recreational marijuana be legal?', opt:'Legalize recreational marijuana', actual:0.68, src:'Gallup/Pew ~68-70'},
  {type:'policy', q:'Should abortion be legal in all or most cases?', opt:'Abortion legal in all or most cases', actual:0.62, src:'Pew ~62'},
  {type:'policy', q:'Do you favor the death penalty for people convicted of murder?', opt:'Death penalty for murder', actual:0.53, src:'Gallup ~53'},
  {type:'policy', q:'Should the federal minimum wage be raised to $15/hour?', opt:'Raise the federal minimum wage to $15', actual:0.62, src:'Pew ~62'},
  {type:'policy', q:'Is it the government’s responsibility to ensure health coverage for all?', opt:'Government should guarantee health coverage', actual:0.57, src:'Gallup ~57'},
  {type:'policy', q:'Should voters be required to show photo ID to vote?', opt:'Require photo ID to vote', actual:0.80, src:'Pew/Gallup ~80'},
  {type:'policy', q:'Do you favor term limits for members of Congress?', opt:'Term limits for Congress', actual:0.83, src:'Pew ~83'},
  {type:'policy', q:'Do you trust the federal government to do what is right most of the time?', opt:'Trust the federal government most of the time', actual:0.20, src:'Pew ~20'},
  {type:'policy', q:'Should there be a path to citizenship for undocumented immigrants?', opt:'A path to citizenship for undocumented immigrants', actual:0.65, src:'various ~60-70'},
  {type:'policy', q:'Do you favor stricter gun laws overall?', opt:'Stricter gun laws overall', actual:0.57, src:'Gallup ~56-58'},

  // ---- MESSAGE / BELIEF: agree/believe, general public ----------------------
  {type:'message', q:'Which statement resonates?', opt:'I believe in God', actual:0.81, src:'Gallup ~81'},
  {type:'message', q:'Which statement resonates?', opt:'I believe in heaven', actual:0.67, src:'Pew ~67-73'},
  {type:'message', q:'Which statement resonates?', opt:'I attend religious services about weekly', actual:0.30, src:'PRRI/Gallup ~30'},
  {type:'message', q:'Which statement resonates?', opt:'Human activity is the main driver of climate change', actual:0.60, src:'Pew ~60'},
  {type:'message', q:'Which statement resonates?', opt:'Astrology has some scientific basis', actual:0.28, src:'GSS/NSF ~25-30'},
  {type:'message', q:'Which statement resonates?', opt:'Ghosts are real', actual:0.40, src:'various ~36-46'},
  {type:'message', q:'Which statement resonates?', opt:'Humans evolved over time', actual:0.68, src:'Pew ~68'},
  {type:'message', q:'Which statement resonates?', opt:'The economic system is rigged against people like me', actual:0.60, src:'populist-index ~55-65'},
  {type:'message', q:'Which statement resonates?', opt:'I have a fair amount of confidence in scientists', actual:0.73, src:'Pew ~73'},
  {type:'message', q:'Which statement resonates?', opt:'Success in life is mostly determined by forces outside our control', actual:0.38, src:'Pew ~38'},
  {type:'message', q:'Which statement resonates?', opt:'Religion is very important in my life', actual:0.45, src:'Gallup ~45-49'},

  // ---- PRODUCT / ADOPTION: % who use, consumers -----------------------------
  {type:'product', q:'Which do you use?', opt:'YouTube', actual:0.83, src:'Pew ~83'},
  {type:'product', q:'Which do you use?', opt:'Facebook', actual:0.68, src:'Pew ~68'},
  {type:'product', q:'Which do you use?', opt:'Instagram', actual:0.47, src:'Pew ~47'},
  {type:'product', q:'Which do you use?', opt:'TikTok', actual:0.33, src:'Pew ~33'},
  {type:'product', q:'Which do you use?', opt:'Online or mobile banking', actual:0.78, src:'~76-80'},
  {type:'product', q:'Which do you own?', opt:'A smart speaker (Alexa/Google Home)', actual:0.35, src:'~35'},
  {type:'product', q:'Which do you use?', opt:'A paid video streaming service', actual:0.83, src:'~83'},
  {type:'product', q:'Which do you use?', opt:'A ride-hailing app like Uber or Lyft', actual:0.36, src:'Pew ~36'},
  {type:'product', q:'Which do you own?', opt:'A wearable fitness tracker or smartwatch', actual:0.30, src:'~28-32'},
  {type:'product', q:'Which do you use?', opt:'A password manager', actual:0.32, src:'~32'},
  {type:'product', q:'Which have you done in the past year?', opt:'Read an e-book', actual:0.30, src:'Pew ~30'},

  // ---- PRICING: WTP anchors (lower confidence — a demand-curve shape check, not
  // an independent retrodiction: the engine uses WTP and we set WTP, so this
  // tests whether one WTP/sd reproduces the decline across price points, not
  // whether the level is externally correct. Flat prices, to avoid the monthly
  // annualisation the billing model applies to "/month".)
  {type:'pricing', q:'Coffee-shop latte', opt:'$5', actual:0.55, wtp:5.5, sd:2.4, src:'WTP anchor'},
  {type:'pricing', q:'Coffee-shop latte', opt:'$7', actual:0.28, wtp:5.5, sd:2.4, src:'WTP anchor'},
  {type:'pricing', q:'Coffee-shop latte', opt:'$9', actual:0.10, wtp:5.5, sd:2.4, src:'WTP anchor'},
  {type:'pricing', q:'Streaming annual pass', opt:'$120', actual:0.50, wtp:150, sd:95, src:'WTP anchor'},
  {type:'pricing', q:'Streaming annual pass', opt:'$216', actual:0.28, wtp:150, sd:95, src:'WTP anchor'},
  {type:'pricing', q:'Streaming annual pass', opt:'$300', actual:0.14, wtp:150, sd:95, src:'WTP anchor'},
  {type:'pricing', q:'Meal-kit box', opt:'$60 flat', actual:0.45, wtp:72, sd:38, src:'WTP anchor'},
  {type:'pricing', q:'Meal-kit box', opt:'$90 flat', actual:0.30, wtp:72, sd:38, src:'WTP anchor'},
  {type:'pricing', q:'Meal-kit box', opt:'$120 flat', actual:0.16, wtp:72, sd:38, src:'WTP anchor'},
  {type:'pricing', q:'Budget flight add-on (seat)', opt:'$25 flat', actual:0.40, wtp:24, sd:17, src:'WTP anchor'},
  {type:'pricing', q:'Budget flight add-on (seat)', opt:'$45 flat', actual:0.20, wtp:24, sd:17, src:'WTP anchor'}
];

/* ------------------------------------------------------------------ running */

async function loadingsFor(item, dimList){
  const prompt = E.loadingsPrompt(item.q, item.opt, item.type, dimList);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'x-api-key':KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json'},
    body: JSON.stringify({model:MODEL, max_tokens:512, thinking:{type:'disabled'},
      system:'You score how strongly one option engages each dimension. Return raw JSON only.',
      messages:[{role:'user', content:prompt}]})
  });
  if(!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0,160));
  const j = await r.json();
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const v = E.validateLoadings(E.extractJSON(text), dimList);
  if(!v.ok) throw new Error('rejected: ' + v.errs.join('; '));
  return v.loadings;
}

function pricingPop(item){
  const p = JSON.parse(JSON.stringify(CONSUMER));
  p.segs.forEach(s => { s.wtp = item.wtp; s.sd = item.sd; });   // this product's WTP
  return p;
}

async function predict(item){
  const usePop = item.type === 'pricing' ? pricingPop(item)
                : item.type === 'product' ? CONSUMER : PUBLIC;
  const dl = E.dims(usePop);
  const cfg = {markets:{m:usePop}, marketKey:'m', question:item.q, type:item.type,
               opts:[item.opt], segsOn:usePop.segs.map(()=>true), popN:20000, seed:11, agentsShown:4000};
  if(item.type !== 'pricing') cfg.loadings = {[item.opt]: await loadingsFor(item, dl)};
  const R = E.simulate(cfg);
  return {pred:R.popRate[0], ci:R.ci[0]};
}

/* ------------------------------------------------------------------ scoring */

const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
const sd = a => { const m = mean(a); return Math.sqrt(mean(a.map(x=>(x-m)*(x-m)))); };
function pearson(x, y){
  const mx=mean(x), my=mean(y);
  let n=0, dx=0, dy=0;
  for(let i=0;i<x.length;i++){ n+=(x[i]-mx)*(y[i]-my); dx+=(x[i]-mx)**2; dy+=(y[i]-my)**2; }
  return n / (Math.sqrt(dx*dy) || 1e-9);
}

function report(rows, label){
  if(!rows.length) return;
  const pred = rows.map(r=>r.pred), act = rows.map(r=>r.actual);
  const mae = mean(rows.map(r=>Math.abs(r.pred-r.actual)));
  const bias = mean(rows.map(r=>r.pred-r.actual));
  const cov = mean(rows.map(r=>Math.abs(r.pred-r.actual)<=r.ci ? 1 : 0));
  const comp = sd(pred)/(sd(act)||1e-9);
  console.log('\n' + label + ' (' + rows.length + ')');
  console.log('  MAE ' + (mae*100).toFixed(1) + 'pt · bias ' + (bias>=0?'+':'') + (bias*100).toFixed(1) +
              'pt · r ' + pearson(pred,act).toFixed(2) + ' · compression ' + comp.toFixed(2) +
              ' (want ~1.0) · coverage ' + (cov*100).toFixed(0) + '%');
}

(async () => {
  if(!KEY){ console.error('Set ANTHROPIC_API_KEY (needed for the non-pricing items).'); process.exit(2); }
  console.log('Retrodiction benchmark — model: ' + MODEL + '\n');
  console.log('  actual  pred   err   type      option');
  const done = [];
  for(const item of ITEMS){
    let p;
    try { p = await predict(item); }
    catch(e){ console.log('  ERR  ' + item.opt.slice(0,40) + ' — ' + e.message); continue; }
    const row = Object.assign({}, item, p);
    done.push(row);
    const err = row.pred - row.actual;
    console.log('  ' + (row.actual*100).toFixed(0).padStart(4) + '%  ' + (row.pred*100).toFixed(0).padStart(3) +
                '%  ' + (err>=0?'+':'') + (err*100).toFixed(0).padStart(3) + '   ' + item.type.padEnd(8) + '  ' + item.opt.slice(0,44));
  }
  for(const t of ['policy','message','product','pricing']) report(done.filter(r=>r.type===t), t.toUpperCase());
  report(done, 'ALL');
  console.log('\nCompression < ~0.6 means the engine is still flattening the range.');
  const overall = mean(done.map(r=>Math.abs(r.pred-r.actual)));
  process.exit(overall > 0.15 ? 1 : 0);   // 15pt mean error = fails the benchmark
})();
