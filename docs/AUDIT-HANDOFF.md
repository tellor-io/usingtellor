# Shepherd audit handoff

## Scope

Paths are relative to the named repository. Include imported interfaces and libraries in review.

| Repository | Contracts |
|---|---|
| `usingtellor` | `contracts/databank/{TellorShepherd,TellorShepherdFactory,TellorDataBank}.sol`; `contracts/sources/{TellorSpotSource,TellorTwapSource}.sol`; `contracts/examples/StreamBackupOracle.sol`; `contracts/interfaces/*.sol` |
| `usingtellor` — primary attestation dependency | `contracts/bridge/{TellorDataBridge,ECDSA}.sol` |
| `morpho-tellor-adapter` | `src/{MorphoTellorOracle,TellorOracleFactory}.sol`; `src/interfaces/*.sol`; `src/libraries/FullMath.sol` and its accompanying license |
| `euler-tellor-adapter` | `src/TellorOracle.sol`; `src/interfaces/ITellorShepherd.sol`; imported code from `lib/euler-price-oracle` and its dependencies |

Euler scope is a single feed with direct/inverse quotes and equal bid/ask. Integration tests exercise the oracle contracts, not complete Morpho market or Euler vault transactions. Test doubles and harnesses are supporting evidence, not deployable scope.

## Build and test

The main and pinned-upstream suites require Node.js/npm; first acquisition of upstream pins also requires Git/network access. Only the older custom-adapter suites require Foundry (`forge`) and sibling repositories (or `MORPHO_ADAPTER_ROOT` / `EULER_ADAPTER_ROOT`).

- Shepherd: Solidity 0.8.19, optimizer disabled, no via-IR (`hardhat.config.js`).
- Custom Morpho adapter: Solidity 0.8.20, optimizer enabled with 200 runs, via-IR enabled.
- Custom Euler adapter: Solidity 0.8.20, optimizer enabled with 200 runs, no via-IR.

Use the adaptor repositories' `foundry.toml` files and the npm lockfile. In a fresh Euler checkout, initialize dependencies with `git submodule update --init --recursive`.

From `usingtellor`:

```sh
npm ci
npx --no-install hardhat test
npm run test:upstream
npm run test:morpho
npm run test:euler
```

The custom integration commands build each adaptor before loading its bytecode. The upstream suite independently compiles pinned immutable Git source objects on every invocation; it never reads stale artifacts. Run `forge test` from each adaptor repository for its native tests.

Prior mutable-pause-duration validation: 19 core files compiled, 140 focused tests (22 new duration cases), 352 main tests, 47 pinned actual-consumer tests and 47 existing custom-adapter tests passed. Actual same-block pause/unpause at zero succeeded. The pinned source build succeeded from an empty source cache and was recompiled by the test command; details are recorded in DESIGN.md. Earlier native `forge test` runs crashed in the installed nightly Foundry build; native suites were not rerun for this increment. The custom suites still use Morpho `e784407` and Euler `46012d5`; dependency-revision, Euler submodule-registration and cache warnings limit their clean-checkout reproducibility. Neither sibling source tree was changed.

Prior mutable-threshold validation: `npx hardhat compile --force` compiled 19 files; the focused threshold/duration/admin/core/factory command passed 163 tests (23 new threshold cases); `npx hardhat test` passed 375; `npm run test:upstream` passed 47; `npx hardhat test integration/MorphoTellorOracle.js integration/EulerTellorOracle.js` passed 47 (31 Morpho, 16 Euler). Exact commands and incremental self-review are recorded in DESIGN.md. Existing overflow-boundary comparison tests passed unchanged. The custom builds retained the same Foundry/dependency/submodule/signature-cache warnings and existing lint warnings; no native Foundry rerun or clean-checkout claim is made. The requested three governance features are implemented/tested, with human review/comprehension and commits still pending. Calibration and release/package work remain deferred.

