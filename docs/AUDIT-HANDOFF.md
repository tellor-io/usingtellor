# Shepherd audit handoff

This is the current review and release summary. The [Shepherd guide](SHEPHERD.md) describes behavior; [audit history](reference/AUDIT-HISTORY.md) preserves earlier decisions and validation records. Historical “pending” and “uncommitted” statements there apply only to their original checkpoints.

The contract-formatting change is committed as `5dabd61`, the optimizer change as `46f4ec5`, and the package-entry/documentation changes as `595cf12`, and the source-read gas budget as `d244027`. The lower-price deviation reference is committed as `94c5c28`, followed by cleanup in `84332cf`. The current uncommitted increment permits live source replacement, propagates source-call failures without a fixed gas budget, and delegates reader price/timestamp usability to Shepherd while retaining TWAP structural validation. No deployment or publication is part of this work.

## Scope

| Repository | Review scope |
| --- | --- |
| `usingtellor` | Shepherd, factory, DataBank, source readers, imported interfaces, and the DataBridge/ECDSA attestation dependency. |
| `morpho-tellor-adapter` | Custom Morpho oracle, factory, interfaces, and FullMath dependency. |
| `euler-tellor-adapter` | Custom Euler oracle, interface, and imported Euler price-oracle dependencies. |

Tests, mocks, harnesses, and `StreamBackupOracle` support the review. The streamer example is not a Shepherd dependency. Local integration tests exercise oracle reads and transitions, not lending, liquidation, or funded vault positions.

## Build and test

| Build | Compiler and settings |
| --- | --- |
| Core | Solidity 0.8.19; optimizer 200 runs; Paris; no via-IR. |
| Custom Morpho | Solidity 0.8.20; optimizer 200 runs; via-IR. |
| Custom Euler | Solidity 0.8.20; optimizer 200 runs; no via-IR. |
| Pinned stock Morpho V2 | Solidity 0.8.21; optimizer 999999 runs; Paris; via-IR. |
| Pinned stock Euler | Solidity 0.8.21; optimizer 100000 runs; Paris; no via-IR. |

Core settings are in [hardhat.config.js](../hardhat.config.js). Paris preserves the previous compiler default; production compiler/EVM selection still needs to be matched to the intended chains. The factory's measured runtime is **12,772 bytes**, and Shepherd's is **9,289 bytes**. The factory test enforces a **20,000-byte budget** under the 24,576-byte network limit. Bytecode changes require new CREATE2 predictions and matching verification settings.

Use Node.js 22 for the locally validated workflow; CI selects 24. Verify `node --version` in the actual execution directory. Run:

```sh
npm ci
npm test
npm run test:upstream
npm run test:morpho
npm run test:euler
```

Only custom-adapter suites require Forge and sibling checkouts. Set `MORPHO_ADAPTER_ROOT` or `EULER_ADAPTER_ROOT` to use other locations. Their tests build those checkouts before reading artifacts. Native adapter tests run with `forge test` from each adapter repository.

### Actual upstream consumer revisions and build

[pins.json](../integration/upstream/pins.json) is the authoritative list of the six upstream repositories and exact commits. [build.js](../integration/upstream/build.js) reads immutable Git objects and recompiles on every invocation using the lockfile-pinned `solc-upstream` 0.8.21 compiler. The cache is under `cache/protocol-consumers/`; its `build.json` is inspection output, not reused test bytecode. First acquisition requires Git/network access; cached builds need no Forge or sibling checkout.

These settings describe the test builds, not bytecode equivalence with deployed upstream contracts. The tests use real pinned Morpho V2 and Euler consumers; source-fault cases use mocks, while a composed case uses real bridge attestations, bank history, readers, and Shepherd.

## Validation evidence

| Checkpoint | Evidence |
| --- | --- |
| Direct calls, live replacement, and reader usability (2026-11-18, uncommitted) | 490 core tests and 103 consumer integration tests (47 pinned upstream, 39 custom Morpho, 17 custom Euler) passed with Node 22.23.2 in a disposable copy. Coverage includes propagated source/ABI failures, gas starvation across all six transition actions, invalid returned data through actual readers with injected bank faults, pause/live migration, and real-bank TWAP coverage after a week without reports and after reporting resumes. Factory runtime is 12,772 bytes, below the 20,000-byte budget. |
| Lower-price deviation reference (`94c5c28`) | 21 Solidity files compiled; ABIs unchanged. Four rewritten cases failed against the primary reference (boundary/source-swap comparison, a 120/100 exact-equality challenge, and 3000/9999 bps source-order cases) and passed with the lower-price reference. 462 core and 103 upstream/custom integration tests passed using Node 22.23.2 in a disposable copy. |
| Source-read gas budget (`d244027`) | 21 Solidity files compiled. Both new tests failed against the previous read path, where one source received 601 distinct gas amounts across 601 caller limits, and passed with the budget. 462 core and 103 upstream/custom integration tests passed using Node 22.23.2 in a disposable copy. |
| Optimizer (`46f4ec5`) | 20 Solidity files compiled; all 21 compiled ABIs matched an unoptimized baseline. 458 core tests and 103 combined upstream/custom integration tests passed using Node 22.23.2. |
| Factory budget | The new test failed against the old 24,568-byte build and passed against the optimized 12,845-byte build. Existing CREATE2, registration, and failed-construction cases passed. |
| Package entry point | Two regression tests first failed on the missing `./contracts` import, then passed with the helper-only root export. A packed tarball worked in a separate Hardhat consumer for root helpers, network calls, and explicit Solidity/artifact paths. |
| Documentation | Local links and anchors checked; the README factory-deployment example executed successfully; its package-qualified Solidity import compiled against packed sources. |

