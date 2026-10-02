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
