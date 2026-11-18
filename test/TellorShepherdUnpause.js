const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { unpauseSelection } = require("./helpers/unpauseSelection");

async function fixture() {
  const [admin, outsider] = await ethers.getSigners();
  const Source = await ethers.getContractFactory("PriceSourceMock");
  const primary = await Source.deploy(ethers.id("primary"), 8);
  const backup = await Source.deploy(ethers.id("backup"), 8);
  const timestamp = BigInt(await time.latest() - 10) * 1000n;
  await primary.configureRead(100, timestamp, 0);
  await backup.configureRead(150, timestamp, 0);
  const s = await (await ethers.getContractFactory("TellorShepherd")).deploy(
    "ETH/USD", 8, primary.target, backup.target, admin.address, 120, 300, 2000, [30, 90], 3600, true
  );
  return { s, primary, backup, timestamp, admin, outsider };
}

async function state(s) {
  return Promise.all([s.paused(), s.pausedAt(), s.mode(), s.primarySource(), s.backupSource(),
    s.challengePending(), s.challengeRequestedAt(), s.recoveryPending(), s.recoveryRequestedAt()]);
}

async function refusesWithoutChanges(s, selection) {
  const before = await state(s);
  await expect(s.unpause(...selection)).to.be.revertedWithCustomError(s, "UnexpectedState");
  expect(await state(s)).to.deep.equal(before);
}

describe("TellorShepherd - Expected unpause selection", function () {
  for (const field of [0, 1, 2]) {
    it(`rejects an isolated mismatch in selection field ${field}`, async function () {
      const { s, outsider } = await loadFixture(fixture);
      await s.pause(); await time.increase(120);
      const selection = await unpauseSelection(s);
      selection[field] = field === 0 ? 1 : outsider.address;
      await refusesWithoutChanges(s, selection);
    });
  }

  for (const recovery of [false, true]) {
    it(`rejects a reviewed mode after permissionless ${recovery ? "recovery" : "challenge"}, then accepts the new selection`, async function () {
      const { s, backup, timestamp, outsider, admin } = await loadFixture(fixture);
      if (recovery) {
        await s.requestChallenge(); await time.increase(30); await s.executeChallenge();
        await backup.configureRead(100, timestamp, 0);
      }
      await s.pause();
      const selection = await unpauseSelection(s);
      await s.connect(outsider)[recovery ? "requestRecovery" : "requestChallenge"]();
      await time.increase(120);
      await s.connect(outsider)[recovery ? "executeRecovery" : "executeChallenge"]();
      await refusesWithoutChanges(s, selection);
      const current = await unpauseSelection(s);
      await expect(s.unpause(...current)).to.emit(s, "Unpaused").withArgs(admin.address);
      expect(await s.paused()).to.equal(false);
      expect(await s.pausedAt()).to.equal(0);
      expect(await unpauseSelection(s)).to.deep.equal(current);
      expect(await s.getCurrentValue()).to.deep.equal([recovery ? 100n : 150n, timestamp]);
    });
  }

  for (const primaryChanged of [false, true]) {
    it(`rejects a reviewed pair after replacing only the ${primaryChanged ? "primary" : "backup"}`, async function () {
      const { s, primary, backup, timestamp } = await loadFixture(fixture);
      await s.pause();
      const selection = await unpauseSelection(s);
      const replacement = await (await ethers.getContractFactory("PriceSourceMock")).deploy(ethers.id("new"), 8);
      await replacement.configureRead(100, timestamp, 0);
      await s.proposeSourcesChange(primaryChanged ? replacement.target : primary.target,
        primaryChanged ? backup.target : replacement.target);
      await time.increase(300); await s.executeSourcesChange();
      await refusesWithoutChanges(s, selection);
      await s.unpause(...await unpauseSelection(s));
      expect(await s.paused()).to.equal(false);
    });
  }

  it("preserves pending timers and permits later transitions when the reviewed selection still matches", async function () {
    const { s, outsider } = await loadFixture(fixture);
    await s.pause();
    const selection = await unpauseSelection(s);
    await s.connect(outsider).requestChallenge();
    const requestedAt = await s.challengeRequestedAt();
    await time.increase(120);
    await s.unpause(...selection);
    expect(await s.challengePending()).to.equal(true);
    expect(await s.challengeRequestedAt()).to.equal(requestedAt);
    await s.connect(outsider).executeChallenge();
    expect(await s.mode()).to.equal(1);
  });

  it("does not bind prices or add a source-readiness requirement", async function () {
    const { s, primary } = await loadFixture(fixture);
    await s.pause();
    const selection = await unpauseSelection(s);
    await primary.configureRead(0, 0, 1);
    await time.increase(120);
    await s.unpause(...selection);
    await expect(s.getCurrentValue()).to.be.revertedWithCustomError(primary, "ReadUnavailable");
  });

  it("has no argument-free unpause bypass", async function () {
    const { s, admin } = await loadFixture(fixture);
    await s.pause(); await time.increase(120);
    expect(s.interface.hasFunction("unpause()")).to.equal(false);
    const before = await state(s);
    await expect(admin.sendTransaction({ to: s.target, data: ethers.id("unpause()").slice(0, 10) })).to.be.reverted;
    expect(await state(s)).to.deep.equal(before);
  });
});
