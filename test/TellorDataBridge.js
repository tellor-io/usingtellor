const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const h = require("../src/helpers/evmHelpers");

describe("TellorDataBridge admission", function () {
  const unbonding = 100;

  async function fixture() {
    const [deployer, guardian, outsider] = await ethers.getSigners();
    const validators = await h.createTellorValset();
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(guardian.address, validators.domainSeparator);
    return { deployer, guardian, outsider, validators, Bridge, bridge };
  }

  function checkpoint(f, power, timestamp) {
    return h.calculateValCheckpoint(f.validators.valsetHash, power, timestamp, f.validators.domainSeparator);
  }

  async function initialize(f, duration = unbonding) {
    return f.bridge.init(f.validators.powerThreshold, f.validators.timestamp, duration, f.validators.checkpoint);
  }

  async function write(f, phase, power, timestamp) {
    const next = checkpoint(f, power, timestamp);
    if (phase === "init") return f.bridge.init(power, timestamp, unbonding, next);
    if (phase === "reset") return f.bridge.connect(f.guardian).guardianResetValidatorSet(power, timestamp, next);
    const sigs = h.getSigStructArray(f.validators.wallets.map(w => h.layerSign(next, w.privateKey)));
    return f.bridge.updateValidatorSet(f.validators.valsetHash, power, timestamp, f.validators.structArray(), sigs);
  }

  async function state(bridge) {
    return Promise.all([bridge.initialized(), bridge.powerThreshold(), bridge.validatorTimestamp(),
      bridge.unbondingPeriod(), bridge.lastValidatorSetCheckpoint()]);
  }

  it("rejects only zero guardian and unbonding inputs, without consuming initialization", async function () {
    const f = await loadFixture(fixture);
    await expect(f.Bridge.deploy(ethers.ZeroAddress, f.validators.domainSeparator))
      .to.be.revertedWithCustomError(f.bridge, "InvalidGuardian");
    await expect(initialize(f, 0)).to.be.revertedWithCustomError(f.bridge, "InvalidUnbondingPeriod");
    expect(await f.bridge.initialized()).to.equal(false);
    await initialize(f, 1);
    expect(await f.bridge.unbondingPeriod()).to.equal(1);
    const other = await f.Bridge.deploy(f.guardian.address, f.validators.domainSeparator);
    await other.init(f.validators.powerThreshold, f.validators.timestamp, ethers.MaxUint256, f.validators.checkpoint);
    expect(await other.unbondingPeriod()).to.equal(ethers.MaxUint256);
  });

  for (const phase of ["init", "reset", "update"]) {
    for (const offset of [0n, 1n, 1000n, ethers.MaxUint256]) {
      it(`${phase}: accepts exact-now and rejects future timestamp offset ${offset}`, async function () {
        const f = await loadFixture(fixture);
        if (phase !== "init") await initialize(f);
        if (phase === "reset") await time.increase(unbonding);
        const before = await state(f.bridge);
        const at = (await time.latest()) + 1;
        const timestamp = offset === ethers.MaxUint256 ? offset : BigInt(at) * 1000n + offset;
        await time.setNextBlockTimestamp(at);
        const tx = write(f, phase, f.validators.powerThreshold, timestamp);
        if (offset === 0n) {
          await tx;
          expect(await f.bridge.validatorTimestamp()).to.equal(timestamp);
          expect(await f.bridge.lastValidatorSetCheckpoint()).to.equal(checkpoint(f, f.validators.powerThreshold, timestamp));
        } else {
          await expect(tx).to.be.revertedWithCustomError(f.bridge, "ValidatorTimestampInFuture");
          expect(await state(f.bridge)).to.deep.equal(before);
        }
      });
    }

    it(`${phase}: rejects a matching zero-threshold checkpoint without changing state`, async function () {
      const f = await loadFixture(fixture);
      if (phase !== "init") await initialize(f);
      if (phase === "reset") await time.increase(unbonding);
      const before = await state(f.bridge);
      await expect(write(f, phase, 0, BigInt(await time.latest()) * 1000n))
        .to.be.revertedWithCustomError(f.bridge, "InvalidPowerThreshold");
      expect(await state(f.bridge)).to.deep.equal(before);
    });
  }

  it("emits the named checkpoint after reset and still requires signed reports", async function () {
    const f = await loadFixture(fixture);
    await initialize(f);
    await time.increase(unbonding);
    const timestamp = BigInt(await time.latest()) * 1000n;
    const next = checkpoint(f, f.validators.powerThreshold, timestamp);
    const tx = await write(f, "reset", f.validators.powerThreshold, timestamp);
    const receipt = await tx.wait();
    const event = receipt.logs.map(log => f.bridge.interface.parseLog(log)).find(log => log.name === "GuardianResetValidatorSet");
    expect(event.args._validatorSetCheckpoint).to.equal(next);
    expect(next).not.to.equal(f.validators.valsetHash);
    const validators = { ...f.validators, checkpoint: next };
    const report = await h.prepareOracleData(ethers.id("bridge-test"), ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [123]), validators);
    const nil = report.sigs.map(() => ({ v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash }));
    await expect(f.bridge.verifyOracleData(report.attestData, report.currentValidatorSet, nil))
      .to.be.revertedWithCustomError(f.bridge, "InsufficientVotingPower");
    await expect(f.bridge.verifyOracleData(report.attestData, report.currentValidatorSet, report.sigs)).not.to.be.reverted;
  });
});
