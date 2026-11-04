const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

async function fixture() {
  const [deployer, admin, next, pauser] = await ethers.getSigners();
  const queryId = ethers.id("mutable-challenge-threshold");
  const Source = await ethers.getContractFactory("PriceSourceMock");
  const primary = await Source.deploy(queryId, 8), backup = await Source.deploy(queryId, 8);
  const timestamp = BigInt(await time.latest() - 10) * 1000n + 17n;
  await primary.configureRead(10000, timestamp, 0); await backup.configureRead(15000, timestamp, 0);
  const Shepherd = await ethers.getContractFactory("TellorShepherd");
  const args = [queryId, 8, primary.target, backup.target, admin.address, 0, 100, 2000, [5, 7], 3600];
  const s = (await Shepherd.deploy(...args)).connect(admin);
  await s.addPauser(pauser.address);
  return { deployer, admin, next, pauser, queryId, Source, primary, backup, timestamp, Shepherd, args, s };
}
const thresholdState = s => Promise.all([s.challengeThresholdBps(), s.pendingChallengeThresholdBps(), s.challengeThresholdProposedAt()]);
const transitions = s => Promise.all([s.challengePending(), s.challengeRequestedAt(), s.recoveryPending(), s.recoveryRequestedAt()]);
async function otherState(f) {
  return Promise.all([...["mode", "paused", "pausedAt", "primarySource", "backupSource", "queryId", "decimals",
    "admin", "pendingAdmin", "adminProposedAt", "pendingPrimarySource", "pendingBackupSource", "sourcesProposedAt",
    "minPauseDuration", "pendingMinPauseDuration", "minPauseDurationProposedAt", "minPauseDurationChangePending",
    "CHALLENGE_DELAY_SECONDS", "RECOVERY_DELAY_SECONDS", "CONFIG_CHANGE_DELAY", "MAX_DATA_AGE"].map(n => f.s[n]()),
    f.s.isPauser(f.admin.address), f.s.isPauser(f.next.address), f.s.isPauser(f.pauser.address),
    f.primary.value(), f.primary.timestampMs(), f.backup.value(), f.backup.timestampMs()]);
}
async function enterMode(f, mode) {
  if (mode) {
    await f.s.requestChallenge(); await time.increase(5); await f.s.executeChallenge();
    await f.backup.configureRead(10000, f.timestamp, 0);
  }
}
async function executeUpdate(s, value) {
  await s.proposeChallengeThresholdChange(value);
  await time.setNextBlockTimestamp(await s.challengeThresholdProposedAt() + 100n);
  await s.executeChallengeThresholdChange();
}

