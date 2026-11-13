[![Tests](https://github.com/tellor-io/UsingTellorLayer/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/tellor-io/UsingTellorLayer/actions/workflows/tests.yml)

# UsingTellorLayer

Use this package to install the Tellor user contracts and test helper functions, and to integrate Tellor into your contracts.

## Contents

- `contracts/interfaces/ITellorDataBridge.sol` - The TellorDataBridge interface
- `contracts/testing/TellorLab.sol` - A testing contract for rapid prototyping with Tellor oracle data
- `contracts/interfaces/ITellorDataBank.sol` - The TellorDataBank interface, a standard interface for reading tellor data
- `contracts/bridge/TellorDataBridge.sol` - The TellorDataBridge contract
- `contracts/databank/TellorShepherd.sol` - Per-feed primary/backup source selection, pause controls, and explicit transitions
- `contracts/interfaces/IPriceSource.sol` - Common price, millisecond timestamp, query identity and precision interface
- `contracts/sources/{TellorSpotSource,TellorTwapSource}.sol` - Standalone Tellor readers with immutable bank/timing configuration
- `contracts/databank/TellorShepherdFactory.sol` - Permissionless Shepherd deployment and provenance tracking
- `contracts/examples/StreamBackupOracle.sol` - Standalone trusted-streamer example; no longer a Shepherd dependency
- `src/helpers/evmHelpers.js` - Helper functions for testing

See the [audit handoff](docs/AUDIT-HANDOFF.md) for review scope, build/test commands, and trust assumptions. Local integration coverage does not establish deployment readiness.

Shepherd's [current design](docs/DESIGN.md) selects exactly two `IPriceSource` readers: primary and backup. Consumer reads consult only the selected reader; transition checks compare both. There is no automatic fallback. A delayed backup consequently delays deviation detection. Native outputs retain the raw price and original millisecond timestamp; `queryId()` and `decimals()` describe the immutable feed identity and precision.

Deploy the readers first, then pass `(queryId, decimals, primarySource, backupSource, admin, minPauseDuration, configChangeDelay, challengeThresholdBps, [challengeDelaySeconds, recoveryDelaySeconds], maxDataAge, isPausable)` to Shepherd. The factory takes the same settings in `Configuration`, with separate challenge/recovery delay fields and one `maxDataAge` field. All core durations are seconds; `minPauseDuration` may be zero, while the other core durations remain positive. `maxDataAge` must be at most `floor(type(uint256).max / 1000)`; `MAX_DATA_AGE()` exposes this common immutable setting in seconds. Both reader addresses must have code and matching query/precision metadata; empty history is allowed. Compatibility does not prove authenticity or price availability.

`isPausable()` is fixed at deployment. With `true`, existing pause/unpause and paused-source-replacement rules apply. With `false`, even admin and registered pausers cannot pause (`NotPausable`), and source replacement executes while unpaused after the same admin authorization, notice and metadata checks. Pauser memberships and minimum-pause-duration settings remain manageable but have no effect on such an instance; they cannot enable pausing. Non-pausable does not guarantee continuous prices: source failures, stale data or an unusable replacement can still make reads revert. The factory records the flag in its creation event and binds it into the CREATE2 address.

Challenge delay is independently configured and is **not** checked against a TWAP window. Deployers/admins must calibrate the immutable transition delays for the sources, including each replacement. Relay delays and TWAP windows belong to the readers. Replace a pair through `proposeSourcesChange(primary, backup)`, then `executeSourcesChange()` after notice (while paused if `isPausable` is true), or `cancelSourcesChange()`. A proposal can retain one current source; execution preserves mode/pause and clears transition timers. Constructor/factory/migration ABIs require new deployments.

`CONFIG_CHANGE_DELAY` is the shared positive immutable notice period (seconds) for source changes, admin transfers, minimum-pause-duration updates and threshold updates; the constructor keeps the former delay's positional slot and the factory uses `configChangeDelay`. There is no old getter alias. The current admin calls `proposeAdminChange(newAdmin)`, may cancel with `cancelAdminChange()`, and **the current/outgoing admin** calls `executeAdminChange()` after the full delay (equality passes). The recipient takes no action. Zero/same-admin destinations and overwriting pending proposals are rejected; cancel and repropose to restart notice. `pendingAdmin` and `adminProposedAt` expose the pending transfer.

Admin transfer works paused or unpaused and preserves all source/transition/pause state and clocks, including pending source proposals. Only the new admin can govern those proposals after transfer. Explicit pauser memberships survive, but being admin never adds a permanent membership. A pending admin transfer does not block unpause; a pending source change still does. Any nonzero throwaway address is permitted without a liveness check, so admin operations may deliberately become permanently unusable while existing pausers retain their authority on pausable instances.

The mutable-policy getters are now camel case: `minPauseDuration()` and `challengeThresholdBps()`. Update callers using the former uppercase names; no compatibility aliases are retained. Existing constructor argument positions and factory fields are retained; the final `isPausable` bool is now required in both. Declaration sorting changes storage slots; this remains a fresh-deployment design, not a storage-compatible upgrade.

`minPauseDuration()` now reports a mutable duration in seconds, accepting any uint256 including zero. The current admin proposes with `proposeMinPauseDurationChange(value)`, cancels with `cancelMinPauseDurationChange()`, or executes with `executeMinPauseDurationChange()` after the full `CONFIG_CHANGE_DELAY` (equality passes). `minPauseDurationChangePending` explicitly distinguishes a pending zero from no proposal; `pendingMinPauseDuration` and `minPauseDurationProposedAt` expose its value and clock. No-op proposals and overwrites are rejected; cancel/repropose restarts notice.

Execution applies immediately even during an active pause, preserving `pausedAt`. Unpause compares elapsed seconds since that original start against the current duration: reductions can permit immediate unpause, increases can extend the wait, and zero removes the elapsed-time wait. It never unpauses automatically. Pending updates have no effect until execution and do not block unpause; admin authority and the pending-source block still apply. Updates preserve other proposals, observations, mode, transition clocks and pauser memberships. A pending duration proposal survives admin transfer with its original clock and becomes governable only by the new admin.

`challengeThresholdBps()` reports the mutable deviation threshold, initialized by the unchanged constructor/factory `challengeThresholdBps` argument. Valid values remain 1–9999 basis points. The current admin calls `proposeChallengeThresholdChange(value)`, `cancelChallengeThresholdChange()` or, after the full `CONFIG_CHANGE_DELAY`, `executeChallengeThresholdChange()`. `pendingChallengeThresholdBps == 0` means no proposal; `challengeThresholdProposedAt` records its independent notice clock. Invalid/no-op/overwrite/no-pending/unauthorized/early actions revert. Cancellation and reproposal start a new full notice. Equality at the delay boundary permits execution.

Proposal/cancellation preserve the active threshold and transition clocks; pending proposals do not block reads, permissionless transitions or unpause. Execution clears pending challenge/recovery requests and timestamps even if the same observations still qualify: a fresh request must wait the full transition delay under the new policy. The strict primary-relative comparison and equality-in-band rule are unchanged. Threshold updates never read sources, switch mode, pause/unpause, change pausedAt, renew observations or alter other proposals. They work paused/unpaused with unavailable sources. Pending proposals survive admin handover with their original notice and become governable only by the new current admin. Pause duration and threshold are mutable; configuration/challenge/recovery delays, maximum age and feed metadata remain fixed.

Shepherd rejects zero prices, zero/future timestamps, and observations older than the common immutable maximum data age. After rejecting zero/future timestamps, Shepherd accepts `nowMs - timestampMs <= MAX_DATA_AGE * 1000`; equality passes and 1ms over the limit fails. Transitions apply the common limit to both sources, including while paused; stale unselected data does not block consumer reads. Source replacement preserves the limit and never renews observation time. A replacement needing a different limit requires a new Shepherd. Deployers/admins must ensure the timing of both sources fits the limit; matching metadata cannot prove this. No production age defaults are supplied. The existing sibling Morpho and Euler adaptors propagate Shepherd’s stale-data refusal. A recent TWAP endpoint can still include hours-old contributors; the age guard does not establish sampling quality or source trust. Local tests now exercise actual pinned Morpho V2 feed slots and the Euler Chainlink adapter; they do not create lending markets or vault positions.

`latestRoundData()` provides a Chainlink-compatible latest-read subset alongside `decimals()`. It uses the same pause and selected-source checks as native `getCurrentValue()`, validates original milliseconds, then returns the raw price as `int256` and `updatedAt = timestampMs / 1000`. Values above `int256.max` revert with `SignedPriceOverflow` only on this signed surface; native uint256 reads remain supported. Flooring can conservatively make a report appear up to 999ms older downstream. `roundId`, `startedAt` and `answeredInRound` are zero unavailable sentinels, not retrievable history. Shepherd does not implement full AggregatorV3/history support or synthesize rounds on switches.

## How to Use

Use this package with your own npm project. See the [SampleLayerUser repo](https://github.com/tellor-io/SampleLayerUser) for usage examples.

### Pinned upstream consumer integration tests

Run `npm ci`, then `npm run test:upstream`. This compiles the real upstream `MorphoChainlinkOracleV2` and Euler `ChainlinkOracle` from the exact official revisions in [pins.json](integration/upstream/pins.json), then deploys them to Hardhat's temporary chain. Git/network access is needed on the first run. No sibling checkout or Forge is required for this suite. `npm run build:upstream` runs the consumer build alone.

The build caches immutable Git objects in ignored `cache/protocol-consumers/`, reads source directly from the pinned commits, and recompiles on every invocation with the lockfile-pinned `solc-upstream` 0.8.21 compiler. It never loads old compiled JSON. Both consumer builds target Paris; Morpho uses via-IR/999999 optimizer runs and Euler uses no via-IR/100000 runs. This is the explicit test compilation profile for those consumer import closures, not an assertion that every upstream repository target uses these settings. Core contracts remain on Solidity 0.8.19. [Audit handoff](docs/AUDIT-HANDOFF.md) lists all revisions and reproducibility limits.

The suite covers unequal token/feed decimals, selected primary/backup modes, recovery and migration, full-ms validity, signed range and pause/failure propagation. Most edge cases inject source faults through `PriceSourceMock`; a composed case uses real DataBridge attestations, DataBank history, TWAP/spot readers, Shepherd and both external consumers. These are oracle-consumer tests, not live or funded protocol operations.

### Deployment composition (illustrative, not production calibration)

1. Establish each query's base/quote direction and raw precision. For Morpho, use collateral/USD and loan/USD feeds sharing the same quote unit. Metadata equality cannot prove those semantics or source trust.
2. Deploy the source readers, then one Shepherd per query. The bank/bridge must already be configured. This example shows one feed; repeat with its own query and precision for the other feed:

```js
// Twap, Spot and Shepherd are ethers contract factories; bank is the DataBank address.
const primary = await Twap.deploy(bank, queryId, precision, 60, 30000);
const backup = await Spot.deploy(bank, queryId, precision, 60);
const config = {
  queryId, decimals: precision, primarySource: primary.target, backupSource: backup.target,
  admin, minPauseDuration: 120, configChangeDelay: 300, challengeThresholdBps: 2000,
  challengeDelaySeconds: 30, recoveryDelaySeconds: 90, maxDataAge: 3600, isPausable: true,
};
const shepherd = await Shepherd.deploy(
  config.queryId, config.decimals, config.primarySource, config.backupSource, config.admin,
  config.minPauseDuration, config.configChangeDelay, config.challengeThresholdBps,
  [config.challengeDelaySeconds, config.recoveryDelaySeconds], config.maxDataAge, config.isPausable
);
// Alternatively, factory.createShepherd(config, ethers.ZeroHash) accepts the same named settings.
```

Reader relay delays and all Shepherd durations are seconds; the TWAP window `30000` is milliseconds and the threshold `2000` is basis points. These values illustrate the API only. Calibrate the common age bound and independent transition delays for both sources, including replacements. Migration preserves identity, precision, delays and age policy; different immutable settings require a new deployment. A recent TWAP endpoint still does not bound its contributors' age or sampling gaps.

DataBank construction is `(dataBridge, optimisticDelay, maxAttestationAge, maxDataAge)`. All three timing values are positive immutable seconds; there is no additional optimistic-delay floor. Previous values were `43200`, `600`, and `86400`, respectively. Deployers must choose a dispute-safe delay and compatible age limits. DataBank retains exclusive whole-second age limits and inclusive optimistic-delay equality; Shepherd independently validates original milliseconds.

`createShepherd(config, userSalt)` uses CREATE2 with `keccak256(abi.encode(msg.sender, userSalt))`. The address commits to all constructor arguments; duplicate configurations require distinct caller salts. Factory registration proves provenance, not safe policy. The custom Morpho/Euler adapters now require a trusted Shepherd factory as their first constructor argument and reject unregistered Shepherds. The stock upstream consumers are unchanged. These ABI changes require updated deployment callers and fresh deployments.

3. Deploy the protocol consumer after its Shepherds. For collateral with 18 token decimals, loan with 6 token decimals, and respective feed precisions 8 and 18:

```js
const morphoOracle = await MorphoChainlinkOracleV2.deploy(
  ethers.ZeroAddress, 1, collateralShepherd.target, ethers.ZeroAddress, 18,
  ethers.ZeroAddress, 1, loanShepherd.target, ethers.ZeroAddress, 6
);
// A single feed answers baseAsset/quoteAsset, not a two-feed collateral/loan ratio.
const eulerOracle = await ChainlinkOracle.deploy(baseAsset, quoteAsset, shepherd.target, 3600);
```

Morpho's unused second feed slots and optional vaults use the supported zero-address/default-sample setup. V2 computes the collateral/loan ratio in smallest-token units scaled by 1e36; it does not inspect query IDs, timestamps or cross-feed skew. Each Shepherd supplies its own freshness refusal. Two individually fresh reports 20 minutes apart can still be composed, unlike the custom Morpho adapter's skew check. Wire the queries and token decimals deliberately.

Euler's feed must directly describe `baseAsset/quoteAsset`; in the test, its quote asset represents USD units and is independent of Morpho's loan/USD feed. Euler returns direct/inverse amount quotes and equal bid/ask, adding its immutable `maxStaleness` in seconds (the pinned implementation permits 60 seconds through 72 hours). It consumes the zero round sentinels successfully because it uses only answer and updatedAt. Choose a compatible consumer limit: a stricter Euler limit can refuse a Shepherd-accepted report. For integer chain time `t`, source milliseconds `m` and integer limit `L`, `1000*t-m <= 1000*L` is equivalent to `t-floor(m/1000) <= L`; equal integer limits do not disagree merely because of flooring. Original-ms validity still rejects a future timestamp before conversion.

Shepherd allows precision 0–77, but each consumer has narrower scaling/arithmetic constraints. Check the selected consumer's exponent/product ranges as well as raw prices fitting `int256`; Shepherd neither rescales nor guarantees every permitted precision fits every consumer. This latest-read subset has no retrievable rounds. The changed constructor/factory/migration ABI requires new deployments, not storage-compatible upgrades.

### Artifact and release checkpoint

The seven implementation increments still require human review/commit and release validation. `artifacts/` remains temporarily ignored; 20 older artifact/debug JSON files are still tracked, while new reader/factory/interface artifacts are not. Release must build a clean artifact tree from reviewed source, remove obsolete generated outputs, re-track the required current artifacts (and resolve debug/build-info references), and remove the temporary ignore rule. Include the factory, IPriceSource, both source readers and the updated Shepherd/interface ABIs. Then inspect `npm pack` contents and test installing/importing the packed package in an isolated consumer. The current artifact folder is not release-ready. No npm publication or live deployment has occurred.

### Local Shepherd / Morpho integration tests

During the Shepherd rebuild, run `npm run test:morpho` to test the local contracts together without publishing an npm package. This requires this repo's installed npm dependencies, Forge on `PATH`, and a local `morpho-tellor-adapter` checkout with its Foundry dependencies and Solidity 0.8.20 compiler available.

The default adaptor location is the sibling directory `../morpho-tellor-adapter`. To use another checkout:

```bash
MORPHO_ADAPTER_ROOT=/path/to/morpho-tellor-adapter npm run test:morpho
```

The suite runs `forge build` using that checkout's configuration before loading its compiled adaptor. It then deploys the adaptor, real Shepherds, spot/TWAP readers, DataBridge, and shared DataBank to Hardhat's temporary blockchain. Source mocks inject timestamps or failures that the real bank cannot normally produce. Build failures stop the suite; it does not fall back to old bytecode. It tests the selected working tree, including uncommitted changes, rather than an npm release.

`npm test` remains the standalone Shepherd suite and does not require the adaptor checkout. The separate integration suite is in `integration/MorphoTellorOracle.js`. These tests exercise oracle reads and source transitions, not complete Morpho borrowing/liquidation transactions or npm installation. A local `npm pack` installation check remains part of release preparation; no publication is required for it.

### Local Shepherd / Euler integration tests

Run `npm run test:euler` with the same prerequisites and a sibling `../euler-tellor-adapter` checkout containing its Foundry dependencies. It builds the adaptor before testing single-feed direct/inverse quotes and source transitions; it does not exercise complete Euler vault transactions. To use another checkout:

```bash
EULER_ADAPTER_ROOT=/path/to/euler-tellor-adapter npm run test:euler
```

### Install

```bash
npm install usingtellorlayer
```

### Usage
```solidity
import "usingtellorlayer/contracts/interfaces/ITellorDataBridge.sol";

contract PriceContract {
    ITellorDataBridge public dataBridge;
    uint256 public price;

    constructor(address _dataBridge) {
        dataBridge = ITellorDataBridge(_dataBridge);
    }

    function updateOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) public {
        // verify that data came from tellor chain
        dataBridge.verifyOracleData(_attestData, _currentValidatorSet, _sigs);
        // NOTE: This is a simplified example. More security checks should be done
        // in production to ensure data integrity.
        price = abi.decode(_attestData.report.value, (uint256));
    }
}
```

### Addresses:
Find Tellor contract addresses [here](https://docs.tellor.io/tellor/using-tellor-data/contracts-reference).

## Testing this Repo
Open a terminal and run:

```bash
git clone https://github.com/tellor-io/UsingTellorLayer.git
cd UsingTellorLayer
npm i
npx hardhat test
```

## Secure Integrations

For secure integrations, refer to the [tellor docs](https://docs.tellor.io/tellor/using-tellor-data/integrating-tellor-data). Also, see example integrations in the [SampleLayerUser repo](https://github.com/tellor-io/SampleLayerUser).

## Maintainers
@themandalore
@brendaloya

## How to Contribute
Check out our issues log here on Github out in our [Discord](https://discord.gg/teAMSZAfJZ)

## Contributors
This repository is maintained by the Tellor team - www.tellor.io

## Copyright
Tellor Inc. 2025
