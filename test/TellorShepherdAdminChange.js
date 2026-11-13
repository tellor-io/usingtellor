const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

async function fixture() {
  const [deployer, admin, next, pauser, outsider] = await ethers.getSigners();
  const queryId = ethers.id("admin-transfer-feed");
  const Source = await ethers.getContractFactory("PriceSourceMock");
  const primary = await Source.deploy(queryId, 8), backup = await Source.deploy(queryId, 8);
  const timestamp = BigInt(await time.latest() - 10) * 1000n + 17n;
  await primary.configureRead(100, timestamp, 0);
  await backup.configureRead(150, timestamp, 0);
  const s = await (await ethers.getContractFactory("TellorShepherd")).deploy(
    queryId, 8, primary.target, backup.target, admin.address, 10, 100, 2000, [5, 7], 3600, true);
  await s.connect(admin).addPauser(pauser.address);
  return { deployer, admin, next, pauser, outsider, queryId, Source, primary, backup, timestamp, s };
}
// Admin transfer may change only admin and its own pending proposal/clock.
async function operationalState(s) {
  return Promise.all(["primarySource", "backupSource", "queryId", "decimals", "mode", "paused", "pausedAt",
    "pendingPrimarySource", "pendingBackupSource", "sourcesProposedAt", "challengePending", "challengeRequestedAt",
    "recoveryPending", "recoveryRequestedAt", "minPauseDuration", "challengeThresholdBps",
    "CHALLENGE_DELAY_SECONDS", "RECOVERY_DELAY_SECONDS", "MAX_DATA_AGE", "CONFIG_CHANGE_DELAY"].map(name => s[name]()));
}
async function transferState(s) {
  return Promise.all([s.admin(), s.pendingAdmin(), s.adminProposedAt()]);
}

