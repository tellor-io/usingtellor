const { loadFixture, setCode, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

async function fixture() {
  const [admin, pauser, nextAdmin, outsider] = await ethers.getSigners();
  const queryId = ethers.id("non-pausable-feed");
  const Source = await ethers.getContractFactory("PriceSourceMock");
  const primary = await Source.deploy(queryId, 8), backup = await Source.deploy(queryId, 8);
  const nextPrimary = await Source.deploy(queryId, 8), nextBackup = await Source.deploy(queryId, 8);
  const timestamp = BigInt(await time.latest() - 10) * 1000n + 17n;
  await primary.configureRead(100, timestamp, 0);
  await backup.configureRead(150, timestamp, 0);
  await nextPrimary.configureRead(200, timestamp + 1000n, 0);
  await nextBackup.configureRead(300, timestamp + 2000n, 0);
  const s = await (await ethers.getContractFactory("TellorShepherd")).deploy(
    queryId, 8, primary.target, backup.target, admin.address, 120, 20, 2000, [5, 7], 3600, false);
  await s.addPauser(pauser.address);
  return { admin, pauser, nextAdmin, outsider, queryId, primary, backup, nextPrimary, nextBackup, timestamp, s };
}

async function migrationState(s) {
  return Promise.all([s.primarySource(), s.backupSource(), s.pendingPrimarySource(), s.pendingBackupSource(),
    s.sourcesProposedAt(), s.mode(), s.paused(), s.pausedAt(), s.challengePending(), s.challengeRequestedAt(),
    s.recoveryPending(), s.recoveryRequestedAt()]);
}

async function expectLive(s, value, timestamp) {
  expect(await s.isPausable()).to.equal(false);
  expect(await s.paused()).to.equal(false);
  expect(await s.pausedAt()).to.equal(0);
  expect(await s.getCurrentValue()).to.deep.equal([value, timestamp]);
  expect(await s.latestRoundData()).to.deep.equal([0n, value, 0n, timestamp / 1000n, 0n]);
}

describe("TellorShepherd - Immutable pausability", function () {
  it("refuses admin and registered-pauser pauses without changing reads or state", async function () {
    const f = await loadFixture(fixture), s = f.s;
    await s.requestChallenge();
    const before = await migrationState(s);
    for (const caller of [f.admin, f.pauser]) {
      await expect(s.connect(caller).pause()).to.be.revertedWithCustomError(s, "NotPausable");
      expect(await migrationState(s)).to.deep.equal(before);
    }
    await expect(s.connect(f.outsider).pause()).to.be.revertedWithCustomError(s, "NotAuthorizedToPause");
    await expect(s.unpause()).to.be.revertedWithCustomError(s, "NotPaused");
    await expectLive(s, 100n, f.timestamp);
  });

  it("keeps membership and duration management usable but inert, including after admin transfer", async function () {
    const f = await loadFixture(fixture), s = f.s;
    expect(await s.minPauseDuration()).to.equal(120);
    await s.removePauser(f.pauser.address);
    expect(await s.isPauser(f.pauser.address)).to.equal(false);
    await s.addPauser(f.pauser.address);
    await s.proposeMinPauseDurationChange(0);
    await s.cancelMinPauseDurationChange();
    expect(await s.minPauseDuration()).to.equal(120);
    for (const duration of [0n, ethers.MaxUint256]) {
      await s.proposeMinPauseDurationChange(duration);
      await time.setNextBlockTimestamp(await s.minPauseDurationProposedAt() + 20n);
      await s.executeMinPauseDurationChange();
      expect(await s.minPauseDuration()).to.equal(duration);
      await expect(s.pause()).to.be.revertedWithCustomError(s, "NotPausable");
    }
    await s.proposeAdminChange(f.nextAdmin.address);
    await time.setNextBlockTimestamp(await s.adminProposedAt() + 20n);
    await s.executeAdminChange();
    expect(await s.admin()).to.equal(f.nextAdmin.address);
    expect(await s.isPauser(f.pauser.address)).to.equal(true);
    for (const caller of [f.nextAdmin, f.pauser]) {
      await expect(s.connect(caller).pause()).to.be.revertedWithCustomError(s, "NotPausable");
    }
    await expect(s.pause()).to.be.revertedWithCustomError(s, "NotAuthorizedToPause");
    await expectLive(s, 100n, f.timestamp);
  });

  it("retains admin-only migration and cancellation with a fresh notice after reproposal", async function () {
    const f = await loadFixture(fixture), s = f.s;
    await expect(s.executeSourcesChange()).to.be.revertedWithCustomError(s, "NoPendingSourcesChange");
    for (const caller of [f.pauser, f.outsider]) {
      await expect(s.connect(caller).proposeSourcesChange(f.nextPrimary.target, f.nextBackup.target))
        .to.be.revertedWithCustomError(s, "NotAdmin");
    }
    await s.proposeSourcesChange(f.nextPrimary.target, f.nextBackup.target);
    const firstNotice = await s.sourcesProposedAt();
    await time.increase(20);
    const before = await migrationState(s);
    for (const caller of [f.pauser, f.outsider]) {
      for (const action of ["executeSourcesChange", "cancelSourcesChange"]) {
        await expect(s.connect(caller)[action]()).to.be.revertedWithCustomError(s, "NotAdmin");
        expect(await migrationState(s)).to.deep.equal(before);
      }
    }
    await s.cancelSourcesChange();
    await s.proposeSourcesChange(f.nextPrimary.target, f.nextBackup.target);
    expect(await s.sourcesProposedAt()).to.be.greaterThan(firstNotice);
    await expect(s.executeSourcesChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
    await expectLive(s, 100n, f.timestamp);
  });

  for (const mode of [0, 1]) {
    it(`migrates live at notice equality in mode ${mode}, preserves selection and requires fresh transition waits`, async function () {
      const f = await loadFixture(fixture), s = f.s;
      if (mode) {
        await s.requestChallenge();
        await time.increase(5);
        await s.executeChallenge();
        await f.backup.configureRead(100, f.timestamp, 0);
        await f.nextBackup.configureRead(200, f.timestamp + 2000n, 0);
      }
      const kind = mode ? "Recovery" : "Challenge";
      const delay = mode ? 7n : 5n;
      const clock = mode ? "recoveryRequestedAt" : "challengeRequestedAt";
      await s[`request${kind}`]();
      await s.proposeSourcesChange(f.nextPrimary.target, f.nextBackup.target);
      const notice = await s.sourcesProposedAt();
      const before = await migrationState(s);
      await time.setNextBlockTimestamp(notice + 19n);
      await expect(s.executeSourcesChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
      expect(await migrationState(s)).to.deep.equal(before);
      await expectLive(s, 100n, f.timestamp);
      await time.setNextBlockTimestamp(notice + 20n);
      await expect(s.executeSourcesChange())
        .to.emit(s, "SourcesChanged").withArgs(f.primary.target, f.backup.target, f.nextPrimary.target, f.nextBackup.target)
        .and.to.emit(s, `${kind}Invalidated`);
      expect(await s.primarySource()).to.equal(f.nextPrimary.target);
      expect(await s.backupSource()).to.equal(f.nextBackup.target);
      expect(await s.mode()).to.equal(mode);
      expect(await s.challengePending()).to.equal(false);
      expect(await s.recoveryPending()).to.equal(false);
      expect(await s.challengeRequestedAt()).to.equal(0);
      expect(await s.recoveryRequestedAt()).to.equal(0);
      expect(await s.pendingPrimarySource()).to.equal(ethers.ZeroAddress);
      expect(await s.pendingBackupSource()).to.equal(ethers.ZeroAddress);
      expect(await s.sourcesProposedAt()).to.equal(0);
      await expectLive(s, 200n, f.timestamp + (mode ? 2000n : 1000n));
      await expect(s[`execute${kind}`]()).to.be.revertedWithCustomError(s, `NoPending${kind}`);
      await s[`request${kind}`]();
      await expect(s[`execute${kind}`]()).to.be.revertedWithCustomError(s, `${kind}DelayNotElapsed`);
      await time.setNextBlockTimestamp(await s[clock]() + delay);
      await s[`execute${kind}`]();
      expect(await s.mode()).to.equal(1 - mode);
      expect(await s.isPausable()).to.equal(false);
    });
  }

  for (const side of ["nextPrimary", "nextBackup"]) {
    for (const fault of ["query", "decimals", "code"]) {
      it(`rechecks ${side} ${fault} and preserves the live pair, proposal and timers on failure`, async function () {
        const f = await loadFixture(fixture), s = f.s;
        await s.requestChallenge();
        await s.proposeSourcesChange(f.nextPrimary.target, f.nextBackup.target);
        const before = await migrationState(s);
        let error;
        if (fault === "query") {
          await f[side].configureMetadata(ethers.id("wrong-feed"), 8);
          error = "SourceQueryIdMismatch";
        } else if (fault === "decimals") {
          await f[side].configureMetadata(f.queryId, 18);
          error = "SourceDecimalsMismatch";
        } else {
          await setCode(f[side].target, "0x");
          error = "SourceHasNoCode";
        }
        await time.increase(20);
        await expect(s.executeSourcesChange()).to.be.revertedWithCustomError(s, error);
        expect(await migrationState(s)).to.deep.equal(before);
        await expectLive(s, 100n, f.timestamp);
        await s.cancelSourcesChange();
        expect(await s.pendingPrimarySource()).to.equal(ethers.ZeroAddress);
        expect(await s.challengePending()).to.equal(true);
      });
    }
  }

  it("can replace broken old sources with empty sources, without promising continuous price availability", async function () {
    const f = await loadFixture(fixture), s = f.s;
    await f.primary.configureRead(0, 0, 1);
    await f.backup.configureRead(0, 0, 1);
    await f.nextPrimary.configureRead(0, 0, 1);
    await s.proposeSourcesChange(f.nextPrimary.target, f.nextBackup.target);
    await time.increase(20);
    await s.executeSourcesChange();
    expect(await s.primarySource()).to.equal(f.nextPrimary.target);
    expect(await s.backupSource()).to.equal(f.nextBackup.target);
    expect(await s.isPausable()).to.equal(false);
    expect(await s.paused()).to.equal(false);
    for (const method of ["getCurrentValue", "latestRoundData"]) {
      await expect(s[method]()).to.be.revertedWithCustomError(f.nextPrimary, "ReadUnavailable");
    }
  });
});
