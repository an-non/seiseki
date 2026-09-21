# SEISEKI 4-Jev entangled prediction circuit

Status: experimental integration core; not wired to production D1 or the public quantum screen.

## Purpose

One circuit set consists of four Jev inference stages in strict series.

1. Stage 1 receives the original SEISEKI-derived state plus a Bell-like logical-pair state.
2. Every Jev answer is normalized into a probability distribution.
3. The complete answer distribution, including every answer percentage, updates the Bell-like state.
4. The updated equation and the prior Jev percentages are embedded into the next stage state.
5. Steps 2-4 repeat through Stage 4.
6. The result returns both the Stage-4 prediction and a weighted geometric fusion of all four stages.

This is a logical/probabilistic quantum-inspired calculation. It does not claim quantum hardware, physical entanglement between Jev instances, or a physical quantum advantage.

## State equation

Each stage carries the same Bell-like family used by the SEISEKI entanglement prototype:

|psi_k> = cos(theta_k)|00> + exp(i phi_k) sin(theta_k)|11>

Jev probabilities p_k(a) are converted into entropy/confidence, top-two margin, and a circular probability vector. Those values deterministically update theta, phi, and the two measurement angles. Born probabilities P(00), P(01), P(10), P(11) are then recalculated and passed to the next stage.

The Jev response itself remains authoritative for the prediction labels. The Bell-like state acts as an explicit coupled state carried between stages; it does not overwrite Jev probabilities.

## Four stages

- 1: baseline
- 2: conditioned-update
- 3: interference-reconciliation
- 4: final-forecast

Every Stage 2-4 payload contains:

- the original caller state;
- current Bell-like equation and numeric parameters;
- current Born probabilities;
- all answer probabilities from the immediately previous Jev;
- the previous dominant answer and normalized confidence;
- the same target prediction question and criteria.

## Final fusion

The default fusion weights are [0.15, 0.20, 0.25, 0.40]. For each answer label a, the circuit uses a weighted geometric pool:

P_fused(a) proportional to product over k of P_k(a) ^ w_k

and then renormalizes across labels.

## Data boundary

The module is pure computation. It does not access D1, accounts, response IDs, free-text production responses, cookies, or secrets.

Use synthetic or privacy-reviewed aggregate/derived state when validating an external Jev adapter. Do not send SEISEKI production free text or account-linked data through the browser bridge.

## Files

- integration/jev-quad-loop/quantum-circuit.mjs
- tests/jev-quad-loop.test.mjs

A transport adapter can inject any function matching:

invokeJev(stageInput, stageNumber) -> { distribution: { label: probability } }

The transport may later be TypeSafe API, Vercel AI Gateway, or the protected Jev browser bridge without changing the circuit math.


## Verified end-to-end synthetic run (2026-09-21)

The protected Jev Browser Bridge was exercised with one synthetic 4-stage set using `jev-latest`. No SEISEKI production response, account, D1 row, answer ID, or free text was sent.

Synthetic evidence:

- momentum: 0.62
- dispersion: 0.18
- meanReversion: 0.27
- relationStrength: 0.74

Prediction labels: `up`, `flat`, `down`.

Observed serial results:

| Stage | Semantic role | up | flat | down | Playground confidence | Dominant |
|---|---|---:|---:|---:|---:|---|
| 1 | baseline | 12% | 78% | 10% | 68% | flat |
| 2 | conditioned-update | 45% | 44% | 11% | 18% | up |
| 3 | interference-reconciliation | 45% | 36% | 19% | 18% | up |
| 4 | final-forecast | 74% | 21% | 5% | 61% | up |

The Stage 1 percentages were present in Stage 2 state, Stage 2 percentages in Stage 3 state, and Stage 3 percentages in Stage 4 state. The Bell-like equation and Born probabilities were recomputed between every stage.

Final Bell-like state Born probabilities:

- P(00): 30.4459728%
- P(01): 10.4753395%
- P(10): 43.8559902%
- P(11): 15.2226975%

Weighted four-stage fusion:

- up: 51.1597%
- flat: 38.5372%
- down: 10.3031%

This verifies the serial transport contract and the probability/equation handoff. It is not a calibration or accuracy validation of the prediction method.

### Bridge implementation

The protected control service exposes the semantic route:

`/api/control/typesafe/seiseki/quad-loop`

Its GET path is a fixed synthetic smoke test. POST accepts the same circuit contract but must remain restricted to synthetic or privacy-reviewed aggregate/derived state unless the SEISEKI data-governance boundary is separately changed and approved.

The current bridge transport drives the authenticated TypeSafe Playground through the persisted Browserbase Context. The SEISEKI pure computation module remains transport-independent.
