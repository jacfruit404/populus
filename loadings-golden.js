#!/usr/bin/env node
/* Golden-set calibration for stimulus loadings — the one component unit tests
 * can't reach, because it depends on a live model reading a claim.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node loadings-golden.js
 *   POPULUS_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=... node loadings-golden.js
 *
 * Ten hand-labelled stimuli, each with the ENGAGEMENT direction that is
 * unambiguous on specific dimensions (see engine.js loadingsPrompt: the loading
 * is how strongly the option invokes a dimension, NOT whether people will like
 * it). For every labelled dimension we assert the model's loading has the
 * expected sign. A sign flip here is the silent-inversion bug — a well-formed
 * vector validateLoadings accepts but that contribs() then reads backwards.
 *
 * Exits non-zero if any labelled sign disagrees. Run it after changing the
 * prompt, and whenever you point the app at a new model.
 */
'use strict';
const Engine = require('./engine.js');

const KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const MODEL = (process.env.POPULUS_MODEL || 'claude-opus-5').trim();
const dimList = Engine.dims({});                 // the six core dimensions
const NEUTRAL = 0.12;                            // |loading| below this is "no clear engagement"

// Direction is ENGAGEMENT, not valence: +1 the option strongly invokes the
// dimension, -1 it pushes the opposite way. Only unambiguous dimensions labelled.
const GOLDEN = [
  {q:'Which claim leads the box?', opt:'Miracle overnight cure — results 100% guaranteed',
   type:'message', expect:{skeptic:+1}},                              // extraordinary claim invites scrutiny
  {q:'Which claim leads the box?', opt:'Endorsed by the FDA and 40 years of clinical research',
   type:'message', expect:{trust:+1}},                               // cites institutions/authority
  {q:'Which claim leads the box?', opt:'Join the 3 million people already switching',
   type:'message', expect:{social:+1}},                              // peer / crowd proof
  {q:'Which claim leads the box?', opt:'A quiet tool for people who prefer to work alone',
   type:'message', expect:{social:-1}},                              // anti-crowd
  {q:'Which feature first?', opt:'A radically new AI workflow nobody has tried before',
   type:'product', expect:{novelty:+1}},                             // new / cutting-edge
  {q:'Which feature first?', opt:'The same trusted process you have relied on for twenty years',
   type:'product', expect:{novelty:-1}},                             // familiar / traditional
  {q:'Which onboarding?', opt:'Switch in one click — no migration, no retraining',
   type:'product', expect:{effort:-1}},                              // frictionless (low switching effort)
  {q:'Which onboarding?', opt:'Requires a full team retraining and a data migration',
   type:'product', expect:{effort:+1}},                              // demands change/effort
  {q:'Which offer leads?', opt:'Half the price of every competitor',
   type:'message', expect:{price:+1}},                               // price / value front and centre
  {q:'Which offer leads?', opt:'Trusted by hospitals and reviewed by dermatologists',
   type:'message', expect:{trust:+1}}
];

async function loadingsFor(stim){
  const prompt = Engine.loadingsPrompt(stim.q, stim.opt, stim.type, dimList);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'x-api-key':KEY, 'anthropic-version':'2023-06-01', 'content-type':'application/json'},
    body: JSON.stringify({model:MODEL, max_tokens:512, thinking:{type:'disabled'},
      system:'You score how strongly one option engages each dimension. Return raw JSON only.',
      messages:[{role:'user', content:prompt}]})
  });
  if(!r.ok) throw new Error('Anthropic ' + r.status + ': ' + (await r.text()).slice(0,200));
  const j = await r.json();
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const v = Engine.validateLoadings(Engine.extractJSON(text), dimList);
  if(!v.ok) throw new Error('rejected: ' + v.errs.join('; '));
  return v.loadings;
}

(async () => {
  if(!KEY){ console.error('Set ANTHROPIC_API_KEY to run the golden set.'); process.exit(2); }
  console.log('Golden loadings — model: ' + MODEL + '\n');
  let checks = 0, wrongSign = 0, weak = 0;
  for(const stim of GOLDEN){
    let load;
    try { load = await loadingsFor(stim); }
    catch(e){ console.log('  ERR  "' + stim.opt.slice(0,48) + '" — ' + e.message); wrongSign++; continue; }
    for(const dim of Object.keys(stim.expect)){
      checks++;
      const got = load[dim], want = stim.expect[dim];
      const signOk = Math.sign(got) === Math.sign(want);
      const strong = Math.abs(got) >= NEUTRAL;
      const tag = !signOk ? 'FLIP' : !strong ? 'weak' : ' ok ';
      if(!signOk) wrongSign++; else if(!strong) weak++;
      console.log('  ' + tag + '  ' + dim.padEnd(8) + ' want ' + (want>0?'+':'-') +
                  '  got ' + (got>=0?'+':'') + got.toFixed(2) + '   "' + stim.opt.slice(0,44) + '"');
    }
  }
  console.log('\n' + checks + ' checks · ' + wrongSign + ' sign flips · ' + weak + ' weak (|loading|<' + NEUTRAL + ')');
  if(wrongSign) console.log('SIGN FLIPS PRESENT — loadings read backwards on those dimensions.');
  process.exit(wrongSign ? 1 : 0);
})();
