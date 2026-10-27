const { loadFixture, time, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

describe("TellorShepherd - Validated backup helper", function () {
  async function fixture() {
    const [admin] = await ethers.getSigners();
    const queryId = ethers.id("backup-read-feed");
    // A usable primary response makes accidental fallback observable.
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target);
    const report = await h.prepareOracleData(queryId,
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [999]), validatorSet);
    await bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    const Backup = await ethers.getContractFactory("BackupOracleMock");
    const backup = await Backup.deploy(queryId);
    const replacement = await Backup.deploy(queryId);
    const Harness = await ethers.getContractFactory("TellorShepherdHarness");
    const shepherd = await Harness.deploy({
      queryId, dataBank: bank.target, backupOracle: backup.target,
      admin: admin.address, relayReadDelay: 60, minPauseDuration: 120,
      dataBankChangeDelay: 300, backupChangeDelay: 600, twapWindowMs: 30000,
      challengeThresholdBps: 2000, challengeDelaySeconds: 30, recoveryDelaySeconds: 90,
      maxPriceAge: 604800, decimals: 18
    });
    await time.increase(61);
    expect((await shepherd.getCurrentValue())[0]).to.equal(999);
    return { admin, backup, replacement, shepherd };
  }

  it("preserves values and millisecond timestamps without adding a read delay", async function () {
    const { backup, shepherd } = await loadFixture(fixture);
    const timestamp = BigInt(await time.latest()) * 1000n + 123n;
    for (const value of [1n, ethers.parseEther("2000"), ethers.MaxUint256]) {
      await backup.configureRead(value, timestamp, 0);
      expect(await shepherd.readBackup()).to.deep.equal([value, timestamp]);
    }
    await time.increase(7 * 86400);
    expect(await shepherd.readBackup()).to.deep.equal([ethers.MaxUint256, timestamp]);
  });

  it("leaves timestamp rejection to the consumer entry point", async function () {
    const { backup, shepherd } = await loadFixture(fixture);
    for (const timestamp of [0n, ethers.MaxUint256]) {
      await backup.configureRead(100, timestamp, 0);
      expect(await shepherd.readBackup()).to.deep.equal([100n, timestamp]);
    }
  });

  it("rejects zero prices rather than substituting primary data", async function () {
    const { backup, shepherd } = await loadFixture(fixture);
    await backup.configureRead(0, 123456, 0);
    await expect(shepherd.readBackup()).to.be.revertedWithCustomError(shepherd, "ZeroValue");
  });

  it("propagates unavailable observations, including a previously readable observation withdrawn by the backup", async function () {
    const { backup, shepherd } = await loadFixture(fixture);
    await expect(shepherd.readBackup()).to.be.revertedWithCustomError(backup, "ReadUnavailable");
    await backup.configureRead(100, 123456, 0);
    expect(await shepherd.readBackup()).to.deep.equal([100n, 123456n]);
    // Models a source refusing disputed data; actual dispute rules belong to the concrete backup.
    await backup.configureRead(100, 123456, 1);
    await expect(shepherd.readBackup()).to.be.revertedWithCustomError(backup, "ReadUnavailable");
  });

  it("rejects malformed ABI output from a successful dependency call", async function () {
    const { backup, shepherd } = await loadFixture(fixture);
    await backup.configureRead(100, 123456, 2);
    await expect(shepherd.readBackup()).to.be.reverted;
    // A single encoded word is still missing the required timestamp.
    await setCode(backup.target, "0x600160005260206000f3");
    await expect(shepherd.readBackup()).to.be.reverted;
  });

  it("fails closed if the configured backup loses its code", async function () {
    const { backup, shepherd } = await loadFixture(fixture);
    await setCode(backup.target, "0x");
    await expect(shepherd.readBackup()).to.be.reverted;
  });

  it("keeps helper inspection separate from paused consumer reads", async function () {
    const { backup, shepherd } = await loadFixture(fixture);
    await backup.configureRead(100, 123456, 0);
    await shepherd.pause();
    expect(await shepherd.readBackup()).to.deep.equal([100n, 123456n]);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "ShepherdPaused");
    expect(await shepherd.mode()).to.equal(0);
  });

  it("uses the old backup during notice and the replacement after valid migration", async function () {
    const { backup, replacement, shepherd } = await loadFixture(fixture);
    await backup.configureRead(100, 123456, 0);
    await replacement.configureRead(200, 234567, 0);
    await shepherd.proposeBackupChange(replacement.target);
    expect(await shepherd.readBackup()).to.deep.equal([100n, 123456n]);
    await shepherd.pause();
    await time.increase(600);
    await shepherd.executeBackupChange();
    expect(await shepherd.readBackup()).to.deep.equal([200n, 234567n]);
    await replacement.configureRead(200, 234567, 1);
    // No fallback to the old, still-readable backup.
    await expect(shepherd.readBackup()).to.be.revertedWithCustomError(replacement, "ReadUnavailable");
  });
});
