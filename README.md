# Populus

**Test the decision before you commit to it.**

Populus builds a simulated population of people and runs your decision against them
first — pricing, launch scope, messaging, or policy. The output is not a dashboard.
It is a prediction: what will happen, which segments drive it, and where the answer
is too close to call.

This repo is a working single-file prototype. No build step, no dependencies,
no cloud calls.

```bash
./serve.sh          # then open http://localhost:8765
```

Use the script rather than double-clicking the file. Serving over `localhost`
is what lets the local model panel work — see *Local model* below.

> **Opening `index.html` in TextEdit shows a blank page.** The file is fine.
> TextEdit *renders* HTML rather than showing source, and this page's `<body>`
> is an empty shell that JavaScript fills in — which TextEdit does not run, so
> you get a blank document. To read the source, use a code editor, or
> `cat index.html`, or set TextEdit → Settings → Open and Save →
> "Display HTML files as HTML code". To *use* it, open it in a browser.

---

## The loop

1. **Frame the decision** — pick a decision type, state the question, list the options you are choosing between.
2. **Build the population** — choose a market, include or exclude segments, set the sample size.
3. **Run the simulation** — agents respond to every option under their own constraints.
4. **Read the prediction** — outcome, per-segment breakdown, drivers, individual voices, calibration.

Four presets load instantly: refill pricing (grocery), launch wedge (SMB software),
lead claim (DTC skincare), fare-freeze policy (UK electorate).

## What is actually modeled

**Agent-level, not segment-level.** ~260 individual agents are drawn, each with a
segment, an idiosyncratic offset from that segment's mean, and a personal response
probability per option. Segment and population rates are aggregated *up* from
individual verdicts — they are not written down and then decorated.

**Real willingness-to-pay math for pricing.** Each segment carries a WTP distribution
(mean and spread). Buy probability is a logistic function of the gap between WTP and
the asking price, which produces a genuine downward-sloping demand curve at both the
population and the segment level. The revenue index multiplies rate by price to find
the optimum, which is frequently *not* the highest-conversion price.

**Latent affinity for everything else.** Non-pricing options are projected into six
dimensions — value framing, novelty appetite, institutional trust, claim credibility,
switching effort, social proof. Each segment has a weight on each dimension. Driver
labels change with the decision type, so a policy run reads "household cost impact"
where a pricing run reads "price vs. reference point."

**A structural floor and ceiling.** Roughly 4% of agents are never in the category and
about 3% will act regardless of the option, so no result ever reads 0% or 100%.

**Intervals that mean something.** The 95% band combines sampling error, which shrinks
as you raise the sample size, with an irreducible model-error term that does not. You
cannot buy your way to certainty by simulating more agents.

**Tie detection.** If the gap between the top two options sits inside the noise, the
headline says *Too close to call* and badges both as joint first, rather than
manufacturing a winner. For pricing this test runs on revenue, not on the buy rate,
because revenue is the decision metric.

## Why it is deterministic

Determinism here is a property, not a shortcut. Given a seed, the same inputs return
byte-identical output — which is what makes a prediction auditable. You can log a
number, ship the decision, and later re-run the exact simulation that produced it.
A model that quietly returns something different each time cannot be scored against
reality, and scoring against reality is the whole premise.

Randomness lives where it belongs: in **which** agents get drawn, not in how the
population behaves. `Draw a new sample` increments the seed and re-rolls the sample.
The population's structure is unchanged; the specific 260 people are different. This
is a sampling distribution you can watch directly — and if the winner flips between
samples, the gap was never real. That is the interval doing its job, visibly.

## Local model

Populus talks to a local LLM to build and edit populations. Everything stays on
the machine — no keys, no cloud, no data leaving the box.

**Setup**

```bash
ollama pull qwen2.5:14b     # or any instruct model you prefer
./serve.sh                  # http://localhost:8765
```

Step 2 auto-detects the server at `http://127.0.0.1:11434`, lists installed
models, and shows a connection light. Any OpenAI-compatible or Ollama-native
endpoint works — point it at LM Studio or llama.cpp by changing the endpoint field.

**Two modes**

- **Generate new** — describe an audience in a sentence ("UK small-scale organic farmers deciding whether to install solar") and get a full population: segments, trait weights, willingness-to-pay distributions, and verbatim banks.
- **Edit current** — send the population you're looking at back with an instruction ("split the price-sensitive segment into renters and owners, drop willingness to pay by a third") and get the modified version. The original is left intact; the edit lands as a new market.

**The division of labour matters.** The model writes the *population spec* only.
It never touches `simulate()`. Willingness-to-pay curves, the floor and ceiling,
interval construction, and the tie test all stay in auditable code. An LLM that
could also invent the physics would produce numbers nobody could check — the
point is that the model proposes who exists, and fixed math decides what they do.

**Output is validated, not trusted.** `validateMarket()` repairs what is safely
repairable and rejects what is not:

| Repaired | Rejected |
|---|---|
| Traits given on a 0–100 scale → rescaled | Fewer than 2 segments |
| Missing traits → defaulted to 0.5 | Response that isn't an object |
| Quotes missing the `{O}` token → token appended | Segments near-identical across all six traits |
| `{O}` leaking into segment names or descriptions → stripped | |
| Shares that don't sum to 1 → renormalised | |
| Short name pools and missing context → padded | |

Observed rates on qwen2.5:14b: a five-segment population typically needs
around ten quote repairs, because the model reliably drops the `{O}` token from
negative quotes while keeping it in positive ones.

**Cosmetic splits are flagged.** Ask a model to "split segment X into A and B"
and it will often duplicate the segment and change only the label — same traits,
same willingness to pay, same quotes. Two segments that behave identically are
one segment wearing two names, and the segment table would imply a distinction
that isn't there. Any pair within 3% on every trait and on WTP gets reported in
the panel as *the split is cosmetic*.

That last rejection is the important one. A model under-specified or asked for a
narrow audience will sometimes emit five segments with nearly identical trait
vectors, which looks like a population but cannot produce a meaningful segment
split. Mean trait spread below 0.12 is treated as a collapse and thrown out, with
the reason logged in the panel.

## Layout

```
index.html    the entire prototype — markup, styles, engine, all of it
serve.sh      local http server; also checks whether Ollama is up
README.md     this file
```

The simulation engine is the `ENGINE` section of the script block: `latent()`,
`segZ()`, `buildAgents()`, and `simulate()`. Markets, segments, WTP values, trait
weights, and the verbatim banks are the `MARKETS` object above it — that is the only
place you need to touch to add a market.

## Known limits

- The four built-in markets are hand-authored, not fit to data. The machinery is real; the parameters are illustrative. Model-generated populations are plausible fiction until grounded in something.
- Verbatims are template-driven per segment, not generated. They demonstrate the surface, not the linguistic range.
- The calibration ledger shows illustrative prior predictions. Nothing is wired to an outcome feed yet.
- Everything is in-memory. Reloading the page clears run history and any generated populations.
- Generated populations are not persisted or exportable yet. That is the obvious next commit.
- The model ignores the currency field about half the time — ask for a UK population and it still returns `"cur": "$"`. Cosmetic, affects labels only, not the math.

## Open questions

Two decisions drive most of the real architecture:

1. **Which wedge leads** — pricing has the cleanest ROI story and validates against shelf and billing data; messaging has more volume but far weaker ground truth.
2. **Panel or per-query** — whether agents are generated fresh for each question or maintained as a persistent panel that gets re-run over time. The second makes longitudinal calibration possible and is much harder to build.
