# AGENTS.md

This branch (`usinglayer2`) is a **deliberate, incremental rebuild of TellorShepherd**, run as a tutoring collaboration rather than a delegation.

## Read first, every session

1. `docs/SHEPHERD-REBUILD-BRIEF.md` — what we are building, and the working protocol. **Binding.**
2. `docs/DESIGN.md` — the living design doc: current invariants, decisions, open questions.
3. `docs/reference/design-recommendations.md` — full reasoning. A recommendation, not a spec.

## The short version of the protocol

- **Design note before code.** Problem, constraints, ≥2 approaches, invariants, failure modes, what is deferred. Human approves before anything is edited.
- **One step, one idea, one commit.** ~50–150 lines of contract change plus tests. Never leave the repo broken between steps.
- **Steps are labeled HUMAN-WRITES or AGENT-WRITES** in the build-plan ladder linked by the brief. On a HUMAN-WRITES step: explain the problem and the approaches, then *review* the human's implementation and write tests against it — do not write the implementation. Default to HUMAN-WRITES when unclear.
- **Explain why, not what.** After each step, ask 2–3 real comprehension questions.
- **Challenge assumptions.** Deference is a failure mode here. So is manufactured disagreement.
- **Never run ahead.** No implementing step N+1 while working on step N.
- **Shepherd never authors a price.** Its roles select or refuse source data. The human-approved `StreamBackupOracle` example explicitly trusts backup streamers to author reports and its admin to appoint streamers (including itself). This is a separate backup trust assumption, not independent price verification; do not add a numeric override to Shepherd.
- The prototype on the `usingtellorlayer` branch is **reference only**. Do not copy it.

A large, correct, unread diff is a failure. "Tests pass" is not the bar; "the human can explain every important line" is.

## Repo facts

- Solidity 0.8.19, Hardhat, JS tests (`npx hardhat test`).
- Never commit `cache/` or `node_modules/`.
- **`artifacts/` is gitignored for the duration of the rebuild** so that step commits stay readable. This repo is published as an npm package and consumers import the artifacts into their own test files, so **`artifacts/` must be re-tracked once the build is done.** Do not quietly leave it ignored.
- Commit message format is in §3.5 of the brief; the body records the invariant added and what was deferred.
