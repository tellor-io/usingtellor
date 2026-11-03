const { loadFixture, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TellorShepherd - Delayed spot backup reads", function () {
  const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
  const h = require("../src/helpers/evmHelpers");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const delay = 60;
  const encode = (value) => coder.encode(["uint256"], [value]);

  async function deployReadFixture() {
    const [deployer, admin] = await ethers.getSigners();
    const queryId = ethers.id("primary-read-test-feed");
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target);
    const Shepherd = await ethers.getContractFactory("TellorShepherdHarness");
    const shepherd = await Shepherd.deploy(queryId, bank.target, admin.address, delay, 120, 300, 30000, 2000, [30, 90]);
    await shepherd.waitForDeployment();
    await shepherd.setModeForTest(1);
    return { deployer, admin, queryId, validatorSet, bank, Shepherd, shepherd };
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
    const replacement = await Bank.deploy(await f.bank.dataBridge());
    const original = await relay(f, encode(100));
    const updated = await relay({ ...f, bank: replacement }, encode(200));
    await time.increaseTo(updated.relayTime + delay + 1);
    await f.shepherd.connect(f.admin).proposeDataBankChange(replacement.target);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, original.aggregateTimestamp]);
    await f.shepherd.connect(f.admin).pause();
    const pausedAt = await f.shepherd.pausedAt();
    await time.setNextBlockTimestamp(Number(await f.shepherd.dataBankProposedAt()) + 300);
    await expect(f.shepherd.connect(f.admin).executeDataBankChange())
      .to.emit(f.shepherd, "DataBankChanged").withArgs(f.bank.target, replacement.target);
    expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
    expect(await f.shepherd.mode()).to.equal(1);
    expect(await f.shepherd.queryId()).to.equal(f.queryId);
    expect(await f.shepherd.pendingDataBank()).to.equal(ethers.ZeroAddress);
    expect(await f.shepherd.dataBankProposedAt()).to.equal(0);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
    await f.shepherd.connect(f.admin).unpause();
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([200n, updated.aggregateTimestamp]);
    await expect(f.shepherd.connect(f.admin).executeDataBankChange())
      .to.be.revertedWithCustomError(f.shepherd, "NoPendingDataBankChange");
  });

  it("rejects an empty history", async function () {
    const { shepherd } = await loadFixture(deployReadFixture);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "NoMatureData");
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
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoMatureData");
    await time.increaseTo(record.relayTime + delay);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoMatureData");
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
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoMatureData");
  });

  for (const length of [0, 1, 31]) {
    it(`rejects a ${length}-byte selected payload without using an older valid record`, async function () {
      const f = await loadFixture(deployReadFixture);
      await relay(f, encode(100));
      await time.increase(10);
      await injectLookupPayload(f, "0x" + "ab".repeat(length));
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "InvalidValueLength");
    });
  }

  for (const suffix of ["", "ff", "ab".repeat(32)]) {
    it(`rejects a zero first word with ${suffix.length / 2} trailing bytes`, async function () {
      const f = await loadFixture(deployReadFixture);
      await relay(f, encode(100));
      await time.increase(10);
      await injectLookupPayload(f, encode(0) + suffix);
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ZeroValue");
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
    const shepherd = await f.Shepherd.deploy(f.queryId, incompatible.target, f.admin.address, delay, 120, 300, 30000, 2000, [30, 90]);
    await shepherd.setModeForTest(1);
    await expect(shepherd.getCurrentValue()).to.be.reverted;
  });

  it("uses checked subtraction for underflow and reports no data at a zero cutoff", async function () {
    const f = await loadFixture(deployReadFixture);
    const futureDelay = (await time.latest()) + 100;
    const shepherd = await f.Shepherd.deploy(f.queryId, f.bank.target, f.admin.address, futureDelay, 120, 300, 30000, 2000, [30, 90]);
    await shepherd.setModeForTest(1);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithPanic(0x11);
    await time.increaseTo(futureDelay);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "NoMatureData");
    await time.increaseTo(futureDelay + 1);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "NoMatureData");
  });
});