Current cleanup validation: `npx hardhat compile --force` compiled 19 files; `npx hardhat test` passed 375; `npm run test:upstream` passed 47; `npx hardhat test integration/MorphoTellorOracle.js integration/EulerTellorOracle.js` passed 47. Normalized function signatures/bodies match the pre-cleanup snapshot after the two getter renames; compiled ABI comparison confirms only those getter names change. Interface/factory ABIs, events/errors, constructor arguments and enum order are unchanged. The same custom-build warnings remain; sibling checkouts are unchanged. No new runtime tests or logic changes were added. The human committed governance work in fd7f265 before cleanup; this cleanup remains uncommitted and awaits review.

## Actual upstream consumer revisions and build

[The manifest](../integration/upstream/pins.json) pins every repository used by the two entry-point import closures. Supporting revisions match the corresponding upstream submodule gitlinks; unrelated submodules are not fetched.

| Official repository | Exact commit |
| --- | --- |
| morpho-org/morpho-blue-oracles | `cf5f168943ab61a2de1b289570934d5034043efa` |
| morpho-org/morpho-blue | `55d2d99304fb3fb930c688462ae2ccabb1d533ad` |
| OpenZeppelin/openzeppelin-contracts | `932fddf69a699a9a80fd2396fd1a2ab91cdda123` |
| euler-xyz/euler-price-oracle | `67dfa669dade5b195cfebb25cc05441614960161` |
| foundry-rs/forge-std (Euler IERC20 interface) | `bf6606142994b1e47e2882ce0cd477c020d77623` |
| Vectorized/solady | `0123b4c0509ce253e41e5abd2c75a64c06389640` |

Entry points are `src/morpho-chainlink/MorphoChainlinkOracleV2.sol` and `src/adapter/chainlink/ChainlinkOracle.sol`. The lockfile pins the isolated `solc-upstream` npm alias to `0.8.21+commit.d9974bed`; both are compiled for Paris, with optimizer runs 999999/via-IR for Morpho and 100000/no via-IR for Euler. These are declared test build settings, not a bytecode-equivalence claim against deployed upstream contracts or every target in their repositories. Morpho's exact 0.8.21 pragma is preserved. The core Hardhat compiler stays 0.8.19.

`npm run build:upstream` fetches missing commits into ignored bare repositories under `cache/protocol-consumers`, reads immutable objects via `git show`, and compiles fresh ABI/bytecode. `build.json` there is for inspection only. `npm run test:upstream` calls the same build directly before deploying the actual consumers on the ephemeral Hardhat chain. The first build acquired all six repositories into an empty source cache and the test run rebuilt from the declared pins. No upstream code is vendored or edited; fetched repositories retain their licenses. No clean-machine `npm ci` or npm-package-install validation is claimed. A sandbox DNS restriction required authorized network access for acquisition; cached-object rebuilds run without network or Forge.

Source-fault tests use PriceSourceMock and a test-only token-decimals fixture, not simulated external consumer implementations. The real-bank case exercises attested query-isolated history, TWAP primary, mature spot backup, real Shepherd transitions, V2 price and Euler quotes. Vault conversion, lending/borrowing/liquidation, live networks, and deployed-contract equivalence are outside this evidence.


## Invariants and trust assumptions

