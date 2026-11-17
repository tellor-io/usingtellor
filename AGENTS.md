# AGENTS.md

TellorShepherd is developed through deliberate, incremental tutoring. Preserve the human's understanding of the code; a large correct diff that they cannot explain is not a completed step.

## Read first

1. This file: the working protocol.
2. `README.md` and `docs/SHEPHERD.md`: current setup and public behavior.
3. `docs/AUDIT-HANDOFF.md`: validation evidence, limitations, and release work.
4. `docs/DESIGN.md`, if present: the local design checkpoint, decisions, and current approved step.

`docs/DESIGN.md` intentionally remains outside version control. Update it locally when decisions or checkpoints change. Do not force-add it, remove its local exclusion, copy its private history into tracked files, or reference it from any README. A fresh checkout may not have it; use the public guide, handoff, code, and current user instructions instead.

`docs/reference/AUDIT-HISTORY.md` preserves historical public audit records. Old branch names, interfaces, test counts, and pending statuses there are not current instructions. The prototype on `usingtellorlayer` is reference only; do not copy it. Verify the actual branch, status, and recent commits each session.

## Working protocol

- **Design before edits.** Explain the problem, constraints, at least two reasonable approaches, invariants, failure modes, verification, and deferred work. Wait for approval before editing implementation, tests, or documents. Existing explicit approval remains valid within its scope.
- **Assign ownership.** Label each increment HUMAN-WRITES or AGENT-WRITES in the local checkpoint or conversation. Default to HUMAN-WRITES when unclear. On a HUMAN-WRITES step, explain and review the implementation; you may write tests but must not write the implementation unless the human delegates it.
- **One idea per increment.** Aim for about 50–150 lines of contract change plus relevant tests. Keep steps buildable. Do not implement the next step unless authorized; follow an explicitly approved sequence without asking for the same approval again.
- **Explain why.** Review consequential choices and ask two or three real comprehension questions after an increment. Passing tests or accepting progression does not establish answers. Respect an explicit waiver.
- **Challenge assumptions.** Raise concrete contradictions and tradeoffs without inventing disagreement.
- **Preserve evidence.** Keep current behavior separate from historical results. Record validation scope, unresolved failures, decisions, and the next permitted action. Never turn a local mock/integration result into a production-readiness claim.

## Design boundaries

- Shepherd never authors a price. Its roles select or refuse source data; do not add a numeric override.
- `StreamBackupOracle` is a separate trusted-streamer example. Its admin may appoint streamers, including itself. That trust does not establish independent price verification.
- Sources must have compatible meaning and precision; generic metadata and factory membership do not prove price truth or asset identity.
- Preserve documented unresolved source-call gas and malformed-ABI behavior unless a separate change is approved.
- Use `@author Tellor Inc.` in approved Solidity standards work. Keep `init()` after the constructor. ECDSA.sol remains excluded from mechanical cleanup.

## Build and validation

- Core: Solidity 0.8.19, optimizer 200 runs, Paris target, no via-IR. Compiler upgrades and EVM-target changes require a separate decision.
- Use Node.js 22 for the locally validated workflow; CI selects 24. Check the executable/version in temporary directories, where the shell may select an older Node.
- `npm test` runs the core and package-export tests. `npm run test:upstream` builds pinned stock consumers. Custom Morpho/Euler suites require Forge and sibling checkouts or the documented root overrides.
- Factory deployed runtime must stay at or below the 20,000-byte project budget. Do not relax the network limit to make tests pass.
- Run checks appropriate to the changed behavior. Prefer a disposable build copy when generated artifacts would obscure a small diff. Preserve pre-existing edits and do not claim tests ran if they did not.
- Root package exports are Hardhat test helpers; Solidity and artifact JSON use explicit package paths. Do not restore imports of nonexistent JavaScript contract modules.

## Artifacts and commits

`artifacts/` is temporarily ignored, but some older artifacts remain tracked. Never commit `cache/` or `node_modules/`. Before release, rebuild a clean artifact tree, remove obsolete outputs, restore tracking of required artifacts, remove the temporary artifact ignore rule, and verify the packed package in a consumer project. A helper smoke test alone is not release validation.

One coherent commit per accepted increment. Propose a message such as `step-<id>: <change>` when an agreed step ID exists; do not invent old ladder numbers. The body records `Invariant:` and `Deferred:`. Commit only when the human confirms understanding and authorizes the commit. Do not infer a commit request from permission to edit. Verify user-created commits before reporting work as uncommitted.