describe("TellorShepherd - Delayed outgoing-admin transfer", function () {
  it("starts without a pending transfer and rejects absent/no-op/zero proposals", async function () {
    const f = await loadFixture(fixture), s = f.s.connect(f.admin);
    const before = await transferState(s);
    expect(before).to.deep.equal([f.admin.address, ethers.ZeroAddress, 0n]);
    for (const method of ["executeAdminChange", "cancelAdminChange"]) {
      await expect(s[method]()).to.be.revertedWithCustomError(s, "NoPendingAdminChange");
    }
    await expect(s.proposeAdminChange(ethers.ZeroAddress)).to.be.revertedWithCustomError(s, "InvalidAdmin");
    await expect(s.proposeAdminChange(f.admin.address)).to.be.revertedWithCustomError(s, "AdminUnchanged");
    expect(await transferState(s)).to.deep.equal(before);
  });

  for (const paused of [false, true]) {
    it(`only current admin controls every action, even after notice; paused=${paused}`, async function () {
      const f = await loadFixture(fixture), s = f.s.connect(f.admin);
      if (paused) await s.pause();
      await s.proposeAdminChange(f.next.address);
      await time.increase(100);
      const before = await transferState(s), operations = await operationalState(s);
      for (const caller of [f.deployer, f.next, f.pauser, f.outsider]) {
        await expect(s.connect(caller).proposeAdminChange(f.outsider.address)).to.be.revertedWithCustomError(s, "NotAdmin");
        for (const method of ["executeAdminChange", "cancelAdminChange"]) {
          await expect(s.connect(caller)[method]()).to.be.revertedWithCustomError(s, "NotAdmin");
        }
      }
      expect(await transferState(s)).to.deep.equal(before);
      expect(await operationalState(s)).to.deep.equal(operations);
      // The outgoing admin still controls pauser membership while the transfer is pending.
      await s.addPauser(f.outsider.address);
      await s.removePauser(f.outsider.address);
      await s.executeAdminChange();
      expect(await s.admin()).to.equal(f.next.address);
    });

    it(`requires cancellation before reproposal and restarts full notice; paused=${paused}`, async function () {
      const f = await loadFixture(fixture), s = f.s.connect(f.admin);
      if (paused) await s.pause();
      const at = BigInt(await time.latest() + 1);
      await expect(s.proposeAdminChange(f.next.address)).to.emit(s, "AdminChangeProposed").withArgs(f.next.address, at);
      await time.increase(100);
      for (const target of [f.next.address, f.outsider.address]) {
        await expect(s.proposeAdminChange(target)).to.be.revertedWithCustomError(s, "AdminChangePending");
      }
      expect(await s.adminProposedAt()).to.equal(at);
      const operations = await operationalState(s);
      await expect(s.cancelAdminChange()).to.emit(s, "AdminChangeCancelled").withArgs(f.next.address);
      expect(await transferState(s)).to.deep.equal([f.admin.address, ethers.ZeroAddress, 0n]);
      expect(await operationalState(s)).to.deep.equal(operations);
      await expect(s.executeAdminChange()).to.be.revertedWithCustomError(s, "NoPendingAdminChange");
      await s.proposeAdminChange(f.outsider.address);
      expect(await s.adminProposedAt()).to.be.greaterThan(at);
      await expect(s.executeAdminChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
    });

    for (const mode of [0, 1]) {
      it(`honors exact delay and preserves pending transitions, reads and pause; mode=${mode}, paused=${paused}`, async function () {
        const f = await loadFixture(fixture), s = f.s.connect(f.admin);
        if (mode) {
          await s.requestChallenge(); await time.increase(5); await s.executeChallenge();
          await f.backup.configureRead(100, f.timestamp, 0);
          await s.requestRecovery();
        } else await s.requestChallenge();
        const native = await s.getCurrentValue(), round = await s.latestRoundData();
        if (paused) await s.pause();
        await s.proposeAdminChange(f.next.address);
        const at = await s.adminProposedAt(), before = await operationalState(s);
        const transfer = await transferState(s);
        await time.setNextBlockTimestamp(at + 99n);
        await expect(s.executeAdminChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
        expect(await transferState(s)).to.deep.equal(transfer);
        expect(await operationalState(s)).to.deep.equal(before);
        await time.setNextBlockTimestamp(at + 100n);
        await expect(s.executeAdminChange()).to.emit(s, "AdminChanged").withArgs(f.admin.address, f.next.address);
        expect(await transferState(s)).to.deep.equal([f.next.address, ethers.ZeroAddress, 0n]);
        expect(await operationalState(s)).to.deep.equal(before);
        for (const account of [f.admin, f.next]) expect(await s.isPauser(account.address)).to.equal(false);
        expect(await s.isPauser(f.pauser.address)).to.equal(true);
        for (const method of ["executeAdminChange", "cancelAdminChange"]) {
          await expect(s[method]()).to.be.revertedWithCustomError(s, "NotAdmin");
          await expect(s.connect(f.next)[method]()).to.be.revertedWithCustomError(s, "NoPendingAdminChange");
        }
        await expect(s.proposeAdminChange(f.outsider.address)).to.be.revertedWithCustomError(s, "NotAdmin");
        await expect(s.addPauser(f.admin.address)).to.be.revertedWithCustomError(s, "NotAdmin");
        await expect(s.removePauser(f.pauser.address)).to.be.revertedWithCustomError(s, "NotAdmin");
        await expect(s.pause()).to.be.revertedWithCustomError(s, "NotAuthorizedToPause");
        await expect(s.unpause()).to.be.revertedWithCustomError(s, "NotAdmin");
        if (paused) {
          await expect(s.getCurrentValue()).to.be.revertedWithCustomError(s, "ShepherdPaused");
          await s.connect(f.next).unpause(); // Same old pause clock; minimum already elapsed.
        }
        expect(await s.getCurrentValue()).to.deep.equal(native);
        expect(await s.latestRoundData()).to.deep.equal(round);
        await s.connect(f.next).addPauser(f.outsider.address);
        await s.connect(f.next).removePauser(f.outsider.address);
        await s.connect(f.next).pause();
        await s.connect(f.next).proposeAdminChange(f.outsider.address);
        await s.connect(f.next).cancelAdminChange();
      });
    }
  }

  it("preserves separately granted pauser membership for outgoing and incoming admins", async function () {
    const f = await loadFixture(fixture), s = f.s.connect(f.admin);
    await s.addPauser(f.admin.address); await s.addPauser(f.next.address);
    await s.proposeAdminChange(f.next.address); await time.increase(100); await s.executeAdminChange();
    for (const account of [f.admin, f.next, f.pauser]) expect(await s.isPauser(account.address)).to.equal(true);
    await s.pause(); // Old admin retains only explicitly granted pauser authority.
    await expect(s.unpause()).to.be.revertedWithCustomError(s, "NotAdmin");
    await s.connect(f.next).removePauser(f.admin.address);
    expect(await s.isPauser(f.admin.address)).to.equal(false);
  });

  for (const destination of ["throwaway", "contract"]) {
    it(`permits a nonzero ${destination} without recipient action or source availability`, async function () {
      const f = await loadFixture(fixture), s = f.s.connect(f.admin);
      const target = destination === "throwaway" ? "0x000000000000000000000000000000000000dEaD" : f.primary.target;
      await f.primary.configureRead(0, 0, 1); await f.backup.configureRead(0, 0, 1);
      await s.proposeAdminChange(target); await time.increase(100); await s.executeAdminChange();
      expect(await s.admin()).to.equal(target);
      expect(await s.isPauser(target)).to.equal(false);
      await expect(s.proposeAdminChange(f.admin.address)).to.be.revertedWithCustomError(s, "NotAdmin");
    });
  }

  for (const adminFirst of [false, true]) {
    for (const action of ["execute", "cancel"]) {
      it(`source proposal survives transfer with independent clock; adminFirst=${adminFirst}, action=${action}`, async function () {
        const f = await loadFixture(fixture), s = f.s.connect(f.admin);
        const replacement = await f.Source.deploy(f.queryId, 8);
        const proposeSources = () => s.proposeSourcesChange(replacement.target, f.backup.target);
        if (adminFirst) await s.proposeAdminChange(f.next.address); else await proposeSources();
        await time.increase(20);
        if (adminFirst) await proposeSources(); else await s.proposeAdminChange(f.next.address);
        const adminAt = await s.adminProposedAt(), sourceAt = await s.sourcesProposedAt();
        expect(adminAt).not.to.equal(sourceAt);
        await time.setNextBlockTimestamp(adminAt + 100n);
        await s.executeAdminChange();
        expect(await s.pendingPrimarySource()).to.equal(replacement.target);
        expect(await s.sourcesProposedAt()).to.equal(sourceAt);
        await s.connect(f.next).pause();
        await time.increase(10);
        await expect(s.connect(f.next).unpause()).to.be.revertedWithCustomError(s, "SourcesChangePending");
        await expect(s.proposeSourcesChange(replacement.target, f.backup.target)).to.be.revertedWithCustomError(s, "NotAdmin");
        for (const method of ["executeSourcesChange", "cancelSourcesChange"]) {
          await expect(s[method]()).to.be.revertedWithCustomError(s, "NotAdmin");
        }
        if (action === "execute") {
          if (adminFirst) {
            await time.setNextBlockTimestamp(sourceAt + 99n);
            await expect(s.connect(f.next).executeSourcesChange()).to.be.revertedWithCustomError(s, "ConfigChangeDelayNotElapsed");
            expect(await s.sourcesProposedAt()).to.equal(sourceAt);
            await time.setNextBlockTimestamp(sourceAt + 100n);
          }
          await s.connect(f.next).executeSourcesChange();
          expect(await s.primarySource()).to.equal(replacement.target);
        } else {
          await replacement.configureMetadata(ethers.ZeroHash, 77); // Cancel does not consult it.
          await s.connect(f.next).cancelSourcesChange();
          expect(await s.primarySource()).to.equal(f.primary.target);
        }
        expect(await s.sourcesProposedAt()).to.equal(0);
        await s.connect(f.next).unpause();
      });
    }
  }

  it("cancellation/reproposal of either kind leaves the other proposal clock untouched", async function () {
    const f = await loadFixture(fixture), s = f.s.connect(f.admin);
    const replacement = await f.Source.deploy(f.queryId, 8);
    await s.proposeAdminChange(f.next.address);
    await s.proposeSourcesChange(replacement.target, f.backup.target);
    const sourceAt = await s.sourcesProposedAt();
    await s.cancelAdminChange(); await s.proposeAdminChange(f.outsider.address);
    expect(await s.sourcesProposedAt()).to.equal(sourceAt);
    const adminAt = await s.adminProposedAt();
    await s.cancelSourcesChange(); await s.proposeSourcesChange(replacement.target, f.backup.target);
    expect(await s.adminProposedAt()).to.equal(adminAt);
    await s.pause(); await time.increase(100); await s.executeSourcesChange();
    expect(await s.pendingAdmin()).to.equal(f.outsider.address);
    expect(await s.adminProposedAt()).to.equal(adminAt);
  });

  it("pending admin transfer does not block unpause or restart its clock", async function () {
    const f = await loadFixture(fixture), s = f.s.connect(f.admin);
    await s.pause(); const pausedAt = await s.pausedAt();
    await s.proposeAdminChange(f.next.address); const adminAt = await s.adminProposedAt();
    expect(await s.pausedAt()).to.equal(pausedAt);
    await time.setNextBlockTimestamp(pausedAt + 10n); await s.unpause();
    expect(await s.pendingAdmin()).to.equal(f.next.address);
    expect(await s.adminProposedAt()).to.equal(adminAt);
    expect(await s.paused()).to.equal(false);
  });
});
