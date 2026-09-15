const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

describe("TellorShepherd", function () {
  const abi = new ethers.AbiCoder();
  const queryId = h.hash(
    abi.encode(
      ["string", "bytes"],
      ["SpotPrice", abi.encode(["string", "string"], ["eth", "usd"])]
    )
  );

  const RELAY_DELAY = 60;
  const TWAP_WINDOW = 120_000; // aggregate timestamps are milliseconds
  const MIN_COVERAGE = 120_000;
  const MAX_COVERAGE = 180_000;
  const MIN_OBSERVATIONS = 3;
  const DEVIATION_BPS = 1_000;
  const GOVERNANCE_DELAY = 3_600;
  const CHALLENGE_DELAY = 3_600;
  const ROLE_DELAY = 1_800;
  const MAX_SPOT_PRICE = h.toWei("1000000000000");

  const parameters = {
    relayConsumptionDelay: RELAY_DELAY,
    twapWindow: TWAP_WINDOW,
    minTwapCoverage: MIN_COVERAGE,
    maxTwapCoverage: MAX_COVERAGE,
    minTwapObservations: MIN_OBSERVATIONS,
    deviationThresholdBps: DEVIATION_BPS,
    challengeDelay: CHALLENGE_DELAY,
    unpauseDelay: GOVERNANCE_DELAY,
    dataBankChangeDelay: GOVERNANCE_DELAY,
    roleChangeDelay: ROLE_DELAY,
    adminTransferDelay: GOVERNANCE_DELAY,
  };

  async function fixture() {
    const [deployer, admin, pauser, stranger, nextAdmin] = await ethers.getSigners();
    const valset = await h.createTellorValset({ tellorChainId: "tellor-1" });

    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, valset.domainSeparator);
    await bridge.init(
      valset.powerThreshold,
      valset.timestamp,
      1_814_400,
      valset.checkpoint
    );

    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(
      bridge.target,
      86_400,
      600,
      43_200,
      MAX_SPOT_PRICE
    );

    const Backup = await ethers.getContractFactory("ManualBackupOracle");
    const backup = await Backup.deploy(admin.address);

    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherd = await Shepherd.deploy(
      bank.target,
      admin.address,
      backup.target,
      queryId,
      parameters,
      [pauser.address]
    );

    return {
      shepherd,
      bank,
      backup,
      bridge,
      valset,
      admin,
      pauser,
      stranger,
      nextAdmin,
    };
  }

  async function relay(bank, valset, price, advance = 0) {
    if (advance > 0) await time.increase(advance);
    const prepared = await h.prepareOracleData(
      queryId,
      abi.encode(["uint256"], [h.toWei(price)]),
      valset
    );
    const tx = await bank.updateOracleData(
      prepared.attestData,
      prepared.currentValidatorSet,
      prepared.sigs
    );
    const receipt = await tx.wait();
    return {
      index: Number(await bank.getAggregateValueCount(queryId)) - 1,
      value: h.toWei(price),
      aggregateTimestamp: BigInt(prepared.attestData.report.timestamp),
      relayTimestamp: BigInt(
        (await ethers.provider.getBlock(receipt.blockNumber)).timestamp
      ),
    };
  }

  async function seedHealthyHistory(bank, valset) {
    const reports = [];
    reports.push(await relay(bank, valset, "100"));
    reports.push(await relay(bank, valset, "100", 60));
    reports.push(await relay(bank, valset, "100", 60));
    return reports;
  }

  async function seedDeviation(bank, valset) {
    const reports = await seedHealthyHistory(bank, valset);
    reports.push(await relay(bank, valset, "200", 60));
    await time.increase(RELAY_DELAY + 1);
    return reports;
  }

  it("is a view-only oracle during healthy operation", async function () {
    const { shepherd, bank, valset } = await loadFixture(fixture);
    const reports = await seedHealthyHistory(bank, valset);
    await time.increase(RELAY_DELAY + 1);

    expect(shepherd.interface.getFunction("getCurrentValue").stateMutability).to.equal(
      "view"
    );
    const preview = await shepherd.previewValue();
    expect(preview.status).to.equal(1); // NORMAL
    expect(preview.candidateIndex).to.equal(2);
    expect(preview.twap).to.equal(h.toWei("100"));
    expect(preview.deviationBps).to.equal(0);

    const [value, aggregateTimestamp] = await shepherd.getCurrentValue();
    expect(value).to.equal(h.toWei("100"));
    expect(aggregateTimestamp).to.equal(reports[2].aggregateTimestamp);
  });

  it("still returns the delayed relay when it deviates from TWAP", async function () {
    const { shepherd, bank, valset } = await loadFixture(fixture);
    const reports = await seedDeviation(bank, valset);

    const preview = await shepherd.previewValue();
    expect(preview.status).to.equal(6); // DEVIATING
    expect(preview.candidateValue).to.equal(h.toWei("200"));
    expect(preview.twap).to.equal(h.toWei("100"));
    expect(preview.deviationBps).to.equal(10_000);

    const [value, aggregateTimestamp] = await shepherd.getCurrentValue();
    expect(value).to.equal(h.toWei("200"));
    expect(aggregateTimestamp).to.equal(reports[3].aggregateTimestamp);
  });

  it("lets anyone open a challenge when the delayed relay is deviant", async function () {
    const { shepherd, bank, valset, stranger } = await loadFixture(fixture);
    await seedHealthyHistory(bank, valset);
    await time.increase(RELAY_DELAY + 1);

    await expect(shepherd.challenge()).to.be.revertedWithCustomError(
      shepherd,
      "ChallengeNotRequired"
    );

    await seedDeviation(bank, valset);
    await expect(shepherd.connect(stranger).challenge()).to.emit(
      shepherd,
      "ChallengeOpened"
    );

    expect(await shepherd.challengeStartTime()).to.be.gt(0);
    expect((await shepherd.previewValue()).status).to.equal(7); // CHALLENGING
    expect((await shepherd.getCurrentValue())[0]).to.equal(h.toWei("200"));

    await expect(shepherd.challenge()).to.be.revertedWithCustomError(
      shepherd,
      "ChallengePending"
    );
  });

  it("keeps serving the delayed relay until a matured challenge is executed", async function () {
    const { shepherd, bank, backup, valset, admin, stranger } =
      await loadFixture(fixture);
    await seedDeviation(bank, valset);
    await shepherd.connect(stranger).challenge();
    await backup.connect(admin).setValue(h.toWei("101"));

    await expect(
      shepherd.connect(stranger).executeChallenge()
    ).to.be.revertedWithCustomError(shepherd, "DelayNotPassed");

    expect((await shepherd.getCurrentValue())[0]).to.equal(h.toWei("200"));

    await backup.connect(admin).setReadyToReturn(true);
    await time.increase(CHALLENGE_DELAY);
    await expect(
      shepherd.connect(stranger).executeChallenge()
    ).to.be.revertedWithCustomError(shepherd, "BackupReadyToReturn");

    await backup.connect(admin).setReadyToReturn(false);
    await expect(shepherd.connect(stranger).executeChallenge())
      .to.emit(shepherd, "ChallengeExecuted")
      .withArgs(stranger.address, h.toWei("200"), h.toWei("100"), 10_000);

    expect(await shepherd.usingBackup()).to.equal(true);
    expect(await shepherd.challengeStartTime()).to.equal(0);
    expect((await shepherd.previewValue()).status).to.equal(2); // BACKUP
    expect((await shepherd.getCurrentValue())[0]).to.equal(h.toWei("101"));
  });

  it("clears the challenge without switching if deviation has resolved", async function () {
    const { shepherd, bank, valset, stranger } = await loadFixture(fixture);
    await seedDeviation(bank, valset);
    await shepherd.connect(stranger).challenge();

    await relay(bank, valset, "100", 60);
    await relay(bank, valset, "100", 60);
    await relay(bank, valset, "100", 60);
    await time.increase(CHALLENGE_DELAY);

    await expect(shepherd.connect(stranger).executeChallenge())
      .to.emit(shepherd, "ChallengeCleared")
      .withArgs(stranger.address);

    expect(await shepherd.usingBackup()).to.equal(false);
    expect(await shepherd.challengeStartTime()).to.equal(0);
    expect((await shepherd.previewValue()).status).to.equal(1); // NORMAL
    expect((await shepherd.getCurrentValue())[0]).to.equal(h.toWei("100"));
  });

  it("returns to Tellor only after the backup oracle is ready", async function () {
    const { shepherd, bank, backup, valset, admin, stranger } =
      await loadFixture(fixture);
    await seedDeviation(bank, valset);
    await backup.connect(admin).setValue(h.toWei("101"));
    await shepherd.connect(stranger).challenge();
    await time.increase(CHALLENGE_DELAY);
    await shepherd.connect(stranger).executeChallenge();

    await expect(shepherd.connect(stranger).returnToPrimary()).to.be.revertedWithCustomError(
      shepherd,
      "BackupNotReady"
    );
    await expect(shepherd.connect(stranger).challenge()).to.be.revertedWithCustomError(
      shepherd,
      "UsingBackup"
    );

    await relay(bank, valset, "100", 60);
    await relay(bank, valset, "100", 60);
    const recovered = await relay(bank, valset, "100", 60);
    await time.increase(RELAY_DELAY + 1);

    await backup.connect(admin).setReadyToReturn(true);
    await expect(shepherd.connect(stranger).returnToPrimary())
      .to.emit(shepherd, "ReturnedToPrimary")
      .withArgs(stranger.address);

    expect(await shepherd.usingBackup()).to.equal(false);
    const [value, aggregateTimestamp] = await shepherd.getCurrentValue();
    expect(value).to.equal(h.toWei("100"));
    expect(aggregateTimestamp).to.equal(recovered.aggregateTimestamp);
  });

  it("retains fast pausing and delayed unpause", async function () {
    const { shepherd, pauser, admin } = await loadFixture(fixture);
    await shepherd.connect(pauser).pause();

    expect((await shepherd.previewValue()).status).to.equal(3); // PAUSED
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(
      shepherd,
      "ShepherdPaused"
    );

    await shepherd.connect(admin).proposeUnpause();
    await expect(shepherd.connect(admin).executeUnpause()).to.be.revertedWithCustomError(
      shepherd,
      "DelayNotPassed"
    );
    await time.increase(GOVERNANCE_DELAY);
    await shepherd.connect(admin).executeUnpause();
    expect(await shepherd.paused()).to.equal(false);
  });

  it("delays authority expansion and DataBank migration", async function () {
    const { shepherd, bridge, admin, pauser, stranger, nextAdmin } =
      await loadFixture(fixture);

    await shepherd.connect(admin).proposePauser(stranger.address);
    await expect(shepherd.executePauser(stranger.address)).to.be.revertedWithCustomError(
      shepherd,
      "DelayNotPassed"
    );
    await time.increase(ROLE_DELAY);
    await shepherd.executePauser(stranger.address);
    expect(await shepherd.pausers(stranger.address)).to.equal(true);

    const Bank = await ethers.getContractFactory("TellorDataBank");
    const newBank = await Bank.deploy(
      bridge.target,
      86_400,
      600,
      43_200,
      MAX_SPOT_PRICE
    );
    await shepherd.connect(admin).proposeDataBank(newBank.target);
    await time.increase(GOVERNANCE_DELAY);
    await expect(
      shepherd.connect(admin).executeDataBankChange()
    ).to.be.revertedWithCustomError(shepherd, "ShepherdPaused");

    await shepherd.connect(pauser).pause();
    await shepherd.connect(admin).executeDataBankChange();
    expect(await shepherd.dataBank()).to.equal(newBank.target);

    await shepherd.connect(admin).proposeAdmin(nextAdmin.address);
    await time.increase(GOVERNANCE_DELAY);
    await shepherd.connect(nextAdmin).acceptAdmin();
    expect(await shepherd.admin()).to.equal(nextAdmin.address);
  });
});
