const { loadFixture, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TellorShepherd - Delayed spot backup reads", function () {
  const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
  const h = require("../src/helpers/evmHelpers");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const delay = 60;
  const encode = (value) => coder.encode(["uint256"], [value]);

  async function sources(bank, queryId, decimals = 18) {
    const primary = await (await ethers.getContractFactory("TellorTwapSource")).deploy(bank, queryId, decimals, 60, 30000);
    const backup = await (await ethers.getContractFactory("TellorSpotSource")).deploy(bank, queryId, decimals, 60);
    return { primary, backup };
  }

  async function deployReadFixture() {
    const [deployer, admin] = await ethers.getSigners();
    const queryId = ethers.id("primary-read-test-feed");
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target, 43200, 600, 86400);
    const Shepherd = await ethers.getContractFactory("TellorShepherdHarness");
    const { primary, backup } = await sources(bank.target, queryId);
    const shepherd = await Shepherd.deploy(queryId, 18, primary.target, backup.target, admin.address, 120, 300, 2000, [30, 90], 3600);
    await shepherd.waitForDeployment();
    await shepherd.setModeForTest(1);
    return { deployer, admin, queryId, validatorSet, bank, primary, backup, Shepherd, shepherd };
  }

  async function relay(fixture, payload, overrides = {}, queryId = fixture.queryId) {
    const report = await h.prepareOracleData(queryId, payload, fixture.validatorSet, overrides);
    const tx = await fixture.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    return { relayTime: block.timestamp, aggregateTimestamp: BigInt(report.attestData.report.timestamp) };
  }

  async function injectLookupPayload(fixture, payload) {
    // The real bank now rejects invalid prices at admission. Model an incompatible/misbehaving
    // dependency with a correctly encoded lookup response to retain Shepherd validation coverage.
    const record = await relay(fixture, encode(100));
    await time.increaseTo(record.relayTime + delay + 1);
    const response = coder.encode(
      ["bool", "tuple(bytes,uint256,uint256,uint256,uint256)"],
      [true, [payload, 1, record.aggregateTimestamp, record.aggregateTimestamp, record.relayTime]]
    );
    const length = ((response.length - 2) / 2).toString(16).padStart(4, "0");
    // Copy the ABI response following this 15-byte runtime prefix into memory, then return it.
    await setCode(fixture.bank.target, `0x61${length}61000f60003961${length}6000f3${response.slice(2)}`);
    return record;
  }

  it("blocks a valid read immediately and lets relay maturity advance during pause", async function () {
    const f = await loadFixture(deployReadFixture);
    const first = await relay(f, encode(100));
    await time.increaseTo(first.relayTime + delay + 1);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
    await f.shepherd.connect(f.admin).pause();
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
    const second = await relay(f, encode(200));
    await time.increaseTo(Number(await f.shepherd.pausedAt()) + 120);
    await f.shepherd.connect(f.admin).unpause();
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([200n, second.aggregateTimestamp]);
    expect(await f.shepherd.mode()).to.equal(1);
  });

  it("reports pause before an empty-history failure", async function () {
    const f = await loadFixture(deployReadFixture);
    await f.shepherd.connect(f.admin).pause();
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
  });

  it("keeps serving the original bank during notice and switches reads only after paused migration", async function () {
    const f = await loadFixture(deployReadFixture);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const replacement = await Bank.deploy(await f.bank.dataBridge(), 43200, 600, 86400);
    const next = await sources(replacement.target, f.queryId);
    const original = await relay(f, encode(100));
    const updated = await relay({ ...f, bank: replacement }, encode(200));
    await time.increaseTo(updated.relayTime + delay + 1);
    await f.shepherd.connect(f.admin).proposeSourcesChange(next.primary.target, next.backup.target);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, original.aggregateTimestamp]);
    await f.shepherd.connect(f.admin).pause();
    const pausedAt = await f.shepherd.pausedAt();
    await time.setNextBlockTimestamp(Number(await f.shepherd.sourcesProposedAt()) + 300);
    await expect(f.shepherd.connect(f.admin).executeSourcesChange())
      .to.emit(f.shepherd, "SourcesChanged").withArgs(f.primary.target, f.backup.target, next.primary.target, next.backup.target);
    expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
    expect(await f.shepherd.mode()).to.equal(1);
    expect(await f.shepherd.queryId()).to.equal(f.queryId);
    expect(await f.shepherd.pendingPrimarySource()).to.equal(ethers.ZeroAddress);
    expect(await f.shepherd.sourcesProposedAt()).to.equal(0);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
    await f.shepherd.connect(f.admin).unpause();
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([200n, updated.aggregateTimestamp]);
    await expect(f.shepherd.connect(f.admin).executeSourcesChange())
      .to.be.revertedWithCustomError(f.shepherd, "NoPendingSourcesChange");
  });

  it("rejects an empty history", async function () {
    const { shepherd, backup } = await loadFixture(deployReadFixture);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(backup, "NoData");
  });

  it("uses relay time for strict maturity and preserves subsecond observation time", async function () {
    const f = await loadFixture(deployReadFixture);
    const observation = (await time.latest() - 300) * 1000 + 123;
    const record = await relay(f, encode(2000), {
      aggregateTimestamp: observation,
      attestationTimestamp: (await time.latest()) * 1000,
    });
    // The observation is already old; only EVM relay time starts the read delay.
    await time.increaseTo(record.relayTime + delay - 1);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoData");
    await time.increaseTo(record.relayTime + delay);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoData");
    await time.increaseTo(record.relayTime + delay + 1);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([2000n, BigInt(observation)]);
  });

  it("selects the newest mature relay despite a newer immature relay", async function () {
    const f = await loadFixture(deployReadFixture);
    await relay(f, encode(100));
    await time.increase(10);
    const second = await relay(f, encode(200));
    await time.increaseTo(second.relayTime + delay + 1);
    const third = await relay(f, encode(300));
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([200n, second.aggregateTimestamp]);
    await time.increaseTo(third.relayTime + delay);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([200n, second.aggregateTimestamp]);
    await time.increaseTo(third.relayTime + delay + 1);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([300n, third.aggregateTimestamp]);
  });

  it("does not consume another feed's history", async function () {
    const f = await loadFixture(deployReadFixture);
    const record = await relay(f, encode(2000), {}, ethers.id("another-feed"));
    await time.increaseTo(record.relayTime + delay + 1);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "NoData");
  });

  for (const length of [0, 1, 31]) {
    it(`rejects a ${length}-byte selected payload without using an older valid record`, async function () {
      const f = await loadFixture(deployReadFixture);
      await relay(f, encode(100));
      await time.increase(10);
      await injectLookupPayload(f, "0x" + "ab".repeat(length));
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "InvalidValueLength");
    });
  }

  for (const suffix of ["", "ff", "ab".repeat(32)]) {
    it(`rejects a zero first word with ${suffix.length / 2} trailing bytes`, async function () {
      const f = await loadFixture(deployReadFixture);
      await relay(f, encode(100));
      await time.increase(10);
      await injectLookupPayload(f, encode(0) + suffix);
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "ZeroValue");
    });
  }

  for (const suffix of ["ff", "ab".repeat(32)]) {
    it(`accepts ${suffix.length / 2} trailing bytes and decodes only the first word`, async function () {
      const f = await loadFixture(deployReadFixture);
      const record = await injectLookupPayload(f, encode(ethers.MaxUint256) + suffix);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([ethers.MaxUint256, record.aggregateTimestamp]);
    });
  }

  it("reverts when the configured dependency cannot answer the lookup", async function () {
    const f = await loadFixture(deployReadFixture);
    const incompatible = await (await ethers.getContractFactory("TellorLab")).deploy();
    const next = await sources(incompatible.target, f.queryId);
    const shepherd = await f.Shepherd.deploy(f.queryId, 18, next.primary.target, next.backup.target, f.admin.address, 120, 300, 2000, [30, 90], 3600);
    await shepherd.setModeForTest(1);
    await expect(shepherd.getCurrentValue()).to.be.reverted;
  });

  it("propagates source unavailability when delay exceeds chain time", async function () {
    const f = await loadFixture(deployReadFixture);
    const futureDelay = (await time.latest()) + 100;
    const backup = await (await ethers.getContractFactory("TellorSpotSource")).deploy(f.bank.target, f.queryId, 18, futureDelay);
    const shepherd = await f.Shepherd.deploy(f.queryId, 18, f.primary.target, backup.target, f.admin.address, 120, 300, 2000, [30, 90], 3600);
    await shepherd.setModeForTest(1);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(backup, "NoData");
    await time.increaseTo(futureDelay);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(backup, "NoData");
    await time.increaseTo(futureDelay + 1);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(backup, "NoData");
  });
});