describe("TellorShepherd - Mutable deviation threshold", function () {
  for (const value of [1, 9999]) {
    it(`accepts deployment/update endpoint ${value}, retaining the getter and zero absence sentinel`, async function () {
      const f = await loadFixture(fixture), args = [...f.args]; args[7] = value;
      const deployed = await f.Shepherd.deploy(...args);
      expect(await thresholdState(deployed)).to.deep.equal([BigInt(value), 0n, 0n]);
      await executeUpdate(f.s, value);
      expect(await thresholdState(f.s)).to.deep.equal([BigInt(value), 0n, 0n]);
      await expect(f.s.proposeChallengeThresholdChange(value)).to.be.revertedWithCustomError(f.s, "ChallengeThresholdUnchanged");
    });
  }
  for (const paused of [false, true]) {
    it(`rejects invalid/no-op/no-pending/overwrite; cancel/reproposal resets only notice; paused=${paused}`, async function () {
      const f = await loadFixture(fixture), s = f.s;
      if (paused) await s.pause();
      await s.requestChallenge();
      const before = await otherState(f), pending = await transitions(s);
      for (const value of [0, 10000, ethers.MaxUint256]) {
        await expect(s.proposeChallengeThresholdChange(value)).to.be.revertedWithCustomError(s, "InvalidChallengeThreshold");
        expect(await thresholdState(s)).to.deep.equal([2000n, 0n, 0n]);
      }
      await expect(s.proposeChallengeThresholdChange(2000)).to.be.revertedWithCustomError(s, "ChallengeThresholdUnchanged");
      for (const action of ["cancel", "execute"]) await expect(s[`${action}ChallengeThresholdChange`]())
        .to.be.revertedWithCustomError(s, "NoPendingChallengeThresholdChange");
      const at = BigInt(await time.latest() + 1);
      await expect(s.proposeChallengeThresholdChange(3000)).to.emit(s, "ChallengeThresholdChangeProposed").withArgs(3000, at);
      await time.increase(100);
      for (const value of [3000, 4000]) await expect(s.proposeChallengeThresholdChange(value))
        .to.be.revertedWithCustomError(s, "ChallengeThresholdChangePending");
      expect(await thresholdState(s)).to.deep.equal([2000n, 3000n, at]);
      await expect(s.cancelChallengeThresholdChange()).to.emit(s, "ChallengeThresholdChangeCancelled").withArgs(3000);
      expect(await thresholdState(s)).to.deep.equal([2000n, 0n, 0n]);
      await s.proposeChallengeThresholdChange(3000);
      expect(await s.challengeThresholdProposedAt()).to.be.greaterThan(at);
      const reproposed = await thresholdState(s);
      await expect(s.executeChallengeThresholdChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
      expect(await thresholdState(s)).to.deep.equal(reproposed);
      expect(await otherState(f)).to.deep.equal(before); expect(await transitions(s)).to.deep.equal(pending);
    });
    it(`only current admin acts, before/after notice; failed calls preserve all state; paused=${paused}`, async function () {
      const f = await loadFixture(fixture), s = f.s;
      if (paused) await s.pause();
      await s.requestChallenge(); await s.proposeChallengeThresholdChange(3000);
      const before = await otherState(f), pending = await transitions(s), threshold = await thresholdState(s);
      for (const elapsed of [0, 100]) {
        if (elapsed) await time.increase(elapsed);
        for (const caller of [f.deployer, f.next, f.pauser]) {
          await expect(s.connect(caller).proposeChallengeThresholdChange(4000)).to.be.revertedWithCustomError(s, "NotAdmin");
          for (const action of ["cancel", "execute"]) await expect(s.connect(caller)[`${action}ChallengeThresholdChange`]())
            .to.be.revertedWithCustomError(s, "NotAdmin");
        }
        expect(await otherState(f)).to.deep.equal(before); expect(await transitions(s)).to.deep.equal(pending);
        expect(await thresholdState(s)).to.deep.equal(threshold);
      }
    });
    for (const mode of [0, 1]) {
      it(`execution invalidates qualifying requests at exact notice, preserves unrelated state; paused=${paused}, mode=${mode}`, async function () {
        const f = await loadFixture(fixture), s = f.s, kind = mode ? "Recovery" : "Challenge", delay = mode ? 7n : 5n;
        await enterMode(f, mode); await s[`request${kind}`]();
        const pending = await transitions(s), native = await s.getCurrentValue(), round = await s.latestRoundData();
        const replacement = await f.Source.deploy(f.queryId, 8);
        await s.proposeSourcesChange(replacement.target, f.backup.target);
        await s.proposeAdminChange(f.next.address); await s.proposeMinPauseDurationChange(50);
        if (paused) await s.pause();
        const before = await otherState(f);
        await s.proposeChallengeThresholdChange(3000);
        expect(await transitions(s)).to.deep.equal(pending);
        await s.cancelChallengeThresholdChange(); expect(await transitions(s)).to.deep.equal(pending);
        await s.proposeChallengeThresholdChange(3000); const at = await s.challengeThresholdProposedAt();
        await time.setNextBlockTimestamp(at + 99n);
        await expect(s.executeChallengeThresholdChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
        expect(await thresholdState(s)).to.deep.equal([2000n, 3000n, at]);
        expect(await transitions(s)).to.deep.equal(pending); expect(await otherState(f)).to.deep.equal(before);
        await time.setNextBlockTimestamp(at + 100n);
        await expect(s.executeChallengeThresholdChange()).to.emit(s, "ChallengeThresholdChanged").withArgs(2000, 3000)
          .and.to.emit(s, `${kind}Invalidated`).and.not.to.emit(s, mode ? "ChallengeInvalidated" : "RecoveryInvalidated");
        expect(await thresholdState(s)).to.deep.equal([3000n, 0n, 0n]);
        expect(await transitions(s)).to.deep.equal([false, 0n, false, 0n]);
        expect(await otherState(f)).to.deep.equal(before);
        if (paused) {
          await expect(s.getCurrentValue()).to.be.revertedWithCustomError(s, "ShepherdPaused");
          await expect(s.latestRoundData()).to.be.revertedWithCustomError(s, "ShepherdPaused");
          await expect(s.unpause()).to.be.revertedWithCustomError(s, "SourcesChangePending");
        } else {
          expect(await s.getCurrentValue()).to.deep.equal(native); expect(await s.latestRoundData()).to.deep.equal(round);
        }
        await expect(s[`execute${kind}`]()).to.be.revertedWithCustomError(s, `NoPending${kind}`);
        // Identical observations still qualify, but they must start a fresh full transition wait.
        await s.connect(f.deployer)[`request${kind}`](); const start = await s[`${kind.toLowerCase()}RequestedAt`]();
        await time.setNextBlockTimestamp(start + delay - 1n);
        await expect(s[`execute${kind}`]()).to.be.revertedWithCustomError(s, `${kind}DelayNotElapsed`);
        await time.setNextBlockTimestamp(start + delay);
        await s.connect(f.pauser)[`execute${kind}`](); expect(await s.mode()).to.equal(1 - mode);
        expect(await s.paused()).to.equal(paused);
      });
    }
    it(`configuration operations need no usable sources and never unpause; paused=${paused}`, async function () {
      const f = await loadFixture(fixture), s = f.s;
      await s.requestChallenge(); if (paused) await s.pause();
      await f.primary.configureRead(0, 0, 1); await f.backup.configureRead(0, 0, 2);
      const before = await otherState(f);
      await s.proposeChallengeThresholdChange(3000); await s.cancelChallengeThresholdChange();
      await executeUpdate(s, 9999);
      expect(await otherState(f)).to.deep.equal(before); expect(await transitions(s)).to.deep.equal([false, 0n, false, 0n]);
      if (paused) await s.unpause();
      await expect(s.getCurrentValue()).to.be.revertedWithCustomError(f.primary, "ReadUnavailable");
      await expect(s.requestChallenge()).to.be.revertedWithCustomError(f.primary, "ReadUnavailable");
    });
  }

  for (const mode of [0, 1]) {
    it(`pending threshold leaves permissionless request/cancel/execute under active policy; mode=${mode}`, async function () {
      const f = await loadFixture(fixture), s = f.s, kind = mode ? "Recovery" : "Challenge";
      await enterMode(f, mode);
      // Request observations qualify under active 20%, but not under the proposed policy.
      await s.proposeChallengeThresholdChange(mode ? 1000 : 4000);
      const threshold = await thresholdState(s);
      await f.backup.configureRead(mode ? 11500 : 13000, f.timestamp, 0);
      await s.connect(f.deployer)[`request${kind}`]();
      // Move to the cancellation side of the active threshold, not the pending threshold.
      await f.backup.configureRead(mode ? 13000 : 11500, f.timestamp, 0);
      await s.connect(f.pauser)[`cancel${kind}`]();
      await f.backup.configureRead(mode ? 11500 : 13000, f.timestamp, 0);
      await s.connect(f.deployer)[`request${kind}`](); await time.increase(mode ? 7 : 5);
      await s.connect(f.pauser)[`execute${kind}`]();
      expect(await s.mode()).to.equal(1 - mode); expect(await thresholdState(s)).to.deep.equal(threshold);
    });
  }
  for (const threshold of [1n, 3000n, 9999n]) {
    it(`updated ${threshold} bps keeps strict primary-relative equality and just-over behavior in both directions`, async function () {
      const f = await loadFixture(fixture), s = f.s;
      await executeUpdate(s, threshold);
      for (const sign of [-1n, 1n]) {
        await f.backup.configureRead(10000n + sign * threshold, f.timestamp, 0);
        await expect(s.requestChallenge()).to.be.revertedWithCustomError(s, "NotDeviating");
        const beyond = 10000n + sign * (threshold + 1n);
        if (beyond === 0n) continue; // Zero-price refusal is tested by the existing source-validation suite.
        await f.backup.configureRead(beyond, f.timestamp, 0); await s.requestChallenge();
        const start = await s.challengeRequestedAt();
        await f.backup.configureRead(10000n + sign * threshold, f.timestamp, 0); await time.increase(5);
        await expect(s.executeChallenge()).to.be.revertedWithCustomError(s, "NotDeviating");
        expect(await s.challengeRequestedAt()).to.equal(start);
        await s.cancelChallenge();
      }
    });
  }
  for (const adminFirst of [false, true]) for (const action of ["execute", "cancel"]) {
    it(`handover preserves threshold notice and transfers sole authority; adminFirst=${adminFirst}, ${action}`, async function () {
      const f = await loadFixture(fixture), s = f.s;
      if (adminFirst) await s.proposeAdminChange(f.next.address); else await s.proposeChallengeThresholdChange(3000);
      await time.increase(20);
      if (adminFirst) await s.proposeChallengeThresholdChange(3000); else await s.proposeAdminChange(f.next.address);
      const at = await s.challengeThresholdProposedAt(), adminAt = await s.adminProposedAt();
      await time.setNextBlockTimestamp(adminAt + 100n); await s.executeAdminChange();
      expect(await thresholdState(s)).to.deep.equal([2000n, 3000n, at]);
      await expect(s.proposeChallengeThresholdChange(4000)).to.be.revertedWithCustomError(s, "NotAdmin");
      for (const method of ["cancel", "execute"]) await expect(s[`${method}ChallengeThresholdChange`]()).to.be.revertedWithCustomError(s, "NotAdmin");
      if (action === "execute" && adminFirst) {
        await time.setNextBlockTimestamp(at + 99n);
        await expect(s.connect(f.next).executeChallengeThresholdChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
        expect(await thresholdState(s)).to.deep.equal([2000n, 3000n, at]);
        await time.setNextBlockTimestamp(at + 100n);
      }
      await s.connect(f.next)[`${action}ChallengeThresholdChange`]();
      expect(await thresholdState(s)).to.deep.equal([action === "execute" ? 3000n : 2000n, 0n, 0n]);
      await s.connect(f.next).proposeChallengeThresholdChange(4000);
    });
  }
  it("all four proposal notices remain independent through cancel/reproposal, duration execution and source migration", async function () {
    const f = await loadFixture(fixture), s = f.s, replacement = await f.Source.deploy(f.queryId, 8);
    await s.requestChallenge(); await s.proposeChallengeThresholdChange(3000);
    const threshold = await thresholdState(s);
    await s.proposeSourcesChange(replacement.target, f.backup.target);
    await s.proposeAdminChange(f.next.address); await s.proposeMinPauseDurationChange(50);
    for (const [kind, args, getter] of [["Sources", [replacement.target, f.backup.target], "sourcesProposedAt"],
      ["Admin", [f.next.address], "adminProposedAt"], ["MinPauseDuration", [50], "minPauseDurationProposedAt"]]) {
      const others = ["sourcesProposedAt", "adminProposedAt", "minPauseDurationProposedAt"].filter(n => n !== getter);
      const before = await Promise.all(others.map(n => s[n]())), at = await s[getter]();
      await s[`cancel${kind}Change`](); await s[`propose${kind}Change`](...args);
      expect(await s[getter]()).to.be.greaterThan(at);
      expect(await Promise.all(others.map(n => s[n]()))).to.deep.equal(before);
      expect(await thresholdState(s)).to.deep.equal(threshold);
    }
    const other = await otherState(f);
    await s.cancelChallengeThresholdChange(); await s.proposeChallengeThresholdChange(4000);
    expect(await otherState(f)).to.deep.equal(other);
    const newThreshold = await thresholdState(s), adminAt = await s.adminProposedAt();
    await s.pause(); await time.increase(100);
    await s.executeMinPauseDurationChange(); expect(await thresholdState(s)).to.deep.equal(newThreshold);
    expect(await s.challengePending()).to.equal(true);
    await expect(s.executeSourcesChange()).to.emit(s, "ChallengeInvalidated");
    expect(await thresholdState(s)).to.deep.equal(newThreshold); expect(await s.adminProposedAt()).to.equal(adminAt);
    expect(await transitions(s)).to.deep.equal([false, 0n, false, 0n]);
    await s.executeChallengeThresholdChange(); expect(await s.primarySource()).to.equal(replacement.target);
  });
  it("pending admin/duration/threshold proposals do not block zero-duration unpause; source proposals still do", async function () {
    const f = await loadFixture(fixture), s = f.s;
    await s.proposeAdminChange(f.next.address); await s.proposeMinPauseDurationChange(500);
    await s.proposeChallengeThresholdChange(3000);
    const threshold = await thresholdState(s);
    await s.pause(); await s.unpause(); expect(await thresholdState(s)).to.deep.equal(threshold);
    const replacement = await f.Source.deploy(f.queryId, 8);
    await s.proposeSourcesChange(replacement.target, f.backup.target); await s.pause();
    await expect(s.unpause()).to.be.revertedWithCustomError(s, "SourcesChangePending");
    await s.cancelSourcesChange(); await s.unpause();
    expect(await s.minPauseDuration()).to.equal(0); expect(await thresholdState(s)).to.deep.equal(threshold);
  });
});
