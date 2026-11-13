const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

async function fixture() {
  const [deployer, admin, next, pauser] = await ethers.getSigners();
  const queryId = ethers.id("mutable-pause-duration");
  const Source = await ethers.getContractFactory("PriceSourceMock");
  const primary = await Source.deploy(queryId, 8), backup = await Source.deploy(queryId, 8);
  const timestamp = BigInt(await time.latest() - 10) * 1000n + 17n;
  await primary.configureRead(100, timestamp, 0); await backup.configureRead(150, timestamp, 0);
  const Shepherd = await ethers.getContractFactory("TellorShepherd");
  const args = [queryId, 8, primary.target, backup.target, admin.address, 200, 100, 2000, [5, 7], 3600, true];
  const s = (await Shepherd.deploy(...args)).connect(admin);
  await s.addPauser(pauser.address);
  return { deployer, admin, next, pauser, queryId, Source, primary, backup, timestamp, Shepherd, args, s };
}
async function durationState(s) {
  return Promise.all([s.minPauseDuration(), s.minPauseDurationChangePending(),
    s.pendingMinPauseDuration(), s.minPauseDurationProposedAt()]);
}
async function otherState(f) {
  return Promise.all([...["mode", "paused", "pausedAt", "primarySource", "backupSource", "queryId", "decimals",
    "admin", "pendingAdmin", "adminProposedAt", "pendingPrimarySource", "pendingBackupSource", "sourcesProposedAt",
    "challengePending", "challengeRequestedAt", "recoveryPending", "recoveryRequestedAt", "challengeThresholdBps",
    "CHALLENGE_DELAY_SECONDS", "RECOVERY_DELAY_SECONDS", "CONFIG_CHANGE_DELAY", "MAX_DATA_AGE"].map(n => f.s[n]()),
    f.s.isPauser(f.admin.address), f.s.isPauser(f.next.address), f.s.isPauser(f.pauser.address),
    f.primary.value(), f.primary.timestampMs(), f.backup.value(), f.backup.timestampMs()]);
}

