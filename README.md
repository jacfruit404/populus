# Populus

**Test a decision against a simulated population before you commit to it.**

You are about to set a price, pick a launch feature, choose a claim for the
packaging, or push a policy. Populus builds a population of synthetic people,
runs your options past each of them, and tells you what is likely to happen —
which segments drive the result, and where the answer is too close to call.

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
> from `file://` cannot talk to a local model — see [Troubleshooting](#troubleshooting).

Four presets load instantly, so you can click through a full run before setting
anything up.

---

## How it works

Four steps, top to bottom.

**1 · Frame the decision.** Pick a type — pricing, product, messaging or policy —
write the question you are actually asking, and list the options you are choosing
between.

**2 · Build the population.** Choose a market, include or exclude segments, set
the sample size. Four markets ship with the app; you can generate your own with a
local model.

**3 · Run.** Every agent responds to every option under its own constraints.

**4 · Read the prediction.**

| Tab | What it shows |
|---|---|
| Segment response | How each segment answers, and where a segment's best option disagrees with the population's — that disagreement is the trade-off hiding in your decision |
| What moved it | The winner decomposed against the runner-up, dimension by dimension |
| Voices | Individual agents responding in their own words |
| The population | Every agent as a square, coloured by segment, solid if they would say yes. Click one to inspect them |
| Calibration | Predictions you have committed, scored against what actually happened |

### Reading the result

The headline names the option most likely to win and how far clear it is. When
the gap sits inside the noise it says **Too close to call** and badges both
options as joint first, rather than manufacturing a winner. For pricing that test
runs on revenue, not on the buy rate, because revenue is the decision metric.

**Draw a new sample** re-rolls which agents get surveyed without changing the
population. If the winner flips between samples, the gap was never real — that is
the confidence interval doing its job where you can see it.

---

## Generating populations with a local model

Populus can build a population from a sentence. It talks to [Ollama](https://ollama.com)
on `http://127.0.0.1:11434`, or any OpenAI-compatible local server — point the
endpoint field at LM Studio or llama.cpp instead if you prefer.

```bash
ollama pull qwen2.5:14b     # ~9GB; any instruct model works
./serve.sh
```

Step 2 detects the server, lists your models, and shows a connection light.

**Generate new** — describe an audience:

> *consumers across China, Japan, South Korea, Singapore and Indonesia who buy
> imported American snacks; include familiarity with American brands, health
> consciousness, and trust in imported products as dimensions*

**Edit current** — hand the population on screen back with an instruction:

> *split the price-sensitive segment into renters and owners, and lower
> willingness to pay by a third*

The original is never modified; edits land as a new population.

### What the model is and is not allowed to do

The model writes the **population** — who exists, how they behave, what they
would pay. It never touches the simulation itself. Willingness-to-pay curves,
confidence intervals and the tie test stay in ordinary auditable code. A model
that could also invent the maths would produce numbers nobody could check.

Output is validated rather than trusted. Common problems are repaired and
reported in the panel log:

- traits given on a 0–100 scale, rescaled
- missing traits, defaulted
- quotes that never mention the option, dropped
- shares that don't sum to 1, renormalised
- a "split" that produced two behaviourally identical segments, flagged as cosmetic

A population whose segments all score alike is rejected outright — it looks like a
population but cannot produce a meaningful segment split.

Populus also warns if you point a decision at a population built for something
else, since the traits and prices would be meaningless.

### Custom dimensions

Beyond six core behavioural traits — price sensitivity, novelty appetite, trust,
scepticism, switching friction, social proof — a population can declare its own
dimensions, and they enter the model exactly like the built-in ones. Mark one
`"invert": true` when a high score pushes *against* the option; health
consciousness resists a snack.

Segments also carry country, age range, income and urban share, and agents
inherit them.

---

## The calibration ledger

A model that is not scored against outcomes is a dashboard.

**Commit** a prediction when you actually ship the decision. The record freezes
the question, the winning option, the predicted rate, the interval, the seed and
the population. It cannot be edited afterwards — only an outcome can be added.

**Close** it when you know what happened. Three numbers accumulate:

- **Mean absolute error** — how wrong the model is on average
- **Bias** — whether it systematically over- or under-predicts
- **Interval coverage** — whether the intervals mean anything

Coverage is the one to watch. If the 95% intervals are honest, about 95% of
outcomes should land inside them. Much lower means the model is overconfident and
the intervals are decoration.

Predictions are written to `ledger.json` beside the app: plain text, atomically
written, and gitignored so your decisions stay private. The ledger starts empty
and says so — until several predictions are closed, the model has no track record
and its numbers deserve no particular trust.

---

## Tests

The ledger scores the model's predictions. The tests score the code that
produces them — an engine with an off-by-one would let the ledger faithfully
record well-calibrated garbage.

```bash
node engine.test.js               # headless, exits non-zero on failure
```

No Node? The same suite runs in the browser at
**http://localhost:8765/test.html** — same file, no framework, no dependencies.

108 assertions covering the invariants that matter:

- the headline rate equals the share-weighted segment rates, exactly
- raising a price never raises demand, at population and segment level
- adding a custom dimension does not perturb the existing ones
- inverted traits resist; neutral segments contribute nothing
- intervals narrow with sample size but never collapse
- the same seed reproduces a prediction; a new seed draws a new sample
- agents inherit their segment's age band, income, country and urban share
- every repair, rejection and warning in the validator
- `parseOutcome('')` is rejected rather than silently recorded as 0%

They assert *invariants*, not today's numbers, so retuning coefficients does not
break them — but breaking the model does.

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
  pos: ['At {O} I would switch.'],    // quotes; {O} is the option under test
  neg: ['{O} is a lot for dish soap.']
}
```

That is the only place you need to touch. The simulation itself —  `latent()`,
`segZ()`, `buildAgents()`, `simulate()`, `validateMarket()` — lives in
`engine.js`, which is pure logic with no DOM, no globals and no network. That
separation is what makes it testable, and it is the same boundary the local
model respects: the model writes populations, the engine decides what they do.

---

## Troubleshooting

**The model panel says "Not reachable".**
The page is almost certainly running from `file://`. Check the address bar reads
`http://localhost:8765`. A page loaded from a file sends `Origin: null`, and
Ollama returns 403 to that; from localhost it returns 200. If the address is
right, press **Reconnect** — the probe only runs automatically the first time you
reach step 2.

**"No models installed".**
Ollama is running but empty. `ollama pull qwen2.5:14b`.

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

- **The four built-in markets are hand-authored.** The machinery is real; the numbers in them are illustrative and were not fitted to data.
- **Model-generated populations are plausible fiction** until grounded in something. They are a fast way to think, not evidence.
- **Verbatims are the weakest output.** A 14B model produces serviceable but flat quotes. A larger model helps; the schema cannot.
- **Outcomes are typed in by hand.** Nothing stops you entering a figure that flatters the model. Self-reported calibration beats none, but a real version would read from till or billing data.
- **Everything except the ledger is in memory.** Reloading clears run history and any generated populations.

Take it as a structured way to reason about who a decision lands on and where it
is genuinely uncertain — not as a substitute for asking real people.

---

## Layout

```
index.html      the interface — markup, styles, rendering
engine.js       the simulation: pure logic, no DOM, no network
engine.test.js  108 assertions against engine.js
test.html       browser runner for the same suite
serve.py        static server plus the ledger read/write API
serve.sh        checks Ollama, then starts serve.py
ledger.json     your committed predictions (created on first commit, gitignored)
```

No build step, no dependencies, no bundler. `index.html` loads `engine.js` with a
plain `<script>` tag; `engine.js` also loads under Node with `require`, which is
how the same test file runs in both places.
