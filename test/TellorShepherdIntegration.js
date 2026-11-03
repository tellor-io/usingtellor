const { loadFixture, time, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

// Production bridge, bank, and Shepherd: no mode setters or fabricated TWAP responses.
describe("TellorShepherd - Real DataBank integration", function () {
  async function fixture() {
    const [admin, requester, executor] = await ethers.getSigners();
    const queryId = ethers.id("real-shepherd-feed");
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target);
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherd = await Shepherd.deploy(queryId, bank.target, admin.address,
      60, 120, 300, 30000, 2000, [30, 90]);
    return { admin, requester, executor, queryId, validatorSet, bridge, Bank, bank, Shepherd, shepherd,
      start: (await time.latest() - 120) * 1000 + 17 };
  }

  async function relay(f, offset, value) {
    const report = await h.prepareOracleData(f.queryId,
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [value]), f.validatorSet,
      { aggregateTimestamp: f.start + offset, attestationTimestamp: (await time.latest()) * 1000 });
    await f.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    return (await f.bank.getCurrentAggregateData(f.queryId)).relayTimestamp;
  }

  async function deviatingFixture() {
    const f = await fixture();
    await relay(f, 0, 100);
    const endpoint = await relay(f, 30000, 100);
    await time.increaseTo(endpoint + 61n);
    f.latestRelay = await relay(f, 40000, 150);
    return f;
  }

  async function backupFixture() {
    const f = await deviatingFixture();
    await f.shepherd.connect(f.requester).requestChallenge();
    await time.increase(30);
    await f.shepherd.connect(f.executor).executeChallenge();
    return f;
  }

  it("returns a floored TWAP and its endpoint, refusing insufficient or immature history", async function () {
    const f = await loadFixture(fixture);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoTwapData");
    const first = await relay(f, 0, 100);
    await time.increaseTo(first + 61n);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoTwapData");
    await relay(f, 10001, 120);
    const end = await relay(f, 30003, 900);
    await time.increaseTo(end + 60n);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoTwapData");
    await time.increase(1);
    // floor((100*10001 + 120*20002)/30003) = 113; the endpoint price has zero weight.
    const pair = [113n, BigInt(f.start + 30003)];
    expect(await f.shepherd.getCurrentValue()).to.deep.equal(pair);
    await relay(f, 40000, 1000);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal(pair);
    expect(await f.shepherd.mode()).to.equal(0);
  });

  it("switches to spot without bypassing its read delay, then recovers to TWAP on agreement", async function () {
    const f = await loadFixture(backupFixture);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, BigInt(f.start + 30000)]);
    await time.increaseTo(f.latestRelay + 60n);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
    await time.increase(1);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([150n, BigInt(f.start + 40000)]);
    await expect(f.shepherd.requestRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
    const settled = await relay(f, 70000, 140);
    // Until this relay matures, the reference is still 100 and 140 remains out of band.
    await expect(f.shepherd.requestRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
    await time.increaseTo(settled + 61n);
    await f.shepherd.connect(f.requester).requestRecovery();
    await time.increase(90);
    await f.shepherd.connect(f.executor).executeRecovery();
    expect(await f.shepherd.mode()).to.equal(0);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([150n, BigInt(f.start + 70000)]);
  });

  it("isolates feed histories and mode transitions in a shared bank", async function () {
    const f = await loadFixture(deviatingFixture);
    const otherId = ethers.id("other-real-feed");
    const otherShepherd = await f.Shepherd.deploy(otherId, f.bank.target, f.admin.address,
      60, 120, 300, 30000, 2000, [30, 90]);
    const other = { ...f, queryId: otherId, shepherd: otherShepherd };
    await expect(otherShepherd.getCurrentValue()).to.be.revertedWithCustomError(otherShepherd, "NoTwapData");
    await relay(other, 0, 200);
    const end = await relay(other, 30000, 200);
    await time.increaseTo(end + 61n);
    await f.shepherd.requestChallenge();
    await time.increase(30);
    await f.shepherd.executeChallenge();
    expect(await f.shepherd.mode()).to.equal(1);
    expect(await otherShepherd.mode()).to.equal(0);
    expect((await otherShepherd.getCurrentValue())[0]).to.equal(200);
    await expect(otherShepherd.requestChallenge()).to.be.revertedWithCustomError(otherShepherd, "NotDeviating");
  });

  it("preserves pause through both switches while all clocks continue", async function () {
    const f = await loadFixture(deviatingFixture);
    await f.shepherd.pause();
    const pauseClock = await f.shepherd.pausedAt();
    await f.shepherd.requestChallenge();
    await time.increase(30);
    await f.shepherd.executeChallenge();
    expect(await f.shepherd.mode()).to.equal(1);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
    const settled = await relay(f, 70000, 140);
    await time.increaseTo(settled + 61n);
    await f.shepherd.requestRecovery();
    await time.increase(90);
    await f.shepherd.executeRecovery();
    expect(await f.shepherd.mode()).to.equal(0);
    expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
    await f.shepherd.unpause();
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(150);
  });

  for (const transition of ["Challenge", "Recovery"]) {
    it(`invalidates pending ${transition} only on successful bank migration`, async function () {
      const f = await loadFixture(transition === "Challenge" ? deviatingFixture : backupFixture);
      if (transition === "Recovery") {
        const settled = await relay(f, 70000, 140);
        await time.increaseTo(settled + 61n);
      }
      await f.shepherd[`request${transition}`]();
      const pending = `${transition.toLowerCase()}Pending`;
      const clock = `${transition.toLowerCase()}RequestedAt`;
      const original = await f.shepherd[clock]();
      const mode = await f.shepherd.mode();
      const replacement = await f.Bank.deploy(f.bridge.target);
      const next = { ...f, bank: replacement };
      await relay(next, 0, 200);
      await relay(next, 30000, 200);
      if (transition === "Challenge") await relay(next, 40000, 300);
      await f.shepherd.proposeDataBankChange(replacement.target);
      await f.shepherd.cancelDataBankChange();
      expect(await f.shepherd[clock]()).to.equal(original);
      await f.shepherd.proposeDataBankChange(replacement.target);
      await f.shepherd.pause();
      const pauseClock = await f.shepherd.pausedAt();
      await expect(f.shepherd.executeDataBankChange()).to.be.revertedWithCustomError(f.shepherd, "DataBankChangeDelayNotElapsed");
      await time.increase(300);
      const code = await ethers.provider.getCode(replacement.target);
      await setCode(replacement.target, "0x60006000fd");
      await expect(f.shepherd.executeDataBankChange()).to.be.reverted;
      expect(await f.shepherd[pending]()).to.equal(true);
      expect(await f.shepherd[clock]()).to.equal(original);
      await setCode(replacement.target, code);
      // Migration must not depend on the old bank remaining functional.
      await setCode(f.bank.target, "0x60006000fd");
      await expect(f.shepherd.executeDataBankChange()).to.emit(f.shepherd, `${transition}Invalidated`);
      expect(await f.shepherd.challengePending()).to.equal(false);
      expect(await f.shepherd.challengeRequestedAt()).to.equal(0);
      expect(await f.shepherd.recoveryPending()).to.equal(false);
      expect(await f.shepherd.recoveryRequestedAt()).to.equal(0);
      expect(await f.shepherd.mode()).to.equal(mode);
      expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
      await expect(f.shepherd[`execute${transition}`]()).to.be.revertedWithCustomError(f.shepherd, `NoPending${transition}`);
      await f.shepherd[`request${transition}`]();
      expect(await f.shepherd[clock]()).to.be.greaterThan(original);
      await expect(f.shepherd[`execute${transition}`]()).to.be.revertedWithCustomError(f.shepherd, `${transition}DelayNotElapsed`);
      await f.shepherd.unpause();
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(200);
    });
  }
});
