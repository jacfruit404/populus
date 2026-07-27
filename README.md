Update readme · SH
#!/bin/bash
# Populus README updater. Finds the repo, writes the new README, shows the diff.
# Does NOT commit. You review, then commit yourself.
set -e
 
REPO=""
for c in "$HOME/Developer/populus" "$HOME/populus" "$HOME/Documents/populus" "$HOME/Desktop/populus"; do
  [ -d "$c/.git" ] && [ -f "$c/engine.js" ] && REPO="$c" && break
done
if [ -z "$REPO" ]; then
  REPO=$(find "$HOME" -maxdepth 4 -type d -name populus -not -path '*/Library/*' -not -path '*/.*/*' 2>/dev/null \
         | while read -r d; do [ -d "$d/.git" ] && [ -f "$d/engine.js" ] && echo "$d" && break; done)
fi
if [ -z "$REPO" ]; then
  echo "Could not find the populus repo. Run this from inside it instead:"
  echo "  bash <this-script> ."
  exit 1
fi
 
cd "$REPO"
echo "Repo:   $REPO"
echo "Branch: $(git rev-parse --abbrev-ref HEAD)"
if [ "$(git rev-parse --abbrev-ref HEAD)" != "version2" ]; then
  echo "Not on version2. Aborting so nothing lands on the wrong branch."
  exit 1
fi
 
cat > README.md <<'POPULUS_README_END'
# Populus
 
**Test a decision against a simulated population before you commit to it.**
 
You are about to set a price, pick a launch feature, choose a claim for the
packaging, or push a policy. Populus builds a population of synthetic people,
reads your options, runs them past each person, and tells you what is likely to
happen: which segments drive the result, how much the answer depends on which
people you happened to draw, and where it is too close to call.
 
Runs entirely on your machine. No accounts, no API keys, no data leaves the box.
 
---
 
## Quick start
 
Requires Python 3 (already on macOS and most Linux) and a browser.
 
```bash
git clone git@github.com:jacfruit404/populus.git
cd populus
./serve.sh
```
 
Open **http://localhost:8765**.
 