The earlier package smoke test reused installed tooling. It did not verify a fresh dependency installation, every helper, or the consistency of every packaged artifact. At that package checkpoint, the full core suite compiled 20 Solidity files and passed all 460 tests using Node 22.23.2 in a disposable copy. Consumer integration suites were not rerun for this package/documentation increment; their 103 passing results above belong to the optimizer checkpoint.

The current custom-adapter run retained Foundry nightly, dependency-revision, Euler submodule-registration, signature-cache-permission, and lint warnings. Forge build commands completed using installed dependencies/cached adapter outputs; Euler could not register its submodule in this sandbox. Native adapter Forge tests were not rerun for this increment. Passing installed-dependency tests do not establish clean-machine reproducibility. A previous older-Node `findLastIndex` failure was resolved by explicitly selecting Node 22, without changing test logic.

## Known limitations

- **Source-call behavior:** direct calls have no fixed gas budget. Reverts, out-of-gas failures, and malformed successful ABI responses revert the operation. Either source can block challenge/recovery request, execution, and cancellation; pending state is preserved. Admin replacement remains metadata-only and may execute while live. Removing catch prevents a failed call from being classified as unusable, but does not make gas-sensitive successful source responses independent of caller gas.
- **Reader usability:** spot returns zero prices and zero/future timestamps; TWAP returns zero prices and future endpoints if its interval/reference checks pass. A zero TWAP endpoint still violates positive interval requirements. Direct consumers need their own usability checks. Shepherd rejects invalid returned data but can use it to permit delayed switching. Missing history and structural/dependency failures still revert, including during TWAP startup. Current append-only DataBank coverage persists for fixed reader settings once established, but freshness does not.
- **Source trust:** compatible decimals, a fresh timestamp, a display label, and factory provenance do not authenticate price truth or asset meaning. Two sources may share the same compromised data stream.
- **Timing:** transitions recheck eligibility at request and execution, not continuously. Reader delays, TWAP windows, maximum age, and administrative notice require deployment-specific calibration.
- **TWAP sampling:** a fresh endpoint does not establish fresh contributors or complete history. Sparse relays, long-held values, and excess interval duration remain possible.
- **Administration:** source replacements admit unavailable sources after code/precision checks. Non-pausable instances cannot be paused. The outgoing admin executes an admin transfer; an uncontrollable recipient can permanently disable administration.
- **Unpause review:** expected mode/source arguments bind only selection at execution. They do not bind prices, proposals, or transition timers, and do not prevent later transitions or detect changes that restore the same selection.
- **Consumer compatibility:** `latestRoundData` has zero round sentinels and no retrievable history. Stock Morpho V2 does not check timestamps or skew; Euler adds a separate age limit. Custom adapters have different provenance, scaling, and skew rules.
- **Bridge trust:** verification uses a configured voting threshold and a trusted guardian recovery path. Attested fields still require downstream admission and price policy. The bridge does not independently enforce a two-thirds threshold or fetch current Layer dispute status.

These are documented constraints and open risks. The current increment changes source-call failure handling, reader usability policy, and the pause requirement for source replacement; it does not establish production readiness.

## Release work

1. Review and commit the intended source/configuration changes. Current deployment interfaces require fresh instances, not storage-compatible upgrades.
2. Choose deployment chains, confirm compiler/EVM compatibility, and calibrate source trust, quote units, precision, delays, freshness, skew, and administrator/guardian operations.
3. Build artifacts from a clean tree using the reviewed settings. Remove obsolete outputs and check ABI/bytecode and debug/build-info consistency. The current workspace artifact folder is not a release bundle.
4. Restore tracking of required current artifacts, including factory/readers/interfaces, and remove the temporary artifact ignore rule. Twenty older artifact/debug files are still tracked; new outputs are not all tracked.
5. Inspect the npm tarball and install it in a clean consumer project. Verify package name, tooling requirements, helper imports, Solidity imports, and all required artifact paths. Recheck the generated bytecode and CREATE2 predictions.
6. Run the selected-chain deployment and consumer checks before publication or live use. The local tests above do not cover funded market operations.

The current increment changes Shepherd, factory, and reader bytecode, so CREATE2 predictions must be regenerated. The `SOURCE_READ_GAS()` getter and unused `InsufficientGasForSourceRead` error are removed, along with the readers' `InvalidTimestamp` errors and spot's `ZeroValue` error. Price-read and administrative function signatures, compiler settings, and adapter implementations are unchanged. Workspace artifacts are preserved, not rebuilt as a release bundle; the npm package is not release-ready.
