# Populus

**Test the decision before you commit to it.**

Populus builds a simulated population of people and runs your decision against them
first — pricing, launch scope, messaging, or policy. The output is not a dashboard.
It is a prediction: what will happen, which segments drive it, and where the answer
is too close to call.

This repo is a working single-file prototype. Open `index.html` in any browser.
No build step, no dependencies, no network calls.

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

## Layout

```
index.html    the entire prototype — markup, styles, engine, all of it
README.md     this file
```

The simulation engine is the `ENGINE` section of the script block: `latent()`,
`segZ()`, `buildAgents()`, and `simulate()`. Markets, segments, WTP values, trait
weights, and the verbatim banks are the `MARKETS` object above it — that is the only
place you need to touch to add a market.

## Known limits

- Segment definitions, WTP values, and trait weights are hand-authored, not fit to data. The machinery is real; the parameters are illustrative.
- Verbatims are template-driven per segment, not generated. They demonstrate the surface, not the linguistic range.
- The calibration ledger shows illustrative prior predictions. Nothing is wired to an outcome feed yet.
- Everything is in-memory. Reloading the page clears run history.

## Open questions

Two decisions drive most of the real architecture:

1. **Which wedge leads** — pricing has the cleanest ROI story and validates against shelf and billing data; messaging has more volume but far weaker ground truth.
2. **Panel or per-query** — whether agents are generated fresh for each question or maintained as a persistent panel that gets re-run over time. The second makes longitudinal calibration possible and is much harder to build.