- Shepherd selects or refuses exactly two `IPriceSource` readers; roles cannot supply a numeric price override. Consumer reads use only the selected reader. Native output preserves its raw price and original millisecond timestamp. Zero prices and zero/future timestamps revert before age subtraction. One positive deployment-configurable immutable `MAX_DATA_AGE` in seconds applies to both sources. Construction rejects values whose multiplication by 1000 overflows. Reads require `nowMs - timestampMs <= MAX_DATA_AGE * 1000`, so equality is valid at full millisecond precision and 1ms over the limit reverts. Coincident source addresses use the same common limit. There is no production calibration default.
- `latestRoundData()` shares the native pause/selected-read/validation path. After original-ms validation it rejects prices above `int256.max` with `SignedPriceOverflow`, retains the raw declared scale, and floors the original timestamp to seconds. Native uint256 reads remain unchanged. Round ID, round start and answered-in-round fields are zero unavailable sentinels; no history or round progression is supported. Downstream age checks can see up to 999ms extra age from flooring.
- Pause blocks consumer reads. Switches preserve pause and its clock. Only admin can unpause after the minimum duration with no source-pair proposal pending.
- Challenge request/execution require deviation; recovery request/execution require agreement. Both executions require their delay. Every transition/cancellation compares the same primary and backup reads, with primary as denominator, strict deviation and equality in-band. Delayed backup data delays detection; there is no latest-bank bypass. Both sources must be usable and within the common age limit even to execute a challenge, including while paused. Failures preserve timers; neither flow proves continuous conditions.
- Source, admin, pause-duration and threshold proposals share one positive immutable `CONFIG_CHANGE_DELAY` in seconds, with independent timestamps. The existing constructor positional slot is retained; factory configuration is now `configChangeDelay`, without a legacy getter alias. All early executions use `ConfigChangeDelayNotElapsed`; zero deployment delay uses `InvalidConfigChangeDelay`.
- Only the current/outgoing admin can propose, cancel and execute admin transfer. The recipient takes no action. Proposals require a nonzero different address and cannot be overwritten; cancel/repropose resets only that notice. Execution accepts equality, updates admin and clears its own pending state, leaving sources, mode, prices, transitions, pause and all their clocks untouched. Pending source proposals survive with their original timer and become governable only by the new admin. Admin transfer works paused/unpaused and does not block unpause. Explicit pauser memberships persist without implicit grants. Nonzero uncontrollable destinations are deliberately accepted; no liveness/code/acceptance checks or renounce shortcut exist.
- `minPauseDuration()` reports mutable seconds; the initial constructor/factory argument is unchanged. All uint256 durations including zero are valid. Current-admin-only propose/cancel/execute operations use CONFIG_CHANGE_DELAY, explicit pending status, a pending value and independent timestamp. No-op/overwrite/no-pending/unauthorized/early actions revert; cancellation/reproposal restarts only its own notice. Execution applies immediately to any active pause while preserving pausedAt and without automatically unpausing. Unpause uses elapsed time since that original start against the current duration; zero removes only the time wait. Pending updates have no effect before execution and do not block unpause; pending source proposals still do.
- Duration changes never consult source data and preserve source/observation/mode, other proposal clocks, pending challenge/recovery requests, pause state/clock and pauser memberships. Pending-zero updates survive admin handover with their original timestamp and become executable/cancellable only by the new current admin. The explicit minPauseDurationChangePending flag distinguishes zero from absence. The shared configuration delay remains positive/immutable; the threshold is now mutable in 1–9999 bps as described below.
- `challengeThresholdBps()` reports mutable policy within 1–9999 basis points; the initial constructor/factory argument is unchanged. Current-admin-only propose/cancel/execute operations share CONFIG_CHANGE_DELAY but have their own pendingChallengeThresholdBps and challengeThresholdProposedAt. Zero is the absent-proposal sentinel, not valid policy. Invalid/no-op/overwrite/no-pending/unauthorized/early actions revert; equality permits execution; cancel/repropose restarts only that notice. Pending proposals preserve active policy, reads, permissionless transitions and unpause eligibility.
- Threshold execution clears its proposal and invalidates both pending transition requests/timestamps via existing events, even if the same observations still qualify. New requests must wait the full unchanged challenge/recovery delays and pass endpoint checks. Strict primary-relative deviation, equality in-band and overflow-safe arithmetic are unchanged. No source reads, mode switch, pause/unpause, pausedAt change or observation renewal occurs. Other configuration values/clocks and pauser memberships survive. Threshold notices survive admin handover unchanged under the new admin's sole authority; source migration preserves them. Configuration/challenge/recovery delays, maximum age and feed metadata remain immutable.
- Source-pair replacement is admin-only, delayed, atomic and executed while paused; success clears pending challenge/recovery timers. Both addresses need code and matching immutable query/precision metadata at construction, proposal and execution. Price history is not probed. One companion can remain unchanged; no-op pairs are rejected. Cancellation works with broken proposed sources; execution does not consult old sources. Feed identity/precision, core delays and the maximum data age cannot migrate. Migration never renews observation timestamps; a different limit requires a new Shepherd.
- Challenge delay is independently positive: the former rounded-up TWAP-window lower bound is removed by explicit human decision. Deployers/admins must assess source timing/security suitability at deployment and each migration; metadata checks do not enforce it. A maximum age incompatible with source delays can make mature data unreadable. No timing-policy method was added to IPriceSource.
- Tellor readers own relay delay/window/bank configuration. TWAP weights stored relays, not complete Layer history; its endpoint has zero weight and does not establish contributor freshness. Relayer omission, long gaps, excessive duration and one held price remain possible. Two Tellor readers using the same stream do not protect against compromise of that stream.
- `StreamBackupOracle` is a standalone example, no longer used by Shepherd. It trusts authorized streamers to author prices and its admin to appoint them, dispute reports, and permit recovery. Timestamps record submission, not underlying observation freshness. Its recovery flags persist until explicitly changed. Reads inspect at most 32 mature reports after the maturity lookup and may refuse despite older usable data.
- Existing sibling adaptors delegate freshness to Shepherd, which now enforces timestamp validity and one immutable maximum data age. Tests demonstrate full-millisecond boundary equality and stale-data refusal, including backup reads. The custom Morpho adaptor retains cross-feed-skew checks; both adaptors retain scaling. The upstream suite now executes the actual Euler Chainlink and stock Morpho V2 consumers. Stock V2 does not check timestamps, round IDs, query IDs or cross-feed skew; compatible wiring and independent Shepherd freshness remain assumptions. Individually fresh reports with 1200-second skew compose successfully.
- Euler adds its own immutable maxStaleness after seconds flooring. A stricter limit can refuse a Shepherd-accepted report. For equal integer-second limits, `1000*t-m <= 1000*L` iff `t-floor(m/1000) <= L`; flooring alone creates no boundary disagreement. Original-ms checks still reject future timestamps. The zero round sentinels are accepted by both tested consumers; no full historical-round compatibility is claimed.
- Factory registration proves deployment provenance, not safe settings, source trust, or the nominated admin's consent. Earlier increments changed constructor/factory/migration ABIs and require fresh deployments. This admin-transfer increment retains constructor positional types/order but renames the shared delay getter, error names and factory field; integrations using named configuration must update.

