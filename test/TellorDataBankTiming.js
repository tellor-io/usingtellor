const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const h = require("../src/helpers/evmHelpers");

describe("TellorDataBank timing", function () {
  const queryId = ethers.id("bank-timing");
  const value = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [100]);

  async function fixture() {
    const [guardian] = await ethers.getSigners();
    const validators = await h.createTellorValset();
    const bridge = await (await ethers.getContractFactory("TellorDataBridge")).deploy(guardian.address, validators.domainSeparator);
    await bridge.init(validators.powerThreshold, validators.timestamp, 21 * 86400, validators.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target, 43200, 600, 86400);
    return { validators, bridge, Bank, bank };
  }

  async function report(f, overrides = {}) {
    return h.prepareOracleData(queryId, value, f.validators, { ignoreInvariantChecks: true, ...overrides });
  }

  function relay(bank, data) {
    return bank.updateOracleData(data.attestData, data.currentValidatorSet, data.sigs);
  }

  it("requires positive immutable seconds without a twelve-hour floor or additional range bounds", async function () {
    const f = await loadFixture(fixture);
    for (const invalid of [[0, 1, 1], [1, 0, 1], [1, 1, 0]]) {
      await expect(f.Bank.deploy(f.bridge.target, ...invalid))
        .to.be.revertedWithCustomError(f.bank, "InvalidTimingConfiguration");
    }
    for (const durations of [[1n, 1n, 1n], [ethers.MaxUint256, ethers.MaxUint256, ethers.MaxUint256], [60n, 30n, 120n]]) {
      const bank = await f.Bank.deploy(f.bridge.target, ...durations);
      expect(await Promise.all([bank.OPTIMISTIC_DELAY(), bank.MAX_ATTESTATION_AGE(), bank.MAX_DATA_AGE()]))
        .to.deep.equal(durations);
    }
  });

  it("uses configured age limits with exclusive equality", async function () {
    const f = await loadFixture(fixture);
    const bank = await f.Bank.deploy(f.bridge.target, 60, 30, 120);
    const now = (await time.latest()) * 1000;
    for (const [aggregateAge, attestationAge, error] of [
      [119, 0, null], [120, 0, "TellorDataBank: Data too old"],
      [30, 29, null], [31, 30, "TellorDataBank: Attestation too old"],
    ]) {
      const data = await report(f, { aggregateTimestamp: now - aggregateAge * 1000,
        attestationTimestamp: now - attestationAge * 1000 });
      const call = bank.updateOracleData.staticCall(data.attestData, data.currentValidatorSet, data.sigs);
      if (error) await expect(call).to.be.revertedWith(error);
      else await expect(call).not.to.be.reverted;
    }
  });

  it("uses a sub-twelve-hour optimistic delay with inclusive equality and no relabeling", async function () {
    const f = await loadFixture(fixture);
    const bank = await f.Bank.deploy(f.bridge.target, 60, 30, 120);
    const now = (await time.latest()) * 1000;
    for (const elapsedMs of [59999, 60000, 60999]) {
      const data = await report(f, { aggregateTimestamp: now - elapsedMs, attestationTimestamp: now,
        lastConsensusTimestamp: now - elapsedMs - 1000 });
      const call = bank.updateOracleData.staticCall(data.attestData, data.currentValidatorSet, data.sigs);
      if (elapsedMs < 60000) await expect(call).to.be.revertedWith("TellorDataBank: Dispute period not passed");
      else await expect(call).not.to.be.reverted;
    }
    const accepted = await report(f, { aggregateTimestamp: now - 60000, attestationTimestamp: now,
      lastConsensusTimestamp: now - 61000 });
    await relay(bank, accepted);
    expect((await bank.getCurrentAggregateData(queryId)).aggregateTimestamp).to.equal(now - 60000);
  });

  it("uses the configured optimistic window when checking a more recent report", async function () {
    const f = await loadFixture(fixture);
    const bank = await f.Bank.deploy(f.bridge.target, 60, 30, 120);
    const now = (await time.latest()) * 1000;
    for (const nextAge of [59, 60]) {
      const data = await report(f, { aggregateTimestamp: now - 90000, attestationTimestamp: now,
        lastConsensusTimestamp: now - 91000, nextTimestamp: now - nextAge * 1000 });
      const call = bank.updateOracleData.staticCall(data.attestData, data.currentValidatorSet, data.sigs);
      if (nextAge === 60) await expect(call).to.be.revertedWith("TellorDataBank: More recent optimistic report available");
      else await expect(call).not.to.be.reverted;
    }
  });

  const invalid = [
    ["future report", now => ({ aggregateTimestamp: now + 60000, attestationTimestamp: now + 60000 }), "ReportTimestampInFuture"],
    ["future attestation", now => ({ attestationTimestamp: now + 60000 }), "AttestationTimestampInFuture"],
    ["maximum attestation", () => ({ attestationTimestamp: ethers.MaxUint256 }), "AttestationTimestampInFuture"],
    ["future next report", now => ({ nextTimestamp: now + 60000 }), "NextTimestampInFuture"],
    ["maximum next report", () => ({ nextTimestamp: ethers.MaxUint256 }), "NextTimestampInFuture"],
    ["reversed consensus times", now => ({ aggregateTimestamp: now - 1000, attestationTimestamp: now - 1001 }), "AttestationBeforeReport"],
    ["reversed optimistic times", now => ({ aggregateTimestamp: now - 1000, attestationTimestamp: now - 1001,
      lastConsensusTimestamp: now - 2000 }), "AttestationBeforeReport"],
  ];

  for (const [label, overrides, error] of invalid) {
    it(`rejects ${label} with a specific error and preserves history`, async function () {
      const f = await loadFixture(fixture);
      const first = await report(f);
      await relay(f.bank, first);
      const now = (await time.latest()) * 1000;
      await expect(relay(f.bank, await report(f, overrides(now))))
        .to.be.revertedWithCustomError(f.bank, error);
      expect(await f.bank.getAggregateValueCount(queryId)).to.equal(1);
      expect(await f.bank.cumulativePrice(queryId, 0)).to.equal(0);
      expect((await f.bank.getCurrentAggregateData(queryId)).aggregateTimestamp).to.equal(first.attestData.report.timestamp);
      await relay(f.bank, await report(f));
      expect(await f.bank.getAggregateValueCount(queryId)).to.equal(2);
    });
  }

  it("accepts equal report/attestation times and preserves whole-second future checks", async function () {
    const f = await loadFixture(fixture);
    const now = (await time.latest()) * 1000;
    for (const offset of [0, 999]) {
      const data = await report(f, { aggregateTimestamp: now + offset, attestationTimestamp: now + offset });
      await expect(f.bank.updateOracleData.staticCall(data.attestData, data.currentValidatorSet, data.sigs)).not.to.be.reverted;
    }
    const data = await report(f, { aggregateTimestamp: now + 1000, attestationTimestamp: now + 1000 });
    await expect(f.bank.updateOracleData.staticCall(data.attestData, data.currentValidatorSet, data.sigs))
      .to.be.revertedWithCustomError(f.bank, "ReportTimestampInFuture");
  });
});
