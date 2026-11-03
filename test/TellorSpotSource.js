const { loadFixture, setCode, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

describe("TellorSpotSource", function () {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encode = (value) => coder.encode(["uint256"], [value]);
  const queryId = ethers.id("spot-source-feed");
  const delay = 60;

  async function fixture() {
    const [admin] = await ethers.getSigners();
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const bridge = await (await ethers.getContractFactory("TellorDataBridge"))
      .deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const bank = await (await ethers.getContractFactory("TellorDataBank")).deploy(bridge.target);
    const Source = await ethers.getContractFactory("TellorSpotSource");
    const latest = await Source.deploy(bank.target, queryId, 8, 0);
    const delayed = await Source.deploy(bank.target, queryId, 8, delay);
    return { admin, validatorSet, bank, Source, latest, delayed };
  }

  async function relay(f, payload, overrides = {}, reportQueryId = queryId) {
    const report = await h.prepareOracleData(reportQueryId, payload, f.validatorSet, overrides);
    const tx = await f.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    return { relayTime: block.timestamp, timestampMs: BigInt(report.attestData.report.timestamp) };
  }

  describe("real DataBank and bridge", function () {
    it("binds configuration and permits deployment before history exists", async function () {
      const f = await loadFixture(fixture);
      expect(await f.delayed.dataBank()).to.equal(f.bank.target);
      expect(await f.delayed.queryId()).to.equal(queryId);
      expect(await f.delayed.decimals()).to.equal(8);
      expect(await f.delayed.RELAY_READ_DELAY()).to.equal(delay);
      expect(await f.latest.RELAY_READ_DELAY()).to.equal(0);
      await expect(f.latest.getCurrentValue()).to.be.revertedWithCustomError(f.latest, "NoData");
      await expect(f.delayed.getCurrentValue()).to.be.revertedWithCustomError(f.delayed, "NoData");
      const record = await relay(f, encode(123456789));
      await time.increaseTo(record.relayTime + delay + 1);
      for (const source of [f.latest, f.delayed]) {
        expect(await source.getCurrentValue()).to.deep.equal([123456789n, record.timestampMs]);
      }
    });

    it("rejects invalid configuration and accepts precision endpoints", async function () {
      const f = await loadFixture(fixture);
      for (const address of [ethers.ZeroAddress, f.admin.address]) {
        await expect(f.Source.deploy(address, queryId, 8, delay))
          .to.be.revertedWithCustomError(f.Source, "DataBankHasNoCode");
      }
      await expect(f.Source.deploy(f.bank.target, ethers.ZeroHash, 8, delay))
        .to.be.revertedWithCustomError(f.Source, "InvalidQueryId");
      for (const decimals of [78, 255]) {
        await expect(f.Source.deploy(f.bank.target, queryId, decimals, delay))
          .to.be.revertedWithCustomError(f.Source, "InvalidDecimals");
      }
      const record = await relay(f, encode(123));
      for (const decimals of [0, 77]) {
        const source = await f.Source.deploy(f.bank.target, queryId, decimals, 0);
        expect(await source.decimals()).to.equal(decimals);
        // The declaration never rescales the stored integer.
        expect(await source.getCurrentValue()).to.deep.equal([123n, record.timestampMs]);
      }
    });

    it("reads the newest report in its relay block when delay is zero", async function () {
      const f = await loadFixture(fixture);
      await relay(f, encode(100));
      const timestampMs = (await time.latest() - 1) * 1000 + 123;
      const record = await relay(f, encode(250), { aggregateTimestamp: timestampMs });
      expect(await time.latest()).to.equal(record.relayTime);
      expect(await f.latest.getCurrentValue()).to.deep.equal([250n, BigInt(timestampMs)]);
      await time.increase(30);
      expect(await f.latest.getCurrentValue()).to.deep.equal([250n, BigInt(timestampMs)]);
    });

    it("excludes the exact strict cutoff and includes the report one second later", async function () {
      const f = await loadFixture(fixture);
      const observation = (await time.latest() - 300) * 1000 + 123;
      const first = await relay(f, encode(100), {
        aggregateTimestamp: observation,
        attestationTimestamp: (await time.latest()) * 1000,
      });
      for (const elapsed of [delay - 1, delay]) {
        await time.increaseTo(first.relayTime + elapsed);
        await expect(f.delayed.getCurrentValue()).to.be.revertedWithCustomError(f.delayed, "NoData");
      }
      await time.increaseTo(first.relayTime + delay + 1);
      expect(await f.delayed.getCurrentValue()).to.deep.equal([100n, BigInt(observation)]);
      const second = await relay(f, encode(200));
      const third = await relay(f, encode(300));
      await time.increaseTo(third.relayTime + delay);
      expect(await f.delayed.getCurrentValue()).to.deep.equal([200n, second.timestampMs]);
      await time.increaseTo(third.relayTime + delay + 1);
      expect(await f.delayed.getCurrentValue()).to.deep.equal([300n, third.timestampMs]);
    });

    it("does not consume another feed's history", async function () {
      const f = await loadFixture(fixture);
      const record = await relay(f, encode(100), {}, ethers.id("other-feed"));
      await time.increaseTo(record.relayTime + delay + 1);
      for (const source of [f.latest, f.delayed]) {
        await expect(source.getCurrentValue()).to.be.revertedWithCustomError(source, "NoData");
      }
    });

    it("reports no data when chain time cannot accommodate the delay", async function () {
      const f = await loadFixture(fixture);
      const futureDelay = (await time.latest()) + 100;
      const source = await f.Source.deploy(f.bank.target, queryId, 8, futureDelay);
      await expect(source.getCurrentValue()).to.be.revertedWithCustomError(source, "NoData");
      await time.increaseTo(futureDelay);
      await expect(source.getCurrentValue()).to.be.revertedWithCustomError(source, "NoData");
      await time.increaseTo(futureDelay + 1);
      await expect(source.getCurrentValue()).to.be.revertedWithCustomError(source, "NoData");
    });

    it("accepts trailing bytes and keeps serving an unchanged observation without an age policy", async function () {
      const f = await loadFixture(fixture);
      const record = await relay(f, encode(123456789) + "abcd");
      await time.increase(2 * 86400);
      for (const source of [f.latest, f.delayed]) {
        expect(await source.getCurrentValue()).to.deep.equal([123456789n, record.timestampMs]);
      }
    });

    it("rejects a subsecond future timestamp admitted by the bank's flooring", async function () {
      const f = await loadFixture(fixture);
      const relayTime = (await time.latest()) + 10;
      const timestampMs = relayTime * 1000 + 1;
      await time.setNextBlockTimestamp(relayTime);
      await relay(f, encode(100), { aggregateTimestamp: timestampMs, attestationTimestamp: timestampMs });
      expect((await f.bank.getCurrentAggregateData(queryId)).aggregateTimestamp).to.equal(timestampMs);
      await expect(f.latest.getCurrentValue()).to.be.revertedWithCustomError(f.latest, "InvalidTimestamp");
      await time.increase(1);
      expect(await f.latest.getCurrentValue()).to.deep.equal([100n, BigInt(timestampMs)]);
    });
  });

  describe("injected dependency faults (existing TwapDataBankMock)", function () {
    async function faultFixture() {
      const bank = await (await ethers.getContractFactory("TwapDataBankMock")).deploy();
      const Source = await ethers.getContractFactory("TellorSpotSource");
      const latest = await Source.deploy(bank.target, queryId, 8, 0);
      const delayed = await Source.deploy(bank.target, queryId, 8, delay);
      return { bank, latest, delayed };
    }

    async function configure(f, payload, timestampMs) {
      const record = [payload, 1, timestampMs, timestampMs, 1];
      await f.bank.configureCandidate(record);
      await f.bank.configureEnd(true, record);
    }

    for (const length of [0, 1, 31]) {
      it(`refuses a selected ${length}-byte payload`, async function () {
        const f = await loadFixture(faultFixture);
        await configure(f, "0x" + "ab".repeat(length), (await time.latest()) * 1000);
        await expect(f.latest.getCurrentValue())
          .to.be.revertedWithCustomError(f.latest, length === 0 ? "NoData" : "InvalidValueLength");
        await expect(f.delayed.getCurrentValue()).to.be.revertedWithCustomError(f.delayed, "InvalidValueLength");
      });
    }

    it("rejects a zero first word even with trailing bytes", async function () {
      const f = await loadFixture(faultFixture);
      await configure(f, encode(0) + "abcd", (await time.latest()) * 1000);
      for (const source of [f.latest, f.delayed]) {
        await expect(source.getCurrentValue()).to.be.revertedWithCustomError(source, "ZeroValue");
      }
    });

    it("accepts the full uint256 first word and ignores trailing bytes", async function () {
      const f = await loadFixture(faultFixture);
      const timestampMs = BigInt(await time.latest()) * 1000n;
      await configure(f, encode(ethers.MaxUint256) + "ff", timestampMs);
      for (const source of [f.latest, f.delayed]) {
        expect(await source.getCurrentValue()).to.deep.equal([ethers.MaxUint256, timestampMs]);
      }
    });

    for (const offsetMs of [null, 1, 1000]) {
      it(`rejects ${offsetMs === null ? "zero" : `${offsetMs}ms future`} timestamps on both paths`, async function () {
        const f = await loadFixture(faultFixture);
        const readTime = (await time.latest()) + 10;
        const timestampMs = offsetMs === null ? 0 : readTime * 1000 + offsetMs;
        await configure(f, encode(100), timestampMs);
        await time.increaseTo(readTime);
        for (const source of [f.latest, f.delayed]) {
          await expect(source.getCurrentValue()).to.be.revertedWithCustomError(source, "InvalidTimestamp");
        }
      });
    }

    it("accepts a timestamp exactly equal to current block time in milliseconds", async function () {
      const f = await loadFixture(faultFixture);
      const readTime = (await time.latest()) + 10;
      await configure(f, encode(100), readTime * 1000);
      await time.increaseTo(readTime);
      for (const source of [f.latest, f.delayed]) {
        expect(await source.getCurrentValue()).to.deep.equal([100n, BigInt(readTime) * 1000n]);
      }
    });

    it("propagates dependency reverts on both paths", async function () {
      const f = await loadFixture(faultFixture);
      await configure(f, encode(100), (await time.latest()) * 1000);
      // Replace only the test dependency with PUSH1 0, PUSH1 0, REVERT.
      await setCode(f.bank.target, "0x60006000fd");
      for (const source of [f.latest, f.delayed]) {
        await expect(source.getCurrentValue()).to.be.revertedWithoutReason();
      }
    });
  });
});
