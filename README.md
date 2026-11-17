# Tellor Shepherd

Tellor Shepherd selects between a primary and backup price source. It serves the selected source's data or refuses the read. Switching sources requires explicit transactions and a delay; there is no automatic fallback, and Shepherd never authors a price.

This repository also contains the Tellor DataBridge, DataBank, spot/TWAP readers, and Hardhat test helpers. The npm package name in this checkout is **`usingtellor`**. The repository name and older examples may use UsingTellorLayer; published packages are not evidence of this branch's contents.

- [Shepherd guide](docs/SHEPHERD.md): configuration, reads, transitions, and administration.
- [Audit handoff](docs/AUDIT-HANDOFF.md): validation, known limitations, and release work.
- [DataBridge guide](contracts/bridge/README.md): validator checkpoints and attestation verification.

## Local setup

Use Node.js 22 for the local workflow validated here. CI currently selects Node.js 24. With nvm:

```sh
nvm use 22
node --version
npm ci
npm test
```

If Node 22 is not installed, run `nvm install 22` first. Check `node --version` after changing directories: an older shell-selected Node can fail tests that use `findLastIndex`.

The core build uses **Solidity 0.8.19**, optimizer **200 runs**, EVM target **Paris**, and **no via-IR**. Paris names the EVM instruction set, not the compiler version. It makes the previous compiler default explicit; it is not a claim that Paris is the newest target. Review compiler and EVM compatibility against the intended deployment chains before release.

The factory test enforces a **20,000-byte runtime budget** below the 24,576-byte deployment limit. Changing compiler settings or source changes bytecode and can change CREATE2 addresses.

## Test commands

| Command | Requirements and scope |
| --- | --- |
| `npm test` | Core contracts and package helper exports; no sibling checkout or Forge required. |
| `npm run test:upstream` | Pinned stock Morpho V2 and Euler consumers; Git/network access needed for uncached sources. |
| `npm run build:upstream` | Build those pinned consumers without running tests. |
| `npm run test:morpho` | Forge and `../morpho-tellor-adapter` with dependencies installed. |
| `npm run test:euler` | Forge and `../euler-tellor-adapter` with dependencies installed. |

Override sibling locations with `MORPHO_ADAPTER_ROOT` or `EULER_ADAPTER_ROOT`. The custom suites build their selected checkouts before testing. The upstream suite reads exact commits from [pins.json](integration/upstream/pins.json) and recompiles them on every run. All are local oracle-consumer tests, not funded lending or vault operations.

## Deployment composition (illustrative, not production calibration)

Deploy and initialize the bridge, deploy the DataBank, then deploy readers and a Shepherd. These sample durations are **not production recommendations**. Choose compatible source timing, freshness limits, precision, quote direction, and administrative controls.

```js
// Inside an async Hardhat script function. bank is an existing DataBank address;
// queryId, precision and admin are chosen for this feed.
const { ethers } = require("hardhat");
const Twap = await ethers.getContractFactory("TellorTwapSource");
const Spot = await ethers.getContractFactory("TellorSpotSource");
const Factory = await ethers.getContractFactory("TellorShepherdFactory");
const primary = await Twap.deploy(bank, queryId, precision, 60, 30000);
const backup = await Spot.deploy(bank, queryId, precision, 60);
const factory = await Factory.deploy(); // Reuse the intended trusted factory in production.
await Promise.all([primary.waitForDeployment(), backup.waitForDeployment(), factory.waitForDeployment()]);

const config = {
  description: "ETH/USD", decimals: precision,
  primarySource: primary.target, backupSource: backup.target, admin,
  minPauseDuration: 120, configChangeDelay: 300, challengeThresholdBps: 2000,
  challengeDelaySeconds: 30, recoveryDelaySeconds: 90,
  maxDataAge: 3600, isPausable: true,
};
const salt = ethers.id("ETH/USD deployment 1");
const address = await factory.createShepherd.staticCall(config, salt);
await (await factory.createShepherd(config, salt)).wait();
const shepherd = await ethers.getContractAt("TellorShepherd", address);
```

Relay delays and core durations are seconds; `30000` is a TWAP window in milliseconds. Prices retain source precision. Factory deployment records provenance, not safe policy or trustworthy prices. Use the same caller for the simulated and submitted creation calls: salts are caller-scoped, and every constructor setting contributes to the address.

Direct Shepherd deployment is also supported, but the custom Morpho/Euler adapters require membership in their configured trusted Shepherd factory. See the [guide](docs/SHEPHERD.md#consumer-integration) for consumer wiring.

## Package usage

The package root exports **Hardhat test helpers**. It requires an existing Hardhat 2 project with the ethers plugin loaded (for example, through `@nomicfoundation/hardhat-toolbox`). Install/configure that tooling in the consumer project; this package's development dependencies are not installed for consumers.

```js
// In a consumer Hardhat test or script, after its configuration loads the ethers plugin:
const { createTellorValset, prepareOracleData, advanceTime } = require("usingtellor");
```

Import Solidity and compiled JSON using explicit paths; the root does not export contract factories or an `artifacts` object:

```solidity
import { ITellorShepherd } from "usingtellor/contracts/interfaces/ITellorShepherd.sol";
```

```js
const shepherdArtifact = require(
  "usingtellor/artifacts/contracts/databank/TellorShepherd.sol/TellorShepherd.json"
);
```

To test a local package, run `npm pack --pack-destination /path/to/output`, then install the resulting tarball in a consumer project. The current artifact tree still needs the [release checks](docs/AUDIT-HANDOFF.md#release-work); a successful helper import does not validate all packaged contract bytecode. No publication is part of this workflow.

## Main contracts

| Component | Role |
| --- | --- |
| [TellorShepherd](contracts/databank/TellorShepherd.sol) | Per-feed selection, read refusal, and delayed administration. |
| [IPriceSource](contracts/interfaces/IPriceSource.sol) | `getCurrentValue()` and `decimals()`; no generic query-ID check. |
| [TellorShepherdFactory](contracts/databank/TellorShepherdFactory.sol) | Caller-scoped CREATE2 deployment and registration. |
| [TellorSpotSource](contracts/sources/TellorSpotSource.sol) / [TellorTwapSource](contracts/sources/TellorTwapSource.sol) | Readers with fixed query IDs, precision, and timing. |
| [TellorDataBank](contracts/databank/TellorDataBank.sol) | Admission and history for relayed reports. |
| [TellorDataBridge](contracts/bridge/TellorDataBridge.sol) | Attestation verification against a validator checkpoint. |
| [TellorLab](contracts/testing/TellorLab.sol) | Test support for relaying oracle data. |
| [StreamBackupOracle](contracts/examples/StreamBackupOracle.sol) | Standalone trusted-streamer example; not a Shepherd dependency. |

Maintained by the Tellor team. Contribution instructions are in [AGENTS.md](AGENTS.md).