Current approved behavior and the pending review checkpoint are recorded in [DESIGN.md](DESIGN.md).

## Deployment and release boundary

Mutable-policy callers must now use `minPauseDuration()` and `challengeThresholdBps()`; former uppercase getters have no compatibility aliases. Alphabetical storage declaration ordering changes slots/packing. No proxy/fixed-slot dependency was found in the inspected core/tests/integrations; this remains a fresh-deployment design, not a storage-compatible upgrade. Factory Configuration fields and constructor positions remain unchanged. Historical getter names in DESIGN.md describe earlier checkpoints only.

Use the exact reader → per-query Shepherd → protocol consumer argument examples in [README](../README.md#deployment-composition-illustrative-not-production-calibration). The configured common quote direction, token/feed precision, signed price range and consumer-specific scale bounds are deployment obligations. The illustrative durations are not production recommendations. New constructor/factory/migration ABIs require new instances; source migration cannot recalibrate immutable settings.

Artifact release work is still required after human review: 20 old artifact/debug JSON files remain tracked despite the temporary ignore; factory/readers/IPriceSource and other current outputs need tracking. Regenerate from a clean artifact tree, remove orphan outputs, refresh required ABI/bytecode and debug/build-info relationships, remove the temporary artifacts ignore, inspect the npm tarball and verify package installation/imports in an isolated consumer. Existing ignored leftovers include debug files for removed `AggregatorPriceSource`, `StreamsBackupOracle` and `IBackupPriceSource`; blindly publishing the current folder is inappropriate. This increment restores its generated tracked changes and invalidates the Solidity cache to keep review focused. No release commit, npm publication, live deployment or market creation is authorized or performed.