describe("TellorShepherd - Mutable minimum pause duration", function () {
  for (const duration of [0n, 1n, ethers.MaxUint256]) {
    it(`accepts deployment duration ${duration} without deadline-addition overflow`, async function () {
      const f = await loadFixture(fixture), args = [...f.args]; args[5] = duration;
      const s = (await f.Shepherd.deploy(...args)).connect(f.admin);
      expect(await s.minPauseDuration()).to.equal(duration);
      expect(await s.minPauseDurationChangePending()).to.equal(false);
      await s.pause();
      if (duration === ethers.MaxUint256) await expect(s.unpause()).to.be.revertedWithCustomError(s, "PauseDurationNotElapsed");
      else await s.unpause();
    });
  }

  it("zero permits actual pause/unpause transactions in the same block and timestamp", async function () {
    const f = await loadFixture(fixture), args = [...f.args]; args[5] = 0;
    const s = (await f.Shepherd.deploy(...args)).connect(f.admin);
    await expect(s.unpause()).to.be.revertedWithCustomError(s, "NotPaused");
    const nonce = await f.admin.getNonce();
    await network.provider.send("evm_setAutomine", [false]);
    try {
      const pause = await s.pause({ nonce, gasLimit: 500000 });
      const unpause = await s.unpause({ nonce: nonce + 1, gasLimit: 500000 });
      await network.provider.send("evm_mine");
      const [a, b] = await Promise.all([pause.wait(), unpause.wait()]);
      expect(a.blockNumber).to.equal(b.blockNumber);
      expect(a.status).to.equal(1); expect(b.status).to.equal(1);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    expect(await s.paused()).to.equal(false); expect(await s.pausedAt()).to.equal(0);
  });

  for (const paused of [false, true]) {
    it(`zero is a real pending value; no-op/no-pending/overwrite/cancel/reproposal; paused=${paused}`, async function () {
      const f = await loadFixture(fixture), s = f.s;
      if (paused) await s.pause();
      for (const method of ["cancelMinPauseDurationChange", "executeMinPauseDurationChange"]) {
        await expect(s[method]()).to.be.revertedWithCustomError(s, "NoPendingMinPauseDurationChange");
      }
      await expect(s.proposeMinPauseDurationChange(200)).to.be.revertedWithCustomError(s, "MinPauseDurationUnchanged");
      const before = await otherState(f), at = BigInt(await time.latest() + 1);
      await expect(s.proposeMinPauseDurationChange(0)).to.emit(s, "MinPauseDurationChangeProposed").withArgs(0, at);
      expect(await durationState(s)).to.deep.equal([200n, true, 0n, at]);
      await time.increase(100);
      for (const value of [0, 300]) await expect(s.proposeMinPauseDurationChange(value))
        .to.be.revertedWithCustomError(s, "MinPauseDurationChangePending");
      expect(await durationState(s)).to.deep.equal([200n, true, 0n, at]);
      await expect(s.cancelMinPauseDurationChange()).to.emit(s, "MinPauseDurationChangeCancelled").withArgs(0);
      expect(await durationState(s)).to.deep.equal([200n, false, 0n, 0n]);
      expect(await otherState(f)).to.deep.equal(before);
      await expect(s.executeMinPauseDurationChange()).to.be.revertedWithCustomError(s, "NoPendingMinPauseDurationChange");
      await s.proposeMinPauseDurationChange(0);
      expect(await s.minPauseDurationProposedAt()).to.be.greaterThan(at);
      await expect(s.executeMinPauseDurationChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
    });
    it(`only current admin can propose/cancel/execute, before and after notice; paused=${paused}`, async function () {
      const f = await loadFixture(fixture), s = f.s;
      if (paused) await s.pause();
      await s.proposeMinPauseDurationChange(0);
      for (const elapsed of [0, 100]) {
        if (elapsed) await time.increase(elapsed);
        const pending = await durationState(s), before = await otherState(f);
        for (const caller of [f.deployer, f.next, f.pauser]) {
          await expect(s.connect(caller).proposeMinPauseDurationChange(300)).to.be.revertedWithCustomError(s, "NotAdmin");
          for (const method of ["cancelMinPauseDurationChange", "executeMinPauseDurationChange"]) {
            await expect(s.connect(caller)[method]()).to.be.revertedWithCustomError(s, "NotAdmin");
          }
        }
        expect(await durationState(s)).to.deep.equal(pending); expect(await otherState(f)).to.deep.equal(before);
      }
    });
    for (const mode of [0, 1]) {
      it(`exact config-delay boundary preserves other state and pending transitions; paused=${paused}, mode=${mode}`, async function () {
        const f = await loadFixture(fixture), s = f.s;
        if (mode) {
          await s.requestChallenge(); await time.increase(5); await s.executeChallenge();
          await f.backup.configureRead(100, f.timestamp, 0); await s.requestRecovery();
        } else await s.requestChallenge();
        const native = await s.getCurrentValue(), round = await s.latestRoundData();
        const replacement = await f.Source.deploy(f.queryId, 8);
        await s.proposeSourcesChange(replacement.target, f.backup.target);
        await s.proposeAdminChange(f.next.address);
        if (paused) await s.pause();
        await s.proposeMinPauseDurationChange(0);
        const at = await s.minPauseDurationProposedAt(), before = await otherState(f), pending = await durationState(s);
        await time.setNextBlockTimestamp(at + 99n);
        await expect(s.executeMinPauseDurationChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
        expect(await durationState(s)).to.deep.equal(pending); expect(await otherState(f)).to.deep.equal(before);
        await time.setNextBlockTimestamp(at + 100n);
        await expect(s.executeMinPauseDurationChange()).to.emit(s, "MinPauseDurationChanged").withArgs(200, 0);
        expect(await durationState(s)).to.deep.equal([0n, false, 0n, 0n]);
        expect(await otherState(f)).to.deep.equal(before);
        if (paused) {
          await expect(s.getCurrentValue()).to.be.revertedWithCustomError(s, "ShepherdPaused");
          await expect(s.unpause()).to.be.revertedWithCustomError(s, "SourcesChangePending");
        } else {
          expect(await s.getCurrentValue()).to.deep.equal(native); expect(await s.latestRoundData()).to.deep.equal(round);
        }
        await expect(s.proposeMinPauseDurationChange(0)).to.be.revertedWithCustomError(s, "MinPauseDurationUnchanged");
      });
    }
  }

  for (const reduced of [0, 50]) {
    it(`reducing an active pause to ${reduced} takes effect only at execution, preserving its start`, async function () {
      const f = await loadFixture(fixture), s = f.s;
      await s.pause(); const start = await s.pausedAt();
      await s.proposeMinPauseDurationChange(reduced); const at = await s.minPauseDurationProposedAt();
      await time.setNextBlockTimestamp(at + 99n);
      await expect(s.unpause()).to.be.revertedWithCustomError(s, "PauseDurationNotElapsed");
      expect(await s.minPauseDuration()).to.equal(200);
      await time.setNextBlockTimestamp(at + 100n); await s.executeMinPauseDurationChange();
      expect(await s.pausedAt()).to.equal(start); expect(await s.paused()).to.equal(true);
      await expect(s.connect(f.pauser).unpause()).to.be.revertedWithCustomError(s, "NotAdmin");
      await s.unpause(); expect(await s.pausedAt()).to.equal(0);
    });
  }
  it("increasing an active pause extends eligibility from the original start, with exact equality", async function () {
    const { s } = await loadFixture(fixture);
    await s.pause(); const start = await s.pausedAt();
    await s.proposeMinPauseDurationChange(400); await time.increase(100); await s.executeMinPauseDurationChange();
    expect(await s.pausedAt()).to.equal(start);
    for (const elapsed of [200n, 399n]) {
      await time.setNextBlockTimestamp(start + elapsed);
      await expect(s.unpause()).to.be.revertedWithCustomError(s, "PauseDurationNotElapsed");
    }
    await time.setNextBlockTimestamp(start + 400n); await s.unpause();
  });
  it("a pending increase does not affect unpause until executed", async function () {
    const { s } = await loadFixture(fixture);
    await s.pause(); const start = await s.pausedAt();
    await s.proposeMinPauseDurationChange(ethers.MaxUint256);
    await time.setNextBlockTimestamp(start + 199n);
    await expect(s.unpause()).to.be.revertedWithCustomError(s, "PauseDurationNotElapsed");
    await time.setNextBlockTimestamp(start + 200n); await s.unpause();
    expect(await s.minPauseDuration()).to.equal(200); expect(await s.minPauseDurationChangePending()).to.equal(true);
  });
  it("uint256-max updates avoid deadline overflow and remain reducible with unusable sources", async function () {
    const f = await loadFixture(fixture), s = f.s;
    await f.primary.configureRead(0, 0, 1); await f.backup.configureRead(0, 0, 1);
    await s.proposeMinPauseDurationChange(ethers.MaxUint256);
    await s.cancelMinPauseDurationChange();
    await s.proposeMinPauseDurationChange(ethers.MaxUint256);
    await time.increase(100); await s.executeMinPauseDurationChange();
    await s.pause(); const start = await s.pausedAt();
    await expect(s.unpause()).to.be.revertedWithCustomError(s, "PauseDurationNotElapsed");
    await s.proposeMinPauseDurationChange(0); await time.increase(100); await s.executeMinPauseDurationChange();
    expect(await s.pausedAt()).to.equal(start); await s.unpause();
    await expect(s.getCurrentValue()).to.be.revertedWithCustomError(f.primary, "ReadUnavailable");
  });

  for (const adminFirst of [false, true]) {
    for (const action of ["execute", "cancel"]) {
      it(`pending zero survives handover with its original clock; adminFirst=${adminFirst}, ${action}`, async function () {
        const f = await loadFixture(fixture), s = f.s;
        if (adminFirst) await s.proposeAdminChange(f.next.address); else await s.proposeMinPauseDurationChange(0);
        await time.increase(20);
        if (adminFirst) await s.proposeMinPauseDurationChange(0); else await s.proposeAdminChange(f.next.address);
        const at = await s.minPauseDurationProposedAt(), adminAt = await s.adminProposedAt();
        await time.setNextBlockTimestamp(adminAt + 100n); await s.executeAdminChange();
        expect(await durationState(s)).to.deep.equal([200n, true, 0n, at]);
        await expect(s.proposeMinPauseDurationChange(300)).to.be.revertedWithCustomError(s, "NotAdmin");
        for (const method of ["cancelMinPauseDurationChange", "executeMinPauseDurationChange"]) {
          await expect(s[method]()).to.be.revertedWithCustomError(s, "NotAdmin");
        }
        if (action === "execute") {
          if (adminFirst) {
            await time.setNextBlockTimestamp(at + 99n);
            await expect(s.connect(f.next).executeMinPauseDurationChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
            expect(await durationState(s)).to.deep.equal([200n, true, 0n, at]);
            await time.setNextBlockTimestamp(at + 100n);
          }
          await s.connect(f.next).executeMinPauseDurationChange();
          expect(await durationState(s)).to.deep.equal([0n, false, 0n, 0n]);
        } else {
          await s.connect(f.next).cancelMinPauseDurationChange();
          expect(await durationState(s)).to.deep.equal([200n, false, 0n, 0n]);
        }
      });
    }
  }
  it("cancellation/reproposal and source execution leave the other proposal clocks independent", async function () {
    const f = await loadFixture(fixture), s = f.s;
    const replacement = await f.Source.deploy(f.queryId, 8);
    await s.proposeSourcesChange(replacement.target, f.backup.target); const sourceAt = await s.sourcesProposedAt();
    await s.proposeAdminChange(f.next.address); const adminAt = await s.adminProposedAt();
    await s.proposeMinPauseDurationChange(0); await s.cancelMinPauseDurationChange();
    await s.proposeMinPauseDurationChange(50); const durationAt = await s.minPauseDurationProposedAt();
    expect(await s.sourcesProposedAt()).to.equal(sourceAt); expect(await s.adminProposedAt()).to.equal(adminAt);
    await s.cancelSourcesChange(); await s.proposeSourcesChange(replacement.target, f.backup.target);
    expect(await s.minPauseDurationProposedAt()).to.equal(durationAt); expect(await s.adminProposedAt()).to.equal(adminAt);
    await s.cancelAdminChange(); await s.proposeAdminChange(f.next.address); const newAdminAt = await s.adminProposedAt();
    expect(await s.minPauseDurationProposedAt()).to.equal(durationAt);
    await s.pause(); await time.increase(100); await s.executeSourcesChange();
    expect(await durationState(s)).to.deep.equal([200n, true, 50n, durationAt]);
    expect(await s.adminProposedAt()).to.equal(newAdminAt);
  });
});
