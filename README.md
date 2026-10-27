[![Tests](https://github.com/tellor-io/UsingTellorLayer/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/tellor-io/UsingTellorLayer/actions/workflows/tests.yml)

# UsingTellorLayer

Use this package to install the Tellor user contracts and test helper functions, and to integrate Tellor into your contracts.

## Contents

- `contracts/interfaces/ITellorDataBridge.sol` - The TellorDataBridge interface
- `contracts/testing/TellorLab.sol` - A testing contract for rapid prototyping with Tellor oracle data
- `contracts/interfaces/ITellorDataBank.sol` - The TellorDataBank interface, a standard interface for reading tellor data
- `contracts/bridge/TellorDataBridge.sol` - The TellorDataBridge contract
- `contracts/databank/TellorShepherd.sol` - Per-feed delayed reads, pause controls, and primary/backup source selection
- `contracts/databank/TellorShepherdFactory.sol` - Permissionless Shepherd deployment and provenance tracking
- `contracts/examples/StreamBackupOracle.sol` - Trusted-streamer backup example with delayed reads and admin-controlled recovery permission
- `src/helpers/evmHelpers.js` - Helper functions for testing

See the [audit handoff](docs/AUDIT-HANDOFF.md) for review scope, build/test commands, and trust assumptions. Local integration coverage does not establish deployment readiness.

## How to Use

Use this package with your own npm project. See the [SampleLayerUser repo](https://github.com/tellor-io/SampleLayerUser) for usage examples.

### Shepherd read APIs

Deploy Shepherd with a single `TellorShepherd.Configuration` struct, also used by the factory. `maxPriceAge` (seconds) and `decimals` are immutable deployment settings. Both primary and backup must use the configured price precision. Choose the maximum age to accommodate observation age, relay/backup maturity delays, and expected reporting gaps.

`getCurrentValue()` and `latestRoundData()` are external wrappers around `_getCurrentValue()` and share pause, source selection, and freshness checks: zero, future, or over-age source timestamps revert, with exact maximum age allowed. `getCurrentValue()` preserves milliseconds; `latestRoundData()` converts source timestamps to seconds and additionally requires the price to fit `int256`. Neither rescales the price. The latter, together with `decimals()`, supports [MorphoChainlinkOracleV2](https://github.com/morpho-org/morpho-blue-oracles/blob/main/src/morpho-chainlink/MorphoChainlinkOracleV2.sol). Round IDs are zero sentinels; historical Chainlink rounds are not implemented. Standard Morpho V2 does not enforce cross-feed timestamp skew. The custom Tellor adaptor below retains that additional policy. Both custom adaptors delegate individual-feed freshness to Shepherd; configure the intended age limit there when deploying.

Deployment requires `RELAY_READ_DELAY - CHALLENGE_DELAY_SECONDS > 60 seconds`, with positive challenge delay and TWAP window configured independently. This leaves time to submit resolution; timely monitoring and relay availability are still required.

Admin can unpause immediately when neither source migration is pending. Source migrations require delayed, paused execution. Deployment configuration no longer includes `minPauseDuration`; `pausedAt` remains available for monitoring.

`paramChangeDelay` is the positive, immutable notice period shared by DataBank, backup, and threshold updates (`PARAM_CHANGE_DELAY`). It replaces the two source-delay configuration fields and getters. Each proposal keeps its own timer. Challenge and recovery delays remain separate.

Admin may call `proposeThresholdChange`, `cancelThresholdChange`, and `executeThresholdChange` while paused or unpaused. Thresholds are 1–9999 bps; cancel before replacing a proposal. `CHALLENGE_THRESHOLD_BPS()` returns the current threshold. Active challenges retain their saved threshold and TWAP reference, and a pending threshold update does not block unpause.

For direct V2 integration tests, initialize the upstream `morpho-blue-oracles` checkout and its submodules, then run:

```bash
MORPHO_CHAINLINK_ROOT=/path/to/morpho-blue-oracles npm run test:morpho-chainlink
```

The default checkout location is `../morpho-blue-oracles`. The suite builds the unmodified V2 contract with its own Solidity 0.8.21 configuration and tests real primary/backup reads, scaling, pause, and staleness.

### Local Shepherd / Morpho integration tests

During the Shepherd rebuild, run `npm run test:morpho` to test the local contracts together without publishing an npm package. This requires this repo's installed npm dependencies, Forge on `PATH`, and a local `morpho-tellor-adapter` checkout with its Foundry dependencies and Solidity 0.8.20 compiler available.

The default adaptor location is the sibling directory `../morpho-tellor-adapter`. To use another checkout:

```bash
MORPHO_ADAPTER_ROOT=/path/to/morpho-tellor-adapter npm run test:morpho
```

The suite runs `forge build` using that checkout's configuration before loading its compiled adaptor. It then deploys the adaptor, real Shepherds, DataBridge, DataBank, and shared stream backup to Hardhat's temporary blockchain. The only source mocks inject timestamps or failures that the stream cannot normally produce. Build failures stop the suite; it does not fall back to old bytecode. It tests the selected working tree, including uncommitted changes, rather than an npm release.

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
