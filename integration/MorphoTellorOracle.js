const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

// Kept outside test/ so the normal suite does not require the sibling repository or Forge.
describe("Morpho adaptor - Real Shepherd integration", function () {
  let adaptorArtifact;
  before(function () {
    this.timeout(120000);
    const root = path.resolve(process.env.MORPHO_ADAPTER_ROOT || path.join(__dirname, "../../morpho-tellor-adapter"));
    // Build before reading bytecode, including when this file is run directly with Hardhat.
    // Foundry owns the adaptor's compiler settings; no source copies or pragma changes.
    execFileSync("forge", ["build", "--root", root], { stdio: "inherit", timeout: 110000 });
    adaptorArtifact = JSON.parse(fs.readFileSync(path.join(root, "out/MorphoTellorOracle.sol/MorphoTellorOracle.json"), "utf8"));
  });

  const unit = 10n ** 18n;
  const collateralPrice = 3000n * unit;
  const loanPrice = unit;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const spotId = (asset) => ethers.keccak256(coder.encode(
    ["string", "bytes"], ["SpotPrice", coder.encode(["string", "string"], [asset, "usd"])]
  ));

  async function fixture(feedDecimals = [18, 18]) {
    const [admin, streamer, outsider] = await ethers.getSigners();
    const ids = [spotId("eth"), spotId("usdc")];
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target);
    const Stream = await ethers.getContractFactory("StreamBackupOracle");
    const backup = await Stream.deploy(admin.address, streamer.address, 60);
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherds = [];
    for (const [leg, id] of ids.entries()) {
      shepherds.push(await Shepherd.deploy({
        queryId: id, dataBank: bank.target, backupOracle: backup.target,
        admin: admin.address, relayReadDelay: 60, minPauseDuration: 120,
        dataBankChangeDelay: 300, backupChangeDelay: 600, twapWindowMs: 30000,
        challengeThresholdBps: 2000, challengeDelaySeconds: 30, recoveryDelaySeconds: 90,
        maxPriceAge: 3600, decimals: feedDecimals[leg]
      }));
    }
    const Adaptor = new ethers.ContractFactory(adaptorArtifact.abi, adaptorArtifact.bytecode.object, admin);
    const f = { admin, streamer, outsider, ids, validatorSet, Bank, bank, backup, shepherds, Adaptor };
    f.oracle = await deployAdaptor(f);
    return f;
  }

  async function deployAdaptor(f, { skew = 600, decimals = [18, 6, 18, 18], ids = f.ids } = {}) {
    return f.Adaptor.deploy(f.shepherds[0].target, f.shepherds[1].target,
      skew, "Local Shepherd WETH/USDC", ...ids, ...decimals);
  }

  async function relay(f, leg, value, timestamp, bank = f.bank) {
    const report = await h.prepareOracleData(f.ids[leg], coder.encode(["uint256"], [value]), f.validatorSet,
      { aggregateTimestamp: timestamp, attestationTimestamp: (await time.latest()) * 1000 });
    await bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
  }

  async function primaryFixture() {
    const f = await fixture();
    f.startMs = (await time.latest() - 120) * 1000 + 17;
    for (const leg of [0, 1]) {
      const price = leg === 0 ? collateralPrice : loanPrice;
      await relay(f, leg, price, f.startMs);
      await relay(f, leg, price, f.startMs + 30000);
    }
    await time.increase(61);
    return f;
  }

  async function switchToBackup(f, leg, value) {
    // A new 50% deviation permits a real challenge without changing the prior reference.
    const primaryPrice = leg === 0 ? collateralPrice : loanPrice;
    await relay(f, leg, primaryPrice * 3n / 2n, f.startMs + 40000);
    await f.backup.connect(f.streamer).submitValue(f.ids[leg], value);
    const index = (await f.backup.reportCount(f.ids[leg])) - 1n;
    const report = await f.backup.reports(f.ids[leg], index);
    await f.shepherds[leg].connect(f.outsider).requestChallenge();
    await relay(f, leg, primaryPrice, f.startMs + 45000);
    await time.increase(30);
    await f.shepherds[leg].connect(f.outsider).resolveChallenge();
    await time.increaseTo(report.submittedAt + 60n);
    return [value, report.submittedAt * 1000n];
  }

  for (const modes of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    it(`prices collateral/loan source modes ${modes.join("/")} and preserves each source timestamp`, async function () {
      const f = await loadFixture(primaryFixture);
      const expected = [[collateralPrice, BigInt(f.startMs + 30000)], [loanPrice, BigInt(f.startMs + 30000)]];
      for (const leg of [0, 1]) {
        if (modes[leg]) expected[leg] = await switchToBackup(f, leg, leg === 0 ? 2900n * unit : 2n * unit);
        expect(await f.shepherds[leg].mode()).to.equal(modes[leg]);
      }
      for (const leg of [0, 1]) expect(await f.shepherds[leg].getCurrentValue()).to.deep.equal(expected[leg]);
      // Independent BigInt arithmetic has no 256-bit intermediate limit.
      expect(await f.oracle.price()).to.equal(expected[0][0] * 10n ** 24n / expected[1][0]);
    });
  }

  it("validates immutable Shepherd feed identities", async function () {
    const f = await loadFixture(primaryFixture);
    await expect(deployAdaptor(f, { ids: [f.ids[1], f.ids[0]] }))
      .to.be.revertedWithCustomError(f.oracle, "InvalidConfiguration");
    expect(await f.oracle.collateralShepherd()).to.equal(f.shepherds[0].target);
    expect(await f.oracle.loanShepherd()).to.equal(f.shepherds[1].target);
    expect(await f.oracle.collateralQueryId()).to.equal(f.ids[0]);
    expect(await f.oracle.loanQueryId()).to.equal(f.ids[1]);
  });

  for (const leg of [0, 1]) {
    for (const delta of [-1, 0, 1]) {
      it(`propagates Shepherd staleness at limit ${delta >= 0 ? "+" : ""}${delta}ms on leg ${leg}`, async function () {
        const f = await loadFixture(fixture);
        const baseMs = (await time.latest() - 120) * 1000;
        for (const index of [0, 1]) {
          await relay(f, index, index === 0 ? collateralPrice : loanPrice, baseMs - (index === leg ? delta : 0));
        }
        await time.increaseTo(baseMs / 1000 + 3600);
        if (delta > 0) await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "StalePrice");
        else expect(await f.oracle.price()).to.equal(3000n * 10n ** 24n);
      });
    }
    it(`propagates primary immaturity and pause from leg ${leg}`, async function () {
      const f = await loadFixture(fixture);
      const stamp = (await time.latest() - 120) * 1000;
      await relay(f, 1 - leg, leg === 0 ? loanPrice : collateralPrice, stamp);
      await time.increase(61);
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "NoMatureData");
      await relay(f, leg, leg === 0 ? collateralPrice : loanPrice, stamp);
      const relayAt = BigInt(await time.latest());
      await time.increaseTo(relayAt + 60n);
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "NoMatureData");
      await time.increase(1);
      expect(await f.oracle.price()).to.equal(3000n * 10n ** 24n);
      await f.shepherds[leg].pause();
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "ShepherdPaused");
    });
    it(`propagates backup disputes and pause from leg ${leg}`, async function () {
      const f = await loadFixture(primaryFixture);
      await switchToBackup(f, leg, leg === 0 ? collateralPrice : loanPrice);
      expect(await f.oracle.price()).to.equal(3000n * 10n ** 24n);
      await f.shepherds[leg].pause();
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "ShepherdPaused");
      await time.increase(120);
      await f.shepherds[leg].unpause();
      await f.backup.disputeValue(f.ids[leg], 0);
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.backup, "NoUsableReport");
    });
    it(`ages backup leg ${leg} from submission time, including after repeated reads`, async function () {
      const f = await loadFixture(primaryFixture);
      const pair = await switchToBackup(f, leg, leg === 0 ? collateralPrice : loanPrice);
      // Keep the other leg one second younger so its age cannot mask this boundary.
      await relay(f, 1 - leg, leg === 0 ? loanPrice : collateralPrice, Number(pair[1] + 1000n));
      await time.increaseTo(pair[1] / 1000n + 3600n);
      expect(await f.shepherds[leg].getCurrentValue()).to.deep.equal(pair);
      expect(await f.oracle.price()).to.equal(3000n * 10n ** 24n);
      await time.increase(1);
      await expect(f.shepherds[leg].getCurrentValue()).to.be.revertedWithCustomError(f.shepherds[leg], "StalePrice");
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "StalePrice");
    });
  }

  for (const olderLeg of [0, 1]) {
    for (const excess of [0, 1]) {
      it(`checks ${600000 + excess}ms cross-feed skew with leg ${olderLeg} older`, async function () {
        const f = await loadFixture(fixture);
        const baseMs = (await time.latest() - 120) * 1000 + 17;
        for (const leg of [0, 1]) {
          await relay(f, leg, leg === 0 ? collateralPrice : loanPrice,
            baseMs - (leg === olderLeg ? 600000 + excess : 0));
        }
        await time.increase(61);
        // Both feeds are within 3600 seconds; only the skew differs between cases.
        if (excess) await expect(f.oracle.price()).to.be.revertedWithCustomError(f.oracle, "CrossFeedSkew");
        else expect(await f.oracle.price()).to.equal(3000n * 10n ** 24n);
      });
    }
  }

  it("rejects excessive skew between a fresh backup submission and an individually fresh primary", async function () {
    const f = await loadFixture(primaryFixture);
    const strict = await deployAdaptor(f, { skew: 60 });
    await switchToBackup(f, 0, collateralPrice);
    expect(await f.oracle.price()).to.equal(3000n * 10n ** 24n);
    await expect(strict.price()).to.be.revertedWithCustomError(strict, "CrossFeedSkew");
  });

  for (const leg of [0, 1]) {
    it(`validates zero/future timestamps and failed backup responses through real Shepherd leg ${leg}`, async function () {
      const f = await loadFixture(primaryFixture);
      await switchToBackup(f, leg, leg === 0 ? collateralPrice : loanPrice);
      const Mock = await ethers.getContractFactory("BackupOracleMock");
      const mock = await Mock.deploy(f.ids[leg]);
      await mock.configureRead(leg === 0 ? collateralPrice : loanPrice, f.startMs + 30000, 0);
      await f.shepherds[leg].proposeBackupChange(mock.target);
      await f.shepherds[leg].pause();
      await time.increase(600);
      await f.shepherds[leg].executeBackupChange();
      await f.shepherds[leg].unpause();
      // The concrete stream cannot author these timestamps. Fault injection stays at the source.
      await mock.configureRead(leg === 0 ? collateralPrice : loanPrice, 0, 0);
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "InvalidTimestamp");
      const nextBlock = BigInt(await time.latest()) + 1n;
      await time.setNextBlockTimestamp(nextBlock);
      await mock.configureRead(leg === 0 ? collateralPrice : loanPrice, nextBlock * 1000n + 1n, 0);
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "InvalidTimestamp");
      const stamp = BigInt(f.startMs + 30000);
      await mock.configureRead(0, stamp, 0);
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "ZeroValue");
      await mock.configureRead(1, stamp, 1);
      await expect(f.oracle.price()).to.be.revertedWithCustomError(mock, "ReadUnavailable");
      await mock.configureRead(1, stamp, 2);
      await expect(f.oracle.price()).to.be.reverted;
    });
  }

  for (const example of [
    { label: "mixed token/feed decimals", prices: [3000n * 10n ** 8n, 2n * unit], decimals: [18, 6, 8, 18], scale: 10n ** 34n },
    { label: "rounding only at final division", prices: [10n, 3n], decimals: [18, 6, 18, 18], scale: 10n ** 24n },
    { label: "a 512-bit intermediate product", prices: [(1n << 191n) + 1n, (1n << 190n) + 3n], decimals: [18, 6, 18, 18], scale: 10n ** 24n },
    { label: "maximum supported scale", prices: [1n, 10n ** 18n], decimals: [0, 41, 0, 0], scale: 10n ** 77n },
  ]) {
    it(`computes ${example.label} from real primary reports`, async function () {
      const f = await fixture(example.decimals.slice(2));
      const oracle = await deployAdaptor(f, { decimals: example.decimals });
      const stamp = (await time.latest() - 120) * 1000 + 17;
      for (const leg of [0, 1]) await relay(f, leg, example.prices[leg], stamp);
      await time.increase(61);
      expect(await oracle.price()).to.equal(example.prices[0] * example.scale / example.prices[1]);
    });
  }

  it("refuses a cross-rate that rounds to zero", async function () {
    const f = await loadFixture(fixture);
    const stamp = (await time.latest() - 120) * 1000;
    await relay(f, 0, 1n, stamp);
    await relay(f, 1, 10n ** 25n, stamp);
    await time.increase(61);
    await expect(f.oracle.price()).to.be.revertedWithCustomError(f.oracle, "ZeroPrice");
  });

  it("refuses an unrepresentable final result even though both primary prices are valid", async function () {
    const f = await fixture([0, 0]);
    const oracle = await deployAdaptor(f, { decimals: [0, 41, 0, 0] });
    const stamp = (await time.latest() - 120) * 1000;
    const collateral = (1n << 192n) - 1n;
    await relay(f, 0, collateral, stamp);
    await relay(f, 1, 1n, stamp);
    await time.increase(61);
    expect(collateral * 10n ** 77n).to.be.greaterThan(ethers.MaxUint256);
    await expect(oracle.price()).to.be.revertedWithCustomError(oracle, "MulDivOverflow");
  });

  it("keeps the adaptor address wiring through a paused bank migration and later recovery", async function () {
    const f = await loadFixture(primaryFixture);
    await switchToBackup(f, 0, 2900n * unit);
    const replacement = await f.Bank.deploy(await f.bank.dataBridge());
    await relay(f, 0, 3100n * unit, f.startMs + 50000, replacement);
    await f.shepherds[0].proposeDataBankChange(replacement.target);
    await f.shepherds[0].pause();
    await time.increase(300);
    await f.shepherds[0].executeDataBankChange();
    await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[0], "ShepherdPaused");
    await f.backup.setCanRecover(f.ids[0], true);
    await f.shepherds[0].connect(f.outsider).requestRecovery();
    await time.increase(90);
    await f.shepherds[0].connect(f.outsider).executeRecovery();
    await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[0], "ShepherdPaused");
    await f.shepherds[0].unpause();
    expect(await f.oracle.collateralShepherd()).to.equal(f.shepherds[0].target);
    expect(await f.oracle.price()).to.equal(3100n * 10n ** 24n);
  });
});