> Open it through the server, not by double-clicking `index.html`. A page opened
> from `file://` cannot talk to a local model. See [Troubleshooting](#troubleshooting).
 
Four presets load instantly, so you can click through a full run before setting
anything up.
 
---
 
## How it works
 
Four steps, top to bottom.
 
**1 · Frame the decision.** Pick a type (pricing, product, messaging or policy),
write the question you are actually asking, and list the options you are
choosing between.
 
**2 · Build the population.** Choose a market, include or exclude segments, set
the sample size. Four markets ship with the app; you can generate your own with
a local model.
 
**3 · Run.** Each option is scored against the behavioural dimensions, then
twenty independent populations are drawn and every agent in each one responds
under its own constraints.
 
**4 · Read the prediction.**
 
| Tab | What it shows |
|---|---|
| Segment response | How each segment answers, and where a segment's best option disagrees with the population's. That disagreement is the trade-off hiding in your decision |
| What moved it | The winner decomposed against the runner-up, dimension by dimension |
| Voices | Individual agents responding in their own words, each quote matched to the dimension that actually moved that person |
| The population | Every agent as a square, coloured by segment, solid if they would say yes. Click one to inspect them |
| Calibration | Predictions you have committed, scored against what actually happened |
 
### Reading the result
 
The headline names the option most likely to win and, more usefully, **how often
it wins**. Twenty independent populations are drawn per run, with fresh people
each time, and the result reports how many of them the leader took, along with
the median rate and the 10th to 90th percentile spread.
 
> Across **20 independent draws**, fresh people each time, **Option A** wins
> **17 of 20**, 52.4% median (10th–90th 48.1–56.9%).
 
That is the honest form of the question. A winner that takes 19 of 20 draws is
robust to who you happened to survey. A winner that takes 11 of 20 is not a
winner, and the app says **Too close to call** and badges both options joint
first rather than manufacturing a result.
 
For pricing, the ranking runs on revenue, not on the buy rate, because revenue
is the decision metric.
 
**Draw a new sample** re-rolls the base seed, which redraws all twenty
populations. If the win share barely moves, the result is real. If it swings,
it was never there.
 
### Pricing across billing periods
 
A pricing option can carry a period: `$9/month`, `$96/year`, `$249 flat`. The
number alone is not the price, so options are put on one footing before they are
ranked: expected revenue per converting customer over a comparison horizon.
 
- Monthly plans are annualised and discounted by an expected retention share,
  since a monthly subscriber can leave. That freedom is also what makes a
  monthly plan an easier yes, and the model reflects both sides.
- Yearly plans renew across the horizon. One-time and unspecified prices are
  counted as a single purchase.
 
The horizon (3 years by default) and the retention assumption (70% by default)
are shown in the results panel and are editable there. They are assumptions, not
findings, so the app states them rather than burying them. A bare number with no
stated period is flagged when it sits next to a subscription.
 
---
 
## Generating populations with a local model
 
Populus can build a population from a sentence. It talks to
[Ollama](https://ollama.com) on `http://127.0.0.1:11434`, or any
OpenAI-compatible local server. Point the endpoint field at LM Studio or
llama.cpp instead if you prefer.
 
```bash
ollama pull qwen2.5:14b     # ~9GB; any instruct model works
./serve.sh
```
 
Step 2 detects the server, lists your models, and shows a connection light.
 
**Generate new** describes an audience:
 
> *consumers across China, Japan, South Korea, Singapore and Indonesia who buy
> imported American snacks; include familiarity with American brands, health
> consciousness, and trust in imported products as dimensions*
 
**Edit current** hands the population on screen back with an instruction:
 
> *split the price-sensitive segment into renters and owners, and lower
> willingness to pay by a third*
 
The original is never modified. Edits land as a new population.
 
### What the model is and is not allowed to do
 
The model does three jobs, and all three are inputs to the maths rather than the
maths itself.
 
1. **It writes the population.** Who exists, how they behave, what they would
   pay.
2. **It scores the options.** For each option, how strongly that option engages
   each behavioural dimension. This is a judgement about what a claim *means*,
   which is the one thing arithmetic cannot do.
3. **It writes the verbatim banks.** Twenty to thirty quotes per segment, each
   tagged with the dimension that drives it.
 
The model never touches the simulation. Willingness-to-pay curves, the revenue
horizon, the replicate spread, the tie test and the ledger all stay in ordinary
auditable code. A model that could also invent the maths would produce numbers
nobody could check.
 
Output is validated rather than trusted. Common problems are repaired and
reported in the panel log:
 
- traits given on a 0 to 100 scale, rescaled
- missing traits, defaulted
- quotes that never mention the option, dropped
- shares that do not sum to 1, renormalised
- a "split" that produced two behaviourally identical segments, flagged as cosmetic
- option scores outside the -1 to 1 range, clamped, with every repair reported
 
A population whose segments all score alike is rejected outright. It looks like
a population but cannot produce a meaningful segment split. Populus also warns
if you point a decision at a population built for something else, since the
traits and prices would be meaningless.
 
**If no model is reachable**, option scores fall back to a hash of the option
text. That fallback is loud and flagged on the result, never silent, because a
hash cannot read a claim and any non-pricing result computed that way is noise.
 
### Option scoring is a model judgement
 
This is the one place where a model's reading enters the number, so it gets its
own check. `loadings-golden.js` sends ten hand-labelled stimuli whose direction
is unambiguous and asserts the model scored each one with the right sign:
 
```bash
ANTHROPIC_API_KEY=sk-ant-... node loadings-golden.js
POPULUS_MODEL=... ANTHROPIC_API_KEY=... node loadings-golden.js
```
 
It exits non-zero on any sign disagreement. Run it after changing the scoring
prompt, and whenever you point the app at a different model. A sign flip here is
silent: it produces a well-formed vector that the engine then reads backwards.
 
### Custom dimensions
 
Beyond six core behavioural traits (price sensitivity, novelty appetite, trust,
scepticism, switching friction, social proof) a population can declare its own
dimensions, and they enter the model exactly like the built-in ones. Mark one
`"invert": true` when a high score pushes *against* the option. Health
consciousness resists a snack.
 
Segments also carry country, age range, income and urban share, and agents
inherit them.
 
### People inside a segment are not identical
 
Every agent is a point in trait space, not its segment shifted along a single
axis. Each one draws its own value on every dimension around the segment mean,
so two Value Maximizers genuinely differ. Age and urban status nudge specific
traits, which is what makes the demographics load-bearing rather than
decorative, and the nudges are centred so the segment mean still reproduces.
 
A population can set `sigma` to widen or narrow that spread, either as one
number for all dimensions or as an object keyed by dimension. The default is
modest but never zero, so no segment is ever unanimous. A model that cannot
produce a dissenter is not modelling people.
 
---
 
## The calibration ledger
 
A model that is not scored against outcomes is a dashboard.
 
**Commit** a prediction when you actually ship the decision. The record freezes
the question, the winning option, the predicted rate, the interval, the seed and
the population. It cannot be edited afterwards. Only an outcome can be added.
 
**Close** it when you know what happened. Three numbers accumulate:
 
- **Mean absolute error**, how wrong the model is on average
- **Bias**, whether it systematically over- or under-predicts
- **Interval coverage**, whether the intervals mean anything
 
Coverage is the one to watch. If the 95% intervals are honest, about 95% of
outcomes should land inside them. Much lower means the model is overconfident
and the intervals are decoration.
 
> **Known gap.** The ledger currently freezes a single population's rate and the
> closed-form 95% interval, not the median and 10th-to-90th spread the headline
> reports. Those are different numbers with different coverage targets, so the
> committed prediction is presently narrower and less informative than what the
> app shows on screen. Treat committed intervals as provisional until this is
> reconciled.
 
Predictions are written to `ledger.json` beside the app: plain text, atomically
written, and gitignored so your decisions stay private. The ledger starts empty
and says so. Until several predictions are closed, the model has no track record
and its numbers deserve no particular trust.
 
---
 
## Tests
 
The ledger scores the model's predictions. The tests score the code that
produces them. An engine with an off-by-one would let the ledger faithfully
record well-calibrated garbage.
 
```bash
node engine.test.js               # headless, exits non-zero on failure
```
 
No Node? The same suite runs in the browser at
**http://localhost:8765/test.html**. Same file, no framework, no dependencies.
 
178 assertions covering the invariants that matter:
 
- the headline rate equals the share-weighted segment rates, exactly
- raising a price never raises demand, at population and segment level
- a monthly plan is compared on annualised value, not on its monthly number
- supplied option scores are used, and the hash fallback is always flagged
- the scoring prompt never mentions invert or resist, which caused a silent sign inversion
- adding a custom dimension does not perturb the existing ones
- inverted traits resist; neutral segments contribute nothing
- agents draw their own trait vectors, and segment means still reproduce
- names are unique within a run when the pool is large enough
- a bank quote matches the agent's verdict, and falls back cleanly with no bank
- the bootstrap returns a win share per option and reproduces from the same base seed
- the same seed reproduces a prediction; a new seed draws a new sample
- agents inherit their segment's age band, income, country and urban share
- every repair, rejection and warning in the validators
- `parseOutcome('')` is rejected rather than silently recorded as 0%
 
They assert *invariants*, not today's numbers, so retuning coefficients does not
break them. Breaking the model does.
 
## Adding a market by hand
 
Everything about the built-in populations lives in the `MARKETS` object near the
top of the script block in `index.html`. Each segment carries:
 
```js
{
  n: 'Value Maximizers',              // name
  s: 0.31,                            // share of the market
  b: 'Shop the unit price…',          // one-line description
  t: { price:.88, novelty:.28, trust:.42,
       skeptic:.62, effort:.35, social:.30 },   // traits, 0–1
  wtp: 6.20, sd: 1.80,                // willingness to pay, mean and spread
  pos: ['At {O} I would switch.'],    // fallback quotes; {O} is the option under test
  neg: ['{O} is a lot for dish soap.']
}
```
 
A market may also set `sigma` to control within-segment spread, and `traits` to
declare custom dimensions. Verbatim banks are generated at run time and are not
stored in the market definition; `pos` and `neg` are the fallback used when no
model is reachable.
 
That is the only place you need to touch. The simulation itself (`zAffinity`,
`segZ`, `buildAgents`, `simulate`, `bootstrap`, `validateMarket`) lives in
`engine.js`, which is pure logic with no DOM, no globals and no network. That
separation is what makes it testable, and it is the same boundary the model
respects: the model writes populations, scores options and drafts quotes, and
the engine decides what any of it means.
 
---
 
## Troubleshooting
 
**The model panel says "Not reachable".**
The page is almost certainly running from `file://`. Check the address bar reads
`http://localhost:8765`. A page loaded from a file sends `Origin: null`, and
Ollama returns 403 to that; from localhost it returns 200. If the address is
right, press **Reconnect**. The probe only runs automatically the first time you
reach step 2.
 
**"No models installed".**
Ollama is running but empty. `ollama pull qwen2.5:14b`.
 
**The result carries a fallback warning.**
No model was reachable when the run started, so option scores came from a hash
of the option text rather than from reading it. Pricing is still meaningful,
because willingness to pay is real economics. Messaging, product and policy
results are not. Reconnect and run again.
 
**Opening `index.html` in TextEdit shows a blank page.**
The file is fine. TextEdit renders HTML rather than showing source, and this
page's body is built by JavaScript, which TextEdit does not run. Use a code
editor, or `cat index.html`, or TextEdit → Settings → Open and Save → *Display
HTML files as HTML code*.
 
**Port 8765 is busy.**
`./serve.sh 9000`, or free it with `lsof -ti:8765 | xargs kill`.
 
**The ledger says "browser storage only".**
Something other than `serve.sh` is serving the page, and it cannot accept the
write. Predictions will not survive clearing site data.
 
---
 
## What this is not
 
Populus is a working prototype, not a validated research instrument.
 
- **The four built-in markets are hand-authored.** The machinery is real; the
  numbers in them are illustrative and were not fitted to data. The name and
  context lists are hand-written filler, not sampled from any register.
- **Model-generated populations are plausible fiction** until grounded in
  something. They are a fast way to think, not evidence.
- **Option scores are a model's reading of your claim.** They are the one
  judgement call inside the number. `loadings-golden.js` checks the direction is
  right, but it has to be run against whichever model you actually use, and a
  small local model will score more crudely than a large one.
- **Verbatims are the weakest output.** Generated banks are a large improvement
  on the two-quote fallback, but a 14B model still writes flat quotes. A larger
  model helps; the schema cannot.
- **The population you see is drawn separately from the twenty that are
  counted.** The grid, the segment table and the voices come from their own
  draw, so they illustrate the result rather than constituting it.
- **The committed interval is not the measured one.** See the known gap in the
  ledger section above.
- **Outcomes are typed in by hand.** Nothing stops you entering a figure that
  flatters the model. Self-reported calibration beats none, but a real version
  would read from till or billing data.
- **Everything except the ledger is in memory.** Reloading clears run history
  and any generated populations.
 
Take it as a structured way to reason about who a decision lands on and where it
is genuinely uncertain, not as a substitute for asking real people.
 
---
 
## Layout
 
```
index.html          the interface: markup, styles, rendering
engine.js           the simulation: pure logic, no DOM, no network
engine.test.js      178 assertions against engine.js
test.html           browser runner for the same suite
loadings-golden.js  sign check for option scoring, needs a live model
serve.py            static server plus the ledger read/write API
serve.sh            checks Ollama, then starts serve.py
ledger.json         your committed predictions (created on first commit, gitignored)
```
 
No build step, no dependencies, no bundler. `index.html` loads `engine.js` with
a plain `<script>` tag; `engine.js` also loads under Node with `require`, which
is how the same test file runs in both places.
POPULUS_README_END
 
echo
git --no-pager diff --stat
echo
echo "Review the diff above, then run:"
echo "  cd \"$REPO\""
echo "  git add README.md"
echo "  git commit -m 'docs: rewrite README for v2 (loadings, replicate bootstrap, billing periods)'"
echo "  git push origin version2"
 
