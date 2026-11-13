const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

describe("TellorTwapSource", function () {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encode = (value) => coder.encode(["uint256"], [value]);
  const queryId = ethers.id("twap-source-feed");
  const delay = 60;
  const windowMs = 30000;

  async function fixture() {
    const [admin] = await ethers.getSigners();
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const bridge = await (await ethers.getContractFactory("TellorDataBridge"))
      .deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const bank = await (await ethers.getContractFactory("TellorDataBank")).deploy(bridge.target, 43200, 600, 86400);
    const Source = await ethers.getContractFactory("TellorTwapSource");
    const source = await Source.deploy(bank.target, queryId, 8, delay, windowMs);
    const startTime = (await time.latest() - 10800) * 1000 + 17;
    return { admin, validatorSet, bank, Source, source, startTime };
  }

  async function append(f, offsetMs, price, reportQueryId = queryId) {
    const report = await h.prepareOracleData(reportQueryId, encode(price), f.validatorSet, {
      aggregateTimestamp: f.startTime + offsetMs,
      attestationTimestamp: (await time.latest()) * 1000,
    });
    await f.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    return (await f.bank.getCurrentAggregateData(reportQueryId)).relayTimestamp;
  }

  describe("real DataBank and bridge", function () {
    it("binds immutable configuration and allows deployment before history exists", async function () {
      const f = await loadFixture(fixture);
      expect(await f.source.dataBank()).to.equal(f.bank.target);
      expect(await f.source.queryId()).to.equal(queryId);
      expect(await f.source.decimals()).to.equal(8);
      expect(await f.source.RELAY_READ_DELAY()).to.equal(delay);
      expect(await f.source.TWAP_WINDOW_MS()).to.equal(windowMs);
      await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "NoTwapData");
    });

    it("rejects invalid configuration and accepts precision endpoints", async function () {
      const f = await loadFixture(fixture);
      const args = [f.bank.target, queryId, 8, delay, windowMs];
      for (const [index, value, error] of [
        [0, ethers.ZeroAddress, "DataBankHasNoCode"],
        [0, f.admin.address, "DataBankHasNoCode"],
        [1, ethers.ZeroHash, "InvalidQueryId"],
        [2, 78, "InvalidDecimals"],
        [2, 255, "InvalidDecimals"],
        [3, 0, "InvalidRelayReadDelay"],
        [4, 0, "InvalidTwapWindow"],
      ]) {
        const invalid = [...args];
        invalid[index] = value;
        await expect(f.Source.deploy(...invalid)).to.be.revertedWithCustomError(f.Source, error);
      }
      await append(f, 0, 123456789);
      const endRelay = await append(f, windowMs, 900);
      await time.increaseTo(endRelay + 61n);
      for (const decimals of [0, 77]) {
        const source = await f.Source.deploy(f.bank.target, queryId, decimals, delay, windowMs);
        expect(await source.decimals()).to.equal(decimals);
        // Declaring precision never rescales the raw stored price.
        expect(await source.getCurrentValue()).to.deep.equal([123456789n, BigInt(f.startTime + windowMs)]);
      }
    });

    it("requires two records and excludes the exact relay cutoff before admitting the minimal interval", async function () {
      const f = await loadFixture(fixture);
      const firstRelay = await append(f, 0, 100);
      await time.increaseTo(firstRelay + 61n);
      await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "NoTwapData");
      const endRelay = await append(f, windowMs, 900);
      for (const elapsed of [59n, 60n]) {
        await time.increaseTo(endRelay + elapsed);
        await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "NoTwapData");
      }
      await time.increaseTo(endRelay + 61n);
      // Only the first price carries weight, despite the endpoint's much higher price.
      expect(await f.source.getCurrentValue()).to.deep.equal([100n, BigInt(f.startTime + windowMs)]);
    });

    it("refuses insufficient coverage despite an available spot report", async function () {
      const f = await loadFixture(fixture);
      await append(f, 0, 100);
      const endRelay = await append(f, windowMs - 1, 900);
      await time.increaseTo(endRelay + 61n);
      expect((await f.bank.getCurrentAggregateData(queryId)).value).to.equal(encode(900));
      await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "NoTwapData");
      const hugeWindow = await f.Source.deploy(f.bank.target, queryId, 8, delay, ethers.MaxUint256);
      await expect(hugeWindow.getCurrentValue()).to.be.revertedWithCustomError(hugeWindow, "NoTwapData");
    });

    it("preserves the floored wider-interval average and excludes endpoint and immature prices", async function () {
      const f = await loadFixture(fixture);
      await append(f, 0, 101);
      await append(f, 7001, 127);
      const endRelay = await append(f, 33003, 900);
      await time.increaseTo(endRelay + 61n);
      await append(f, 40000, (1n << 192n) - 1n);
      // Minimum 30000ms selects start 0, since 7001 > 33003 - 30000.
      // (101 * 7001 + 127 * 26002) / 33003 = 121 + 15992/33003.
      const expected = [121n, BigInt(f.startTime + 33003)];
      expect(await f.source.getCurrentValue()).to.deep.equal(expected);
      // At exact maturity of the newest relay, the prior endpoint still wins.
      const latest = await f.bank.getCurrentAggregateData(queryId);
      await time.increaseTo(latest.relayTimestamp + 60n);
      expect(await f.source.getCurrentValue()).to.deep.equal(expected);
    });

    it("isolates query history", async function () {
      const f = await loadFixture(fixture);
      const otherQueryId = ethers.id("other-twap-source-feed");
      await append(f, 0, 444, otherQueryId);
      const endRelay = await append(f, windowMs, 999, otherQueryId);
      await time.increaseTo(endRelay + 61n);
      await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "NoTwapData");
      const other = await f.Source.deploy(f.bank.target, otherQueryId, 8, delay, windowMs);
      expect(await other.getCurrentValue()).to.deep.equal([444n, BigInt(f.startTime + windowMs)]);
    });

    it("reports unavailable data when chain time cannot accommodate the delay", async function () {
      const f = await loadFixture(fixture);
      const futureDelay = (await time.latest()) + 100;
      const source = await f.Source.deploy(f.bank.target, queryId, 8, futureDelay, windowMs);
      await expect(source.getCurrentValue()).to.be.revertedWithCustomError(source, "NoTwapData");
      await time.increaseTo(futureDelay);
      await expect(source.getCurrentValue()).to.be.revertedWithCustomError(source, "NoTwapData");
      await time.increaseTo(futureDelay + 1);
      await expect(source.getCurrentValue()).to.be.revertedWithCustomError(source, "NoTwapData");
    });

    it("accepts an old contributing price held for hours and never renews the endpoint timestamp", async function () {
      const f = await loadFixture(fixture);
      await append(f, 0, 100);
      // A recent endpoint closes an interval whose sole contributing price is three hours old.
      const endpointMs = (await time.latest() - 2) * 1000 + 123;
      const endRelay = await append(f, endpointMs - f.startTime, 900);
      await time.increaseTo(endRelay + 61n);
      const expected = [100n, BigInt(endpointMs)];
      expect(await f.source.getCurrentValue()).to.deep.equal(expected);
      await time.increase(7 * 86400);
      expect(await f.source.getCurrentValue()).to.deep.equal(expected);
    });
  });

  describe("injected dependency faults (existing TwapDataBankMock)", function () {
    async function faultFixture() {
      const bank = await (await ethers.getContractFactory("TwapDataBankMock")).deploy();
      const Source = await ethers.getContractFactory("TellorTwapSource");
      const source = await Source.deploy(bank.target, queryId, 8, delay, windowMs);
      const startMs = BigInt(await time.latest() - 300) * 1000n + 17n;
      const start = [encode(100), 1n, startMs, startMs, 1n];
      const end = [encode(900), 1n, startMs + 30000n, startMs + 30000n, 2n];
      const twap = [100n, 0n, 1n, start[2], end[2], 1n];
      await bank.configureRecord(0, start);
      await bank.configureRecord(1, end);
      await bank.configureEnd(true, end);
      await bank.configureCandidate(end);
      await bank.configureTwap(true, twap, 0);
      return { bank, source, start, end, twap };
    }

    it("refuses unavailable TWAP payloads even when spot is available", async function () {
      const f = await loadFixture(faultFixture);
      expect(await f.source.getCurrentValue()).to.deep.equal([100n, f.end[2]]);
      await f.bank.configureTwap(false, f.twap, 0);
      expect((await f.bank.getCurrentAggregateData(queryId)).value).to.equal(encode(900));
      await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "NoTwapData");
    });

    for (const [label, mutate] of [
      ["zero price", (t) => { t[0] = 0n; }],
      ["equal indices", (t) => { t[1] = t[2]; }],
      ["reversed indices", (t) => { t[1] = t[2] + 1n; }],
      ["equal timestamps", (t) => { t[3] = t[4]; }],
      ["reversed timestamps", (t) => { t[3] = t[4] + 1n; }],
      ["zero contributor count", (t) => { t[5] = 0n; }],
      ["incorrect contributor count", (t) => { t[5] = 2n; }],
      ["duration one millisecond too short", (t) => { t[3] += 1n; }],
      ["start timestamp inconsistent with indexed history", (t) => { t[3] -= 1n; }],
      ["end timestamp inconsistent with indexed history", (t) => { t[4] += 1n; }],
      ["missing indexed endpoint", (t) => { t[2] = 2n; t[5] = 2n; }],
    ]) {
      it(`refuses ${label}`, async function () {
        const f = await loadFixture(faultFixture);
        const twap = [...f.twap];
        mutate(twap);
        await f.bank.configureTwap(true, twap, 0);
        await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "InvalidTwapReference");
      });
    }

    it("requires a selected mature endpoint with matching aggregate and relay timestamps", async function () {
      const f = await loadFixture(faultFixture);
      for (const [found, selected] of [
        [false, f.end],
        [true, f.start],
        [true, [...f.end.slice(0, 4), 3n]],
      ]) {
        await f.bank.configureEnd(found, selected);
        await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "InvalidTwapReference");
      }
    });

    for (const offset of [0, 1]) {
      it(`refuses an endpoint relayed ${offset === 0 ? "at" : "after"} the strict cutoff`, async function () {
        const f = await loadFixture(faultFixture);
        const readTime = (await time.latest()) + 10;
        const end = [...f.end.slice(0, 4), BigInt(readTime - delay + offset)];
        await f.bank.configureRecord(1, end);
        await f.bank.configureEnd(true, end);
        await time.increaseTo(readTime);
        await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "InvalidTwapReference");
      });
    }

    for (const offsetMs of [null, 0, 1, 1000]) {
      it(`${offsetMs === 0 ? "accepts current" : "refuses " + (offsetMs === null ? "zero" : `${offsetMs}ms future`)} endpoint time`, async function () {
        const f = await loadFixture(faultFixture);
        const readTime = (await time.latest()) + 10;
        const endMs = offsetMs === null ? 0n : BigInt(readTime * 1000 + offsetMs);
        const startMs = endMs === 0n ? 0n : endMs - 30000n;
        const start = [...f.start];
        const end = [...f.end];
        start[2] = startMs;
        end[2] = endMs;
        await f.bank.configureRecord(0, start);
        await f.bank.configureRecord(1, end);
        await f.bank.configureEnd(true, end);
        await f.bank.configureTwap(true, [100n, 0n, 1n, startMs, endMs, 1n], 0);
        await time.increaseTo(readTime);
        if (offsetMs === 0) {
          expect(await f.source.getCurrentValue()).to.deep.equal([100n, endMs]);
        } else {
          await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.source, "InvalidTimestamp");
        }
      });
    }

    it("propagates TWAP dependency errors and refuses malformed ABI responses", async function () {
      const f = await loadFixture(faultFixture);
      await f.bank.configureTwap(true, f.twap, 1);
      await expect(f.source.getCurrentValue()).to.be.revertedWithCustomError(f.bank, "TwapUnavailable");
      await f.bank.configureTwap(true, f.twap, 2);
      await expect(f.source.getCurrentValue()).to.be.reverted;
    });
  });
});
