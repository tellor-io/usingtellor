const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

describe("TellorShepherd - Real source integration", function () {
  async function fixture() {
    const [admin, streamer, requester, executor] = await ethers.getSigners();
    const queryId = ethers.id("shepherd-integration-feed");
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target);
    const Stream = await ethers.getContractFactory("StreamBackupOracle");
    const backup = await Stream.deploy(admin.address, streamer.address, 60);
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherd = await Shepherd.deploy({
      queryId, dataBank: bank.target, backupOracle: backup.target,
      admin: admin.address, relayReadDelay: 60,
      dataBankChangeDelay: 300, backupChangeDelay: 600, twapWindowMs: 30000,
      challengeThresholdBps: 2000, challengeDelaySeconds: 30, recoveryDelaySeconds: 90,
      maxPriceAge: 604800, decimals: 18
    });
    // Preserve a sub-second aggregate component so seconds/ms confusion cannot pass unnoticed.
    const aggregateStart = (await time.latest() - 10800) * 1000 + 17;
    return { admin, streamer, requester, executor, queryId, validatorSet, bridge, Bank, bank,
      Stream, backup, shepherd, aggregateStart };
  }

  async function relay(f, offsetMs, value, bank = f.bank) {
    const report = await h.prepareOracleData(
      f.queryId, ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [value]), f.validatorSet,
      { aggregateTimestamp: f.aggregateStart + offsetMs, attestationTimestamp: (await time.latest()) * 1000 }
    );
    await bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    return (await bank.getCurrentAggregateData(f.queryId)).relayTimestamp;
  }

  async function submit(f, value, backup = f.backup) {
    await backup.connect(f.streamer).submitValue(f.queryId, value);
    const index = (await backup.reportCount(f.queryId)) - 1n;
    const report = await backup.reports(f.queryId, index);
    return { index, at: report.submittedAt, pair: [BigInt(value), report.submittedAt * 1000n] };
  }

  async function deviatingFixture() {
    const f = await fixture();
    await relay(f, 0, 100);
    const endpoint = await relay(f, 30000, 100);
    await time.increaseTo(endpoint + 61n);
    await relay(f, 40000, 150);
    return f;
  }

  async function selectBackup(f) {
    await f.shepherd.connect(f.requester).requestChallenge();
    await relay(f, 45000, await f.shepherd.challengeReferenceValue());
    await time.setNextBlockTimestamp((await f.shepherd.challengeRequestedAt()) + 30n);
    await f.shepherd.connect(f.executor).resolveChallenge();
  }

  async function expectPaused(f, pauseClock) {
    expect(await f.shepherd.paused()).to.equal(true);
    expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
  }

  for (const outlier of [50, 150]) {
    it(`keeps reads live and switches before the temporary ${outlier} report matures`, async function () {
      const f = await loadFixture(fixture);
      const backupReport = await submit(f, 99);
      await relay(f, 0, 100);
      const endpoint = await relay(f, 30000, 100);
      await time.increaseTo(endpoint + 61n);
      const outlierRelay = await relay(f, 40000, outlier);
      await f.shepherd.requestChallenge();
      const requestedAt = await f.shepherd.challengeRequestedAt();
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
      // A persistent-looking move at the earliest resolution time must not cancel.
      await relay(f, 45000, outlier);
      await time.setNextBlockTimestamp(requestedAt + 30n);
      await expect(f.shepherd.resolveChallenge()).to.be.revertedWithCustomError(f.shepherd, "StillDeviating");
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
      await time.setNextBlockTimestamp(requestedAt + 40n);
      await relay(f, 50000, 100);
      await expect(f.shepherd.resolveChallenge()).to.emit(f.shepherd, "ChallengeExecuted");
      expect(BigInt(await time.latest())).to.be.lessThan(outlierRelay + 60n);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal(backupReport.pair);
      await time.increaseTo(outlierRelay + 61n);
      // The bank's mature selection is now the outlier; Shepherd already serves backup.
      const [, mature] = await f.bank.getRelayBefore(f.queryId, BigInt(await time.latest()) - 60n);
      expect(ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], mature.value)[0]).to.equal(outlier);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal(backupReport.pair);
    });

    it(`keeps a sustained move to ${outlier} on primary and expires only when called`, async function () {
      const f = await loadFixture(fixture);
      await relay(f, 0, 100);
      const endpoint = await relay(f, 30000, 100);
      await time.increaseTo(endpoint + 61n);
      await relay(f, 40000, outlier);
      await f.shepherd.requestChallenge();
      const requestedAt = await f.shepherd.challengeRequestedAt();
      await relay(f, 50000, outlier);
      await time.setNextBlockTimestamp(requestedAt + 30n);
      await expect(f.shepherd.resolveChallenge()).to.be.revertedWithCustomError(f.shepherd, "StillDeviating");
      await time.increaseTo(requestedAt + 61n);
      expect(await f.shepherd.challengePending()).to.equal(true);
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(outlier);
      await expect(f.shepherd.resolveChallenge()).to.emit(f.shepherd, "ChallengeExpired");
      expect(await f.shepherd.mode()).to.equal(0);
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(outlier);
    });
  }

  it("routes two Shepherds through a shared backup with isolated reports, disputes, and recovery", async function () {
    const f = await loadFixture(deviatingFixture);
    const queryId = ethers.id("second-shepherd-feed");
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherd = await Shepherd.deploy({
      queryId, dataBank: f.bank.target, backupOracle: f.backup.target,
      admin: f.admin.address, relayReadDelay: 60,
      dataBankChangeDelay: 300, backupChangeDelay: 600, twapWindowMs: 30000,
      challengeThresholdBps: 2000, challengeDelaySeconds: 30, recoveryDelaySeconds: 90,
      maxPriceAge: 604800, decimals: 18
    });
    const other = { ...f, queryId, shepherd };
    await relay(other, 0, 200);
    const endpoint = await relay(other, 30000, 200);
    await time.increaseTo(endpoint + 61n);
    await relay(other, 40000, 300);
    const firstReport = await submit(f, 97);
    const otherReport = await submit(other, 211);
    await selectBackup(f);
    await selectBackup(other);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal(firstReport.pair);
    expect(await other.shepherd.getCurrentValue()).to.deep.equal(otherReport.pair);
    await f.backup.disputeValue(f.queryId, firstReport.index);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoUsableReport");
    expect(await other.shepherd.getCurrentValue()).to.deep.equal(otherReport.pair);
    await f.backup.setCanRecover(f.queryId, true);
    await f.shepherd.connect(f.requester).requestRecovery();
    await expect(other.shepherd.connect(f.requester).requestRecovery())
      .to.be.revertedWithCustomError(other.shepherd, "RecoveryNotAllowed");
    const clock = await f.shepherd.recoveryRequestedAt();
    await time.setNextBlockTimestamp(clock + 90n);
    await f.shepherd.connect(f.executor).executeRecovery();
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, BigInt(f.aggregateStart + 45000)]);
    expect(await other.shepherd.mode()).to.equal(1);
    expect(await other.shepherd.getCurrentValue()).to.deep.equal(otherReport.pair);
  });

  it("rejects an unsupported replacement without changing the selected backup or recovery", async function () {
    const f = await loadFixture(deviatingFixture);
    await selectBackup(f);
    const Mock = await ethers.getContractFactory("BackupOracleMock");
    const wrongFeed = await Mock.deploy(ethers.id("unsupported-feed"));
    await wrongFeed.configureRead(777, 123456, 0);
    await wrongFeed.configureRecovery(true, 0);
    await expect(f.shepherd.proposeBackupChange(wrongFeed.target))
      .to.be.revertedWithCustomError(wrongFeed, "UnsupportedQueryId");
    expect(await f.shepherd.backupOracle()).to.equal(f.backup.target);
    expect(await f.shepherd.pendingBackupOracle()).to.equal(ethers.ZeroAddress);
    expect(await f.shepherd.backupProposedAt()).to.equal(0);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoUsableReport");
    await expect(f.shepherd.requestRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
    expect(await f.shepherd.recoveryPending()).to.equal(false);
    expect(await f.shepherd.mode()).to.equal(1);
  });

  it("requires a mature replacement report and preserves a pending challenge when a dispute blocks execution", async function () {
    const f = await loadFixture(deviatingFixture);
    await f.shepherd.requestChallenge();
    const challengeClock = await f.shepherd.challengeRequestedAt();
    const replacement = await f.Stream.deploy(f.admin.address, f.streamer.address, 60);
    await expect(f.shepherd.proposeBackupChange(replacement.target))
      .to.be.revertedWithCustomError(replacement, "NoUsableReport");
    const report = await submit(f, 96, replacement);
    await time.setNextBlockTimestamp(report.at + 59n);
    await expect(f.shepherd.proposeBackupChange(replacement.target))
      .to.be.revertedWithCustomError(replacement, "NoUsableReport");
    expect(await f.shepherd.pendingBackupOracle()).to.equal(ethers.ZeroAddress);
    expect(await f.shepherd.backupProposedAt()).to.equal(0);
    await time.setNextBlockTimestamp(report.at + 60n);
    await f.shepherd.proposeBackupChange(replacement.target);
    const proposedAt = await f.shepherd.backupProposedAt();
    await f.shepherd.pause();
    const pauseClock = await f.shepherd.pausedAt();
    await replacement.disputeValue(f.queryId, report.index);
    await time.setNextBlockTimestamp(proposedAt + 600n);
    await expect(f.shepherd.executeBackupChange())
      .to.be.revertedWithCustomError(replacement, "NoUsableReport");
    expect(await f.shepherd.backupOracle()).to.equal(f.backup.target);
    expect(await f.shepherd.pendingBackupOracle()).to.equal(replacement.target);
    expect(await f.shepherd.backupProposedAt()).to.equal(proposedAt);
    expect(await f.shepherd.challengePending()).to.equal(true);
    expect(await f.shepherd.challengeRequestedAt()).to.equal(challengeClock);
    expect(await f.shepherd.mode()).to.equal(0);
    await expectPaused(f, pauseClock);
    // Restoring source readability permits retry without restarting the proposal's notice.
    const fresh = await submit(f, 97, replacement);
    await time.setNextBlockTimestamp(fresh.at + 60n);
    await expect(f.shepherd.executeBackupChange()).to.emit(f.shepherd, "ChallengeInvalidated");
    expect(await f.shepherd.backupOracle()).to.equal(replacement.target);
    expect(await f.shepherd.pendingBackupOracle()).to.equal(ethers.ZeroAddress);
    expect(await f.shepherd.backupProposedAt()).to.equal(0);
    expect(await f.shepherd.challengePending()).to.equal(false);
    expect(await f.shepherd.challengeRequestedAt()).to.equal(0);
    expect(await f.shepherd.mode()).to.equal(0);
    await expectPaused(f, pauseClock);
  });

  it("keeps mature primary reads available without TWAP coverage and excludes the candidate's price weight", async function () {
    const f = await loadFixture(fixture);
    const first = await relay(f, 0, 100);
    await time.increaseTo(first + 60n);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoMatureData");
    await time.increase(1);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, BigInt(f.aggregateStart)]);
    await expect(f.shepherd.connect(f.requester).requestChallenge())
      .to.be.revertedWithCustomError(f.shepherd, "DiagnosticUnavailable");

    const candidate = await relay(f, 30000, 150);
    await time.increaseTo(candidate + 60n);
    expect((await f.bank.getTwapBefore(f.queryId, candidate, 30000))[0]).to.equal(false);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
    await time.increase(1);
    // The endpoint closes the 30-second interval: only the preceding 100 has weight.
    const [available, reference] = await f.bank.getTwapBefore(f.queryId, candidate + 1n, 30000);
    expect(available).to.equal(true);
    expect(reference.value).to.equal(100);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([150n, BigInt(f.aggregateStart + 30000)]);
    await f.shepherd.connect(f.requester).requestChallenge();
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(150);
  });

  it("challenges an immature latest candidate, switches while paused, and requires valid unpause", async function () {
    const f = await loadFixture(deviatingFixture);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
    const report = await submit(f, 97);
    await f.shepherd.pause();
    const pauseClock = await f.shepherd.pausedAt();
    await f.shepherd.connect(f.requester).requestChallenge();
    const requestedAt = await f.shepherd.challengeRequestedAt();
    await relay(f, 45000, 100);
    await time.setNextBlockTimestamp(requestedAt + 29n);
    await expect(f.shepherd.connect(f.executor).resolveChallenge())
      .to.be.revertedWithCustomError(f.shepherd, "ChallengeDelayNotElapsed");
    await time.setNextBlockTimestamp(requestedAt + 30n);
    await expect(f.shepherd.connect(f.executor).resolveChallenge()).to.emit(f.shepherd, "ChallengeExecuted");
    expect(await f.shepherd.mode()).to.equal(1);
    expect(await f.shepherd.challengePending()).to.equal(false);
    expect(await f.shepherd.challengeRequestedAt()).to.equal(0);
    await expectPaused(f, pauseClock);
    await time.increaseTo(report.at + 60n);
    expect(await f.backup.getCurrentValue(f.queryId)).to.deep.equal(report.pair);
    await expectPaused(f, pauseClock);
    await f.shepherd.unpause();
    expect(await f.shepherd.getCurrentValue()).to.deep.equal(report.pair);
  });

  it("selects an empty backup, then respects maturity and late disputes without primary fallback", async function () {
    const f = await loadFixture(deviatingFixture);
    await selectBackup(f);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoUsableReport");
    const first = await submit(f, 97);
    await time.increaseTo(first.at + 59n);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoUsableReport");
    await time.increase(1);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal(first.pair);
    const second = await submit(f, 98);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal(first.pair);
    await time.increaseTo(second.at + 60n);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal(second.pair);
    await f.backup.disputeValue(f.queryId, second.index);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal(first.pair);
    await f.backup.disputeValue(f.queryId, first.index);
    // Primary history is mature and readable at the bank, but cannot rescue backup mode.
    expect((await f.bank.getRelayBefore(f.queryId, BigInt(await time.latest()) - 60n))[0]).to.equal(true);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoUsableReport");
    expect(await f.shepherd.mode()).to.equal(1);
  });

  it("propagates the backup's 32-report search bound and resumes after a fresh report matures", async function () {
    const f = await loadFixture(deviatingFixture);
    await selectBackup(f);
    const older = await submit(f, 97);
    for (let i = 0; i < 32; i++) {
      const report = await submit(f, 98);
      await f.backup.disputeValue(f.queryId, report.index);
    }
    await time.increase(60);
    expect(await f.backup.isDisputed(f.queryId, older.index)).to.equal(false);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoUsableReport");
    const fresh = await submit(f, 99);
    await time.increaseTo(fresh.at + 60n);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal(fresh.pair);
  });

  it("rechecks admin recovery permission at execution and returns to real primary without lifting pause", async function () {
    const f = await loadFixture(deviatingFixture);
    await selectBackup(f);
    await expect(f.shepherd.connect(f.requester).requestRecovery())
      .to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
    await relay(f, 50000, 101);
    await f.shepherd.pause();
    const pauseClock = await f.shepherd.pausedAt();
    await f.backup.setCanRecover(f.queryId, true);
    await f.shepherd.connect(f.requester).requestRecovery();
    const requestedAt = await f.shepherd.recoveryRequestedAt();
    await time.setNextBlockTimestamp(requestedAt + 89n);
    await expect(f.shepherd.connect(f.executor).executeRecovery())
      .to.be.revertedWithCustomError(f.shepherd, "RecoveryDelayNotElapsed");
    await f.backup.setCanRecover(f.queryId, false);
    await expect(f.shepherd.connect(f.executor).executeRecovery())
      .to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
    expect(await f.shepherd.recoveryPending()).to.equal(true);
    expect(await f.shepherd.recoveryRequestedAt()).to.equal(requestedAt);
    await f.backup.setCanRecover(f.queryId, true);
    await f.shepherd.connect(f.executor).executeRecovery();
    expect(await f.shepherd.mode()).to.equal(0);
    expect(await f.shepherd.recoveryPending()).to.equal(false);
    expect(await f.shepherd.recoveryRequestedAt()).to.equal(0);
    await expectPaused(f, pauseClock);
    await f.shepherd.unpause();
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([101n, BigInt(f.aggregateStart + 50000)]);
  });

  for (const source of ["bank", "backup"]) {
    for (const pending of ["challenge", "recovery"]) {
      it(`invalidates ${pending} on real ${source} migration and requires a fresh transition timer`, async function () {
        const f = await loadFixture(deviatingFixture);
        if (pending === "recovery") {
          await selectBackup(f);
          await f.backup.setCanRecover(f.queryId, true);
          await f.shepherd.connect(f.requester).requestRecovery();
        } else {
          await f.shepherd.connect(f.requester).requestChallenge();
        }
        const oldClock = await f.shepherd[`${pending}RequestedAt`]();
        const replacement = source === "bank"
          ? await f.Bank.deploy(f.bridge.target)
          : await f.Stream.deploy(f.admin.address, f.streamer.address, 60);
        if (source === "bank") {
          await relay(f, 0, 110, replacement);
          await relay(f, 30000, 110, replacement);
          await relay(f, 40000, 170, replacement);
          await f.shepherd.proposeDataBankChange(replacement.target);
        } else {
          const report = await submit(f, 96, replacement);
          await time.increaseTo(report.at + 60n);
          await f.shepherd.proposeBackupChange(replacement.target);
        }
        expect(await f.shepherd[`${pending}RequestedAt`]()).to.equal(oldClock);
        await f.shepherd.pause();
        const pauseClock = await f.shepherd.pausedAt();
        const proposedAt = source === "bank"
          ? await f.shepherd.dataBankProposedAt() : await f.shepherd.backupProposedAt();
        await time.setNextBlockTimestamp(proposedAt + (source === "bank" ? 300n : 600n));
        const execution = source === "bank"
          ? f.shepherd.executeDataBankChange() : f.shepherd.executeBackupChange();
        await expect(execution).to.emit(f.shepherd, pending === "challenge" ? "ChallengeInvalidated" : "RecoveryInvalidated");
        expect(await f.shepherd[source === "bank" ? "dataBank" : "backupOracle"]()).to.equal(replacement.target);
        expect(await f.shepherd[`${pending}Pending`]()).to.equal(false);
        expect(await f.shepherd[`${pending}RequestedAt`]()).to.equal(0);
        expect(await f.shepherd.mode()).to.equal(pending === "challenge" ? 0 : 1);
        await expectPaused(f, pauseClock);

        if (pending === "recovery") {
          if (source === "bank") {
            // Migration clears Shepherd's timer, not the external admin's standing permission.
            expect(await f.backup.canRecover(f.queryId)).to.equal(true);
            await f.shepherd.connect(f.requester).requestRecovery();
            await f.backup.setCanRecover(f.queryId, false);
            await f.shepherd.connect(f.executor).cancelRecovery();
          }
          await expect(f.shepherd.connect(f.requester).requestRecovery())
            .to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
          const currentBackup = source === "bank" ? f.backup : replacement;
          await currentBackup.setCanRecover(f.queryId, true);
          await f.shepherd.connect(f.requester).requestRecovery();
          const freshClock = await f.shepherd.recoveryRequestedAt();
          expect(freshClock).to.be.greaterThan(oldClock);
          await expect(f.shepherd.connect(f.executor).executeRecovery())
            .to.be.revertedWithCustomError(f.shepherd, "RecoveryDelayNotElapsed");
          await time.setNextBlockTimestamp(freshClock + 90n);
          await f.shepherd.connect(f.executor).executeRecovery();
        } else {
          await f.shepherd.connect(f.requester).requestChallenge();
          expect(await f.shepherd.challengeRequestedAt()).to.be.greaterThan(oldClock);
          await expect(f.shepherd.connect(f.executor).resolveChallenge())
            .to.be.revertedWithCustomError(f.shepherd, "ChallengeDelayNotElapsed");
        }
        await expectPaused(f, pauseClock);
        await f.shepherd.unpause();
        const expectedPrimary = source === "bank" ? 170n : pending === "recovery" ? 100n : 150n;
        const expectedOffset = source === "backup" && pending === "recovery" ? 45000 : 40000;
        expect(await f.shepherd.getCurrentValue()).to.deep.equal([expectedPrimary, BigInt(f.aggregateStart + expectedOffset)]);
        if (pending === "challenge") {
          await relay(f, 45000, await f.shepherd.challengeReferenceValue(), source === "bank" ? replacement : f.bank);
          await time.setNextBlockTimestamp((await f.shepherd.challengeRequestedAt()) + 30n);
          await f.shepherd.connect(f.executor).resolveChallenge();
          if (source === "backup") {
            const report = await replacement.reports(f.queryId, 0);
            expect(await f.shepherd.getCurrentValue()).to.deep.equal([96n, report.submittedAt * 1000n]);
          } else {
            await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoUsableReport");
          }
        }
      });
    }
  }
});
