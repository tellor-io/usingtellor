const {
  time,
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

describe("TellorDataBank - Function Tests", function () {
  // Test data for ETH/USD price queries
  const abiCoder = new ethers.AbiCoder();
  const ETH_USD_QUERY_DATA_ARGS = abiCoder.encode(["string", "string"], ["eth", "usd"]);
  const ETH_USD_QUERY_DATA = abiCoder.encode(["string", "bytes"], ["SpotPrice", ETH_USD_QUERY_DATA_ARGS]);
  const ETH_USD_QUERY_ID = h.hash(ETH_USD_QUERY_DATA);

  // constants for testing
  const TELLOR_CHAIN_ID = "tellor-1";
  const UNBONDING_PERIOD = 86400 * 7 * 3; // 3 weeks
  const MAX_DATA_AGE = 24 * 60 * 60; // 24 hours
  const MAX_ATTESTATION_AGE = 10 * 60; // 10 minutes
  const OPTIMISTIC_DELAY = 12 * 60 * 60; // 12 hours
  const MS_PER_SECOND = 1000;

  async function deployTellorDataBankFixture() {
    const [deployer, admin] = await ethers.getSigners();

    const validatorSet = await h.createTellorValset({ tellorChainId: TELLOR_CHAIN_ID });

    const TellorDataBridge = await ethers.getContractFactory("TellorDataBridge");
    const dataBridge = await TellorDataBridge.deploy(admin.address, validatorSet.domainSeparator);
    await dataBridge.init(validatorSet.powerThreshold, validatorSet.timestamp, UNBONDING_PERIOD, validatorSet.checkpoint);

    const TellorDataBank = await ethers.getContractFactory("TellorDataBank");
    const tellorDataBank = await TellorDataBank.deploy(dataBridge.target);
    await tellorDataBank.waitForDeployment();

    return {
      dataBridge,
      tellorDataBank,
      deployer,
      admin,
      validatorSet,
      threshold: validatorSet.powerThreshold,
    };
  }

  describe("Deployment", function () {
    it("Should set deployment variables correctly", async function () {
      const { tellorDataBank, dataBridge } = await loadFixture(deployTellorDataBankFixture);
      expect(await tellorDataBank.dataBridge()).to.equal(dataBridge.target);
      expect(await tellorDataBank.MAX_DATA_AGE()).to.equal(MAX_DATA_AGE);
      expect(await tellorDataBank.MAX_ATTESTATION_AGE()).to.equal(MAX_ATTESTATION_AGE);
      expect(await tellorDataBank.OPTIMISTIC_DELAY()).to.equal(OPTIMISTIC_DELAY);
      expect(await tellorDataBank.MS_PER_SECOND()).to.equal(MS_PER_SECOND);
    });
  });

  describe("TWAP interface", function () {
    it("returns an empty unavailable response through the interface when history is missing", async function () {
      const { tellorDataBank } = await loadFixture(deployTellorDataBankFixture);
      const bankInterface = await ethers.getContractAt("ITellorDataBank", tellorDataBank.target);
      expect(await bankInterface.getTwapBefore(ETH_USD_QUERY_ID, await time.latest(), 30 * 60 * 1000))
        .to.deep.equal([false, [0n, 0n, 0n, 0n, 0n, 0n]]);
    });
  });

  describe("Cumulative price history", function () {
    const maxPrice = (1n << 192n) - 1n;
    const maxTimestamp = (1n << 64n) - 1n;
    const encode = (value) => abiCoder.encode(["uint256"], [value]);

    async function reportFor(validatorSet, queryId, value, timestamp, overrides = {}) {
      return h.prepareOracleData(queryId, value, validatorSet, {
        aggregateTimestamp: timestamp,
        attestationTimestamp: (await time.latest()) * 1000,
        ...overrides,
      });
    }

    async function relay(bank, report) {
      return bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    }

    it("weights irregular aggregate intervals, isolates feeds, and excludes endpoint prices", async function () {
      const { tellorDataBank: bank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
      const firstTime = (await time.latest() - 100) * 1000;
      const secondFeed = ethers.id("independent-accumulator");
      for (const [queryId, endpointPrice] of [[ETH_USD_QUERY_ID, 900n], [secondFeed, maxPrice]]) {
        for (const [offset, price] of [[0, 100n], [10001, 120n], [30003, endpointPrice]]) {
          // Intentionally mismatched predecessor: stored history alone defines the intervals.
          const report = await reportFor(validatorSet, queryId, encode(price), firstTime + offset,
            { previousTimestamp: firstTime - 1 });
          await relay(bank, report);
        }
        expect(await bank.getAggregateValueCount(queryId)).to.equal(3);
        expect(await bank.cumulativePrice(queryId, 0)).to.equal(0);
        expect(await bank.cumulativePrice(queryId, 1)).to.equal(1000100);
        expect(await bank.cumulativePrice(queryId, 2)).to.equal(3400340);
        await expect(bank.cumulativePrice(queryId, 3)).to.be.reverted;
      }
      // The second interval alone contributes 120 * 20002, regardless of endpoint price.
      expect((await bank.cumulativePrice(secondFeed, 2)) - (await bank.cumulativePrice(secondFeed, 1)))
        .to.equal(2400240);
      const unknownFeed = ethers.id("no-accumulator");
      expect(await bank.getAggregateValueCount(unknownFeed)).to.equal(0);
      await expect(bank.cumulativePrice(unknownFeed, 0)).to.be.reverted;
    });

    it("accepts the maximum price, weights it on the next relay, and accepts trailing bytes", async function () {
      const { tellorDataBank: bank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
      const start = (await time.latest() - 100) * 1000;
      const payload = ethers.concat([encode(maxPrice), "0x1234"]);
      await relay(bank, await reportFor(validatorSet, ETH_USD_QUERY_ID, payload, start));
      await relay(bank, await reportFor(validatorSet, ETH_USD_QUERY_ID, encode(1), start + 10001));
      await relay(bank, await reportFor(validatorSet, ETH_USD_QUERY_ID, encode(7), start + 10003));
      expect((await bank.getAggregateByIndex(ETH_USD_QUERY_ID, 0)).value).to.equal(payload);
      expect(await bank.cumulativePrice(ETH_USD_QUERY_ID, 2)).to.equal(maxPrice * 10001n + 2n);
    });

    it("accepts the exact aggregate timestamp ceiling and accumulates through it", async function () {
      const { tellorDataBank: bank, dataBridge, validatorSet } = await loadFixture(deployTellorDataBankFixture);
      const report = await reportFor(validatorSet, ETH_USD_QUERY_ID, encode(maxPrice),
        (await time.latest() - 100) * 1000);
      // Isolate numeric admission at a far-future timestamp without requiring a future validator set.
      // All ordinary accumulator tests above exercise real bridge signatures.
      await network.provider.send("hardhat_setCode", [dataBridge.target, "0x00"]);
      await network.provider.send("evm_setNextBlockTimestamp", ["0x" + (maxTimestamp / 1000n).toString(16)]);
      report.attestData.report.timestamp = maxTimestamp - 1000n;
      report.attestData.report.lastConsensusTimestamp = maxTimestamp - 1000n;
      report.attestData.attestationTimestamp = maxTimestamp - 1000n;
      await relay(bank, report);
      report.attestData.report.timestamp = maxTimestamp;
      report.attestData.report.lastConsensusTimestamp = maxTimestamp;
      report.attestData.attestationTimestamp = maxTimestamp;
      await relay(bank, report);
      expect((await bank.getAggregateByIndex(ETH_USD_QUERY_ID, 1)).aggregateTimestamp).to.equal(maxTimestamp);
      expect(await bank.cumulativePrice(ETH_USD_QUERY_ID, 1)).to.equal(maxPrice * 1000n);
    });

    it("rejects invalid admission domains without appending either history, then permits a valid relay", async function () {
      const { tellorDataBank: bank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
      const start = (await time.latest() - 100) * 1000;
      for (const count of [0, 1]) {
        const cases = [
          ["0x", "InvalidPriceLength"],
          ["0x" + "ff".repeat(31), "InvalidPriceLength"],
          [encode(0), "PriceOutOfRange"],
          [encode(maxPrice + 1n), "PriceOutOfRange"],
          [encode(ethers.MaxUint256), "PriceOutOfRange"],
        ];
        for (const [payload, error] of cases) {
          const report = await reportFor(validatorSet, ETH_USD_QUERY_ID, payload, start + count * 1000);
          await expect(relay(bank, report)).to.be.revertedWithCustomError(bank, error);
          expect(await bank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(count);
          await expect(bank.cumulativePrice(ETH_USD_QUERY_ID, count)).to.be.reverted;
        }
        const oversizedTime = await reportFor(validatorSet, ETH_USD_QUERY_ID, encode(100), start);
        oversizedTime.attestData.report.timestamp = maxTimestamp + 1n;
        await expect(relay(bank, oversizedTime)).to.be.revertedWithCustomError(bank, "AggregateTimestampOutOfRange");
        expect(await bank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(count);
        await expect(bank.cumulativePrice(ETH_USD_QUERY_ID, count)).to.be.reverted;
        await relay(bank, await reportFor(validatorSet, ETH_USD_QUERY_ID, encode(100), start + count * 1000));
      }
      expect(await bank.cumulativePrice(ETH_USD_QUERY_ID, 1)).to.equal(100000);
      expect(await bank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(2);
    });

    it("leaves both histories unchanged after failed authentication or ordering", async function () {
      const { tellorDataBank: bank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
      const start = (await time.latest() - 100) * 1000;
      await relay(bank, await reportFor(validatorSet, ETH_USD_QUERY_ID, encode(100), start));
      const unauthenticated = await reportFor(validatorSet, ETH_USD_QUERY_ID, encode(120), start + 1000);
      unauthenticated.attestData.report.value = encode(121);
      await expect(relay(bank, unauthenticated)).to.be.reverted;
      await expect(relay(bank, await reportFor(validatorSet, ETH_USD_QUERY_ID, encode(120), start)))
        .to.be.revertedWith("TellorDataBank: Report timestamp must increase");
      expect(await bank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
      expect(await bank.cumulativePrice(ETH_USD_QUERY_ID, 0)).to.equal(0);
      await expect(bank.cumulativePrice(ETH_USD_QUERY_ID, 1)).to.be.reverted;
      await relay(bank, await reportFor(validatorSet, ETH_USD_QUERY_ID, encode(120), start + 1000));
      expect(await bank.cumulativePrice(ETH_USD_QUERY_ID, 1)).to.equal(100000);
    });
  });

  describe("Internal TWAP interval lookup", function () {
    const emptyResult = [false, 0n, 0n, 0n];
    const maxPrice = (1n << 192n) - 1n;

    async function fixture() {
      const { dataBridge, validatorSet } = await deployTellorDataBankFixture();
      const Harness = await ethers.getContractFactory("TellorDataBankHarness");
      const bank = await Harness.deploy(dataBridge.target);
      const startTime = (await time.latest() - 100) * 1000 + 17;
      return { bank, validatorSet, startTime };
    }

    async function append(f, offset, price, queryId = ETH_USD_QUERY_ID) {
      const report = await h.prepareOracleData(queryId, abiCoder.encode(["uint256"], [price]), f.validatorSet, {
        aggregateTimestamp: f.startTime + offset,
        attestationTimestamp: (await time.latest()) * 1000,
        previousTimestamp: f.startTime - 1, // Deliberately not the previous stored timestamp.
      });
      await f.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
      return (await f.bank.getCurrentAggregateData(queryId)).relayTimestamp;
    }

    async function historyFixture() {
      const f = await fixture();
      const relays = [];
      for (const [offset, price] of [[0, 100], [10001, 120], [30003, 900]]) {
        relays.push(await append(f, offset, price));
      }
      return { ...f, relays };
    }

    it("rejects zero windows and distinguishes missing history from an average", async function () {
      const f = await loadFixture(fixture);
      await expect(f.bank.calculateTwapBefore(ETH_USD_QUERY_ID, 0, 0))
        .to.be.revertedWithCustomError(f.bank, "InvalidTwapWindow");
      expect(await f.bank.calculateTwapBefore(ETH_USD_QUERY_ID, ethers.MaxUint256, 1)).to.deep.equal(emptyResult);
      const relayTime = await append(f, 0, 100);
      for (const cutoff of [0n, relayTime, relayTime + 1n]) {
        expect(await f.bank.calculateTwapBefore(ETH_USD_QUERY_ID, cutoff, 1)).to.deep.equal(emptyResult);
      }
      await expect(f.bank.calculateTwapBefore(ETH_USD_QUERY_ID, relayTime + 1n, 0))
        .to.be.revertedWithCustomError(f.bank, "InvalidTwapWindow");
    });

    it("uses exclusive relay cutoffs and recomputes the start relative to the selected endpoint", async function () {
      const { bank, relays } = await loadFixture(historyFixture);
      expect(await bank.calculateTwapBefore(ETH_USD_QUERY_ID, relays[1], 1)).to.deep.equal(emptyResult);
      expect(await bank.calculateTwapBefore(ETH_USD_QUERY_ID, relays[2], 10001))
        .to.deep.equal([true, 0n, 1n, 100n]);
      expect(await bank.calculateTwapBefore(ETH_USD_QUERY_ID, relays[2] + 1n, 15000))
        .to.deep.equal([true, 1n, 2n, 120n]);
    });

    it("includes exact aggregate start boundaries, widens by a millisecond, and floors the full average", async function () {
      const { bank, relays } = await loadFixture(historyFixture);
      const cutoff = relays[2] + 1n;
      for (const minimum of [1, 15000, 20002]) {
        expect(await bank.calculateTwapBefore(ETH_USD_QUERY_ID, cutoff, minimum))
          .to.deep.equal([true, 1n, 2n, 120n]);
      }
      // Moving the target one millisecond before index 1 widens to index 0.
      // (100 * 10001 + 120 * 20002) / 30003 = 113 + 1/3, rounded down.
      for (const minimum of [20003, 25000, 30003]) {
        expect(await bank.calculateTwapBefore(ETH_USD_QUERY_ID, cutoff, minimum))
          .to.deep.equal([true, 0n, 2n, 113n]);
      }
    });

    it("returns an empty result for short history and underflow-sized targets without extrapolating", async function () {
      const { bank, relays, startTime } = await loadFixture(historyFixture);
      for (const minimum of [30004n, BigInt(startTime + 30003), BigInt(startTime + 30004), ethers.MaxUint256]) {
        expect(await bank.calculateTwapBefore(ETH_USD_QUERY_ID, relays[2] + 1n, minimum)).to.deep.equal(emptyResult);
      }
      expect(await bank.calculateTwapBefore(ETH_USD_QUERY_ID, ethers.MaxUint256, 30004)).to.deep.equal(emptyResult);
      expect(await bank.calculateTwapBefore(ETH_USD_QUERY_ID, ethers.MaxUint256, 30003))
        .to.deep.equal([true, 0n, 2n, 113n]);
    });

    it("excludes endpoint/newer prices and isolates each feed's cumulative history", async function () {
      const f = await loadFixture(historyFixture);
      const otherFeed = ethers.id("twap-other-feed");
      const last = await append(f, 40000, maxPrice);
      // Even a huge newly relayed price cannot change a reference ending before it.
      expect(await f.bank.calculateTwapBefore(ETH_USD_QUERY_ID, last, 30003))
        .to.deep.equal([true, 0n, 2n, 113n]);
      for (const [offset, price] of [[0, 100], [10001, 120], [30003, maxPrice]]) {
        await append(f, offset, price, otherFeed);
      }
      expect(await f.bank.calculateTwapBefore(otherFeed, ethers.MaxUint256, 30003))
        .to.deep.equal([true, 0n, 2n, 113n]);
      expect(await f.bank.calculateTwapBefore(ethers.id("empty-feed"), ethers.MaxUint256, 1)).to.deep.equal(emptyResult);
    });

    it("preserves the maximum supported price through subtraction and division", async function () {
      const f = await loadFixture(fixture);
      await append(f, 0, maxPrice);
      await append(f, 10001, maxPrice);
      await append(f, 30003, 1);
      expect(await f.bank.calculateTwapBefore(ETH_USD_QUERY_ID, ethers.MaxUint256, 30003))
        .to.deep.equal([true, 0n, 2n, maxPrice]);
      expect(await f.bank.calculateTwapBefore(ETH_USD_QUERY_ID, ethers.MaxUint256, 20002))
        .to.deep.equal([true, 1n, 2n, maxPrice]);
    });

    it("matches direct interval integration across every start boundary in a longer irregular history", async function () {
      const f = await loadFixture(fixture);
      const offsets = [0, 3, 17, 100, 211, 997, 1001, 4500, 9001];
      const prices = [91n, 117n, 3n, 600n, 44n, 89n, 17n, 203n, 999n];
      const relays = [];
      for (let i = 0; i < offsets.length; i++) relays.push(await append(f, offsets[i], prices[i]));
      for (let end = 1; end < offsets.length; end++) {
        for (let boundary = 0; boundary < end; boundary++) {
          for (const delta of [-1, 0, 1]) {
            const minimum = offsets[end] - offsets[boundary] + delta;
            const target = offsets[end] - minimum;
            const start = offsets.findLastIndex((offset) => offset <= target);
            let expected = emptyResult;
            if (start >= 0) {
              // Independent oracle: integrate individual intervals, without cumulative totals or binary search.
              let sum = 0n;
              for (let i = start; i < end; i++) sum += prices[i] * BigInt(offsets[i + 1] - offsets[i]);
              expected = [true, BigInt(start), BigInt(end), sum / BigInt(offsets[end] - offsets[start])];
            }
            expect(await f.bank.calculateTwapBefore(ETH_USD_QUERY_ID, relays[end] + 1n, minimum))
              .to.deep.equal(expected);
          }
        }
      }
    });

    it("describes the same interval through the public response", async function () {
      const { bank, relays, startTime } = await loadFixture(historyFixture);
      expect((await bank.calculateTwapBefore(ETH_USD_QUERY_ID, relays[2] + 1n, 15000))[0]).to.equal(true);
      expect(await bank.getTwapBefore(ETH_USD_QUERY_ID, relays[2] + 1n, 15000))
        .to.deep.equal([true, [120n, 1n, 2n, BigInt(startTime + 10001), BigInt(startTime + 30003), 1n]]);
    });
  });

  describe("Public TWAP response", function () {
    const emptyResponse = [false, [0n, 0n, 0n, 0n, 0n, 0n]];

    async function fixture() {
      const { tellorDataBank: bank, validatorSet } = await deployTellorDataBankFixture();
      const startTime = (await time.latest() - 2000) * 1000 + 17;
      return { bank, validatorSet, startTime };
    }

    async function append(f, offset, price, queryId = ETH_USD_QUERY_ID) {
      const report = await h.prepareOracleData(queryId, abiCoder.encode(["uint256"], [price]), f.validatorSet, {
        aggregateTimestamp: f.startTime + offset,
        attestationTimestamp: (await time.latest()) * 1000,
        previousTimestamp: f.startTime - 1, // Predecessor mismatches do not invalidate relayed-history TWAPs.
      });
      await f.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
      return (await f.bank.getCurrentAggregateData(queryId)).relayTimestamp;
    }

    it("reports exact wider-interval metadata and applies strict endpoint and inclusive start boundaries", async function () {
      const f = await loadFixture(fixture);
      const t = BigInt(f.startTime);
      const firstRelay = await append(f, 0, 100);
      await append(f, 10001, 120);
      const lastRelay = await append(f, 30003, 900);
      const bankInterface = await ethers.getContractAt("ITellorDataBank", f.bank.target);
      expect(await bankInterface.getTwapBefore(ETH_USD_QUERY_ID, firstRelay, 1)).to.deep.equal(emptyResponse);
      expect(await bankInterface.getTwapBefore(ETH_USD_QUERY_ID, lastRelay, 10001))
        .to.deep.equal([true, [100n, 0n, 1n, t, t + 10001n, 1n]]);
      for (const minimum of [1, 15000, 20002]) {
        expect(await bankInterface.getTwapBefore(ETH_USD_QUERY_ID, lastRelay + 1n, minimum))
          .to.deep.equal([true, [120n, 1n, 2n, t + 10001n, t + 30003n, 1n]]);
      }
      for (const minimum of [20003, 30003]) {
        expect(await bankInterface.getTwapBefore(ETH_USD_QUERY_ID, lastRelay + 1n, minimum))
          .to.deep.equal([true, [113n, 0n, 2n, t, t + 30003n, 2n]]);
      }
      await append(f, 40000, (1n << 192n) - 1n);
      expect(await bankInterface.getTwapBefore(ETH_USD_QUERY_ID, lastRelay + 1n, 30003))
        .to.deep.equal([true, [113n, 0n, 2n, t, t + 30003n, 2n]]);
    });

    it("returns wholly empty unavailable responses, rejects zero windows, and isolates feeds", async function () {
      const f = await loadFixture(fixture);
      await expect(f.bank.getTwapBefore(ETH_USD_QUERY_ID, 0, 0))
        .to.be.revertedWithCustomError(f.bank, "InvalidTwapWindow");
      const firstRelay = await append(f, 0, 100);
      expect(await f.bank.getTwapBefore(ETH_USD_QUERY_ID, firstRelay + 1n, 1)).to.deep.equal(emptyResponse);
      const lastRelay = await append(f, 10001, 200);
      for (const minimum of [10002n, BigInt(f.startTime + 10002), ethers.MaxUint256]) {
        expect(await f.bank.getTwapBefore(ETH_USD_QUERY_ID, lastRelay + 1n, minimum)).to.deep.equal(emptyResponse);
      }
      const otherFeed = ethers.id("public-twap-independent");
      expect(await f.bank.getTwapBefore(otherFeed, ethers.MaxUint256, 1)).to.deep.equal(emptyResponse);
      await append(f, 0, 777, otherFeed);
      await append(f, 10001, 1, otherFeed);
      expect(await f.bank.getTwapBefore(otherFeed, ethers.MaxUint256, 10001))
        .to.deep.equal([true, [777n, 0n, 1n, BigInt(f.startTime), BigInt(f.startTime + 10001), 1n]]);
      expect((await f.bank.getTwapBefore(ETH_USD_QUERY_ID, ethers.MaxUint256, 10001))[1].value).to.equal(100);
      await expect(f.bank.getTwapBefore(ETH_USD_QUERY_ID, lastRelay + 1n, 0))
        .to.be.revertedWithCustomError(f.bank, "InvalidTwapWindow");
    });

    it("returns a computable average even when one long-held price dominates a densely sampled interval", async function () {
      const f = await loadFixture(fixture);
      // Six short intervals at 10, then one 20-minute interval at 1000, then two short ones at 10.
      // Weighted sum = 8 * 1000 * 10 + 1200000 * 1000 = 1200080000.
      const offsets = [0, 1000, 2000, 3000, 4000, 5000, 6000, 1206000, 1207000, 1208000];
      for (let i = 0; i < offsets.length; i++) await append(f, offsets[i], i === 6 ? 1000 : 10);
      expect(await f.bank.getTwapBefore(ETH_USD_QUERY_ID, ethers.MaxUint256, 1208000))
        .to.deep.equal([true, [993n, 0n, 9n, BigInt(f.startTime), BigInt(f.startTime + 1208000), 9n]]);
    });
  });

  describe("Oracle Data Updates", function () {
    describe("updateOracleData", function () {
      it("Should successfully update oracle data with valid consensus data", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        // Mock ETH/USD price value
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);
        
        // Prepare oracle data
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet
        );
        
        // Update oracle data
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(ETH_USD_QUERY_ID, h.attestDataStructToArray(attestData));
        
        // Check that data was stored correctly
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        
        const aggData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 0);
        expect(aggData.aggregateTimestamp).to.equal(attestData.report.timestamp);
        
        expect(abiCoder.decode(["uint256"], aggData.value)[0]).to.equal(mockPrice);
        expect(aggData.power).to.equal(attestData.report.aggregatePower);
      });

      it("Should handle multiple oracle data updates with increasing timestamps", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice1 = h.toWei("2000");
        const mockPrice2 = h.toWei("2100");
        const mockValue1 = abiCoder.encode(["uint256"], [mockPrice1]);
        const mockValue2 = abiCoder.encode(["uint256"], [mockPrice2]);
        
        // First update
        let { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue1,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        
        // Wait some time before second update
        await time.increase(60);
        
        // Second update with newer timestamp
        ({ attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue2,
          validatorSet
        ));
        
        await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(2);
        
        // Check latest data
        const aggData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 1);
        expect(aggData.aggregateTimestamp).to.equal(attestData.report.timestamp);
        expect(abiCoder.decode(["uint256"], aggData.value)[0]).to.equal(mockPrice2);
        expect(aggData.power).to.equal(attestData.report.aggregatePower);
      });

      it("Should revert when data is too old", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        const mockValue = abiCoder.encode(["uint256"], [h.toWei("2000")]);
        
        // Create oracle data that's 25 hours old (past MAX_DATA_AGE of 24 hours)
        const blocky = await h.getBlock();
        const oldAggregateTimestamp = (blocky.timestamp - (25 * 3600)) * 1000; // 25 hours old in milliseconds
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: oldAggregateTimestamp,
            lastConsensusTimestamp: oldAggregateTimestamp, // Consensus data
            attestationTimestamp: oldAggregateTimestamp + 1000 // Slightly after aggregate
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Data too old");
      });

      it("Should revert when attestation is too old", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);
        
        // Create oracle data with attestation that's 15 minutes old (past MAX_ATTESTATION_AGE of 10 minutes)
        const blocky = await h.getBlock();
        const oldAttestationTimestamp = (blocky.timestamp - (15 * 60)) * 1000; // 15 minutes old in milliseconds
        // Since attestationTimestamp must be >= aggregateTimestamp, we need to make the aggregate timestamp even older
        const oldAggregateTimestamp = oldAttestationTimestamp - 1000;
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: oldAggregateTimestamp,
            attestationTimestamp: oldAttestationTimestamp,
            lastConsensusTimestamp: oldAggregateTimestamp // Consensus data
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Attestation too old");
      });

      it("Should revert when timestamp is not monotonically increasing", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice1 = h.toWei("2000");
        const mockPrice2 = h.toWei("2100");
        const mockValue1 = abiCoder.encode(["uint256"], [mockPrice1]);
        const mockValue2 = abiCoder.encode(["uint256"], [mockPrice2]);
        
        // First update with current timestamp
        let { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue1,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
        const firstTimestamp = attestData.report.timestamp;
        
        // Try to update with older timestamp
        const olderTimestamp = firstTimestamp - 10000; // 10 seconds earlier
        const { attestData: olderAttestData, currentValidatorSet: currentValidatorSet2, sigs: sigs2 } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue2,
          validatorSet,
          {
            aggregateTimestamp: olderTimestamp,
            lastConsensusTimestamp: olderTimestamp, // Consensus data
            attestationTimestamp: olderTimestamp + 1000
          }
        );
        
        // This should fail timestamp validation
        await expect(tellorDataBank.updateOracleData(olderAttestData, currentValidatorSet2, sigs2))
          .to.be.revertedWith("TellorDataBank: Report timestamp must increase");
      });

      it("Should successfully handle optimistic oracle data", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);
        
        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is 1 second ago
        const nextTimestamp = blocky.timestamp - 1;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1;


        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );
        
        // This should succeed if all optimistic data validation passes
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(ETH_USD_QUERY_ID, h.attestDataStructToArray(attestData));
        
        // Verify data was stored
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);

        const aggData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 0);
        expect(aggData.aggregateTimestamp).to.equal(attestData.report.timestamp);
        expect(abiCoder.decode(["uint256"], aggData.value)[0]).to.equal(mockPrice);
        expect(aggData.power).to.equal(attestData.report.aggregatePower);
      });

      it("Should revert with insufficient power for optimistic data", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);
        
        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is 1 second ago
        const nextTimestamp = blocky.timestamp - 1;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2
        const insufficientPower = threshold / 2; 

        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: insufficientPower
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Insufficient optimistic report power");
      });

      it("Should revert optimistic data when dispute period hasn't passed", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);

        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay - 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY + 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is 1 second ago
        const nextTimestamp = blocky.timestamp - 1;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1; 
        
        // Create optimistic data with insufficient delay (6 hours < 12 hour requirement)
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Dispute period not passed");
      });

      it("Should revert when more recent optimistic report is available", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);

        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is optimistic but later than aggregate timestamp
        const nextTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 1000;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1; 
        // Create data with nextTimestamp optimistic
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: More recent optimistic report available");
      });

      it("Should successfully handle consensus data vs optimistic data", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice1 = h.toWei("2000");
        const mockPrice2 = h.toWei("2100");
        const mockValue1 = abiCoder.encode(["uint256"], [mockPrice1]);
        const mockValue2 = abiCoder.encode(["uint256"], [mockPrice2]);
        
        // First, add consensus data
        const { attestData: consensusData, currentValidatorSet, sigs: consensusSigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue1,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(consensusData, currentValidatorSet, consensusSigs);
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        
        // Wait some time, then add optimistic data
        await time.increase(24 * 3600); // 24 hours

        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp hasn't passed optimistic delay
        const nextTimestamp = blocky.timestamp - OPTIMISTIC_DELAY + 3600;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1; 

        const { attestData: optimisticData, currentValidatorSet: optimisticCurrentValidatorSet, sigs: optimisticSigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue2,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );

        await tellorDataBank.updateOracleData(optimisticData, optimisticCurrentValidatorSet, optimisticSigs);
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(2);
        
        // Verify the latest data is the optimistic data
        const aggData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 1);
        expect(aggData.aggregateTimestamp).to.equal(optimisticData.report.timestamp);
        expect(abiCoder.decode(["uint256"], aggData.value)[0]).to.equal(mockPrice2);
        expect(aggData.power).to.equal(optimisticData.report.aggregatePower);
      });

      it("Should revert optimistic data when newer consensus data is available", async function () {
         const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockValue = abiCoder.encode(["uint256"], [h.toWei("2000")]);

        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is 1 second ago
        const nextTimestamp = blocky.timestamp - 1;
        // last consensus timestamp is after the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp + 1;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1; 
        
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Newer consensus data available");
      });

      // The one-relay-per-block rule is what makes relayTimestamp strictly increasing,
      // which is what lets getRelayBefore have a single unambiguous answer. Hardhat
      // automines one tx per block and bumps the timestamp a second each time, so these
      // are the only tests that can put two relays in the same block.
      it("Should revert a second relay evaluated at the same block timestamp", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);

        const first = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          abiCoder.encode(["uint256"], [h.toWei("2000")]),
          validatorSet
        );
        await tellorDataBank.updateOracleData(first.attestData, first.currentValidatorSet, first.sigs);

        const stored = await tellorDataBank.getCurrentAggregateData(ETH_USD_QUERY_ID);
        const blocky = await h.getBlock();
        expect(stored.relayTimestamp).to.equal(blocky.timestamp);

        // A newer aggregate timestamp, so the monotonicity check passes and the
        // block rule is the only thing left to reject it.
        const newerAggregateTimestamp = Number(stored.aggregateTimestamp) + 1000;
        const second = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          abiCoder.encode(["uint256"], [h.toWei("2100")]),
          validatorSet,
          {
            aggregateTimestamp: newerAggregateTimestamp,
            attestationTimestamp: newerAggregateTimestamp + 1000,
            lastConsensusTimestamp: newerAggregateTimestamp,
          }
        );

        await expect(
          tellorDataBank.updateOracleData.staticCall(
            second.attestData,
            second.currentValidatorSet,
            second.sigs
          )
        ).to.be.revertedWith("TellorDataBank: Only one relay per block");
      });

      it("Should reject the second of two relays mined in the same block", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);

        const blocky = await h.getBlock();
        const firstAggregateTimestamp = (blocky.timestamp - 2) * 1000;
        const secondAggregateTimestamp = firstAggregateTimestamp + 1000;

        const first = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          abiCoder.encode(["uint256"], [h.toWei("2000")]),
          validatorSet,
          {
            aggregateTimestamp: firstAggregateTimestamp,
            attestationTimestamp: firstAggregateTimestamp + 1000,
            lastConsensusTimestamp: firstAggregateTimestamp,
          }
        );
        const second = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          abiCoder.encode(["uint256"], [h.toWei("2100")]),
          validatorSet,
          {
            aggregateTimestamp: secondAggregateTimestamp,
            attestationTimestamp: secondAggregateTimestamp + 1000,
            lastConsensusTimestamp: secondAggregateTimestamp,
          }
        );

        await network.provider.send("evm_setAutomine", [false]);
        try {
          // An explicit gasLimit keeps ethers from calling eth_estimateGas, which would
          // simulate the second relay against pending state and reject it before mining.
          const tx1 = await tellorDataBank.updateOracleData(
            first.attestData,
            first.currentValidatorSet,
            first.sigs,
            { gasLimit: 2_000_000 }
          );
          const tx2 = await tellorDataBank.updateOracleData(
            second.attestData,
            second.currentValidatorSet,
            second.sigs,
            { gasLimit: 2_000_000 }
          );

          await network.provider.send("evm_mine");

          const receipt1 = await ethers.provider.getTransactionReceipt(tx1.hash);
          const receipt2 = await ethers.provider.getTransactionReceipt(tx2.hash);

          expect(receipt1.blockNumber).to.equal(receipt2.blockNumber);
          expect(receipt1.status).to.equal(1);
          expect(receipt2.status).to.equal(0);
        } finally {
          await network.provider.send("evm_setAutomine", [true]);
        }

        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        const stored = await tellorDataBank.getCurrentAggregateData(ETH_USD_QUERY_ID);
        expect(abiCoder.decode(["uint256"], stored.value)[0]).to.equal(h.toWei("2000"));
      });
    });
  });
  describe("Multi-Query ID Tests for TellorDataBank", function () {
    // Define additional query IDs for testing
    const BTC_USD_QUERY_DATA_ARGS = abiCoder.encode(["string", "string"], ["btc", "usd"]);
    const BTC_USD_QUERY_DATA = abiCoder.encode(["string", "bytes"], ["SpotPrice", BTC_USD_QUERY_DATA_ARGS]);
    const BTC_USD_QUERY_ID = h.hash(BTC_USD_QUERY_DATA);

    const ETH_EUR_QUERY_DATA_ARGS = abiCoder.encode(["string", "string"], ["eth", "eur"]);
    const ETH_EUR_QUERY_DATA = abiCoder.encode(["string", "bytes"], ["SpotPrice", ETH_EUR_QUERY_DATA_ARGS]);
    const ETH_EUR_QUERY_ID = h.hash(ETH_EUR_QUERY_DATA);

    describe("Storing data for multiple query IDs", function () {
      it("Should store data for different query IDs simultaneously", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        // Mock price values for different assets
        const ethPrice = h.toWei("2000");
        const btcPrice = h.toWei("45000");
        const ethEurPrice = h.toWei("1800");
        
        const ethValue = abiCoder.encode(["uint256"], [ethPrice]);
        const btcValue = abiCoder.encode(["uint256"], [btcPrice]);
        const ethEurValue = abiCoder.encode(["uint256"], [ethEurPrice]);
        
        // Prepare oracle data for ETH/USD
        const { attestData: ethAttestData, currentValidatorSet: ethValidatorSet, sigs: ethSigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          ethValue,
          validatorSet
        );
        
        // Wait a bit for different timestamps
        await time.increase(1);
        
        // Prepare oracle data for BTC/USD
        const { attestData: btcAttestData, currentValidatorSet: btcValidatorSet, sigs: btcSigs } = await h.prepareOracleData(
          BTC_USD_QUERY_ID,
          btcValue,
          validatorSet
        );
        
        // Wait a bit for different timestamps
        await time.increase(1);
        
        // Prepare oracle data for ETH/EUR
        const { attestData: ethEurAttestData, currentValidatorSet: ethEurValidatorSet, sigs: ethEurSigs } = await h.prepareOracleData(
          ETH_EUR_QUERY_ID,
          ethEurValue,
          validatorSet
        );
        
        // Update oracle data for all three query IDs
        await expect(tellorDataBank.updateOracleData(ethAttestData, ethValidatorSet, ethSigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(ETH_USD_QUERY_ID, h.attestDataStructToArray(ethAttestData));
        
        await expect(tellorDataBank.updateOracleData(btcAttestData, btcValidatorSet, btcSigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(BTC_USD_QUERY_ID, h.attestDataStructToArray(btcAttestData));
        
        await expect(tellorDataBank.updateOracleData(ethEurAttestData, ethEurValidatorSet, ethEurSigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(ETH_EUR_QUERY_ID, h.attestDataStructToArray(ethEurAttestData));
        
        // Verify all data was stored correctly
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(1);
        expect(await tellorDataBank.getAggregateValueCount(ETH_EUR_QUERY_ID)).to.equal(1);
        
        // Verify data integrity for each query ID
        const ethData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 0);
        const btcData = await tellorDataBank.getAggregateByIndex(BTC_USD_QUERY_ID, 0);
        const ethEurData = await tellorDataBank.getAggregateByIndex(ETH_EUR_QUERY_ID, 0);
        
        expect(abiCoder.decode(["uint256"], ethData.value)[0]).to.equal(ethPrice);
        expect(abiCoder.decode(["uint256"], btcData.value)[0]).to.equal(btcPrice);
        expect(abiCoder.decode(["uint256"], ethEurData.value)[0]).to.equal(ethEurPrice);
        
        expect(ethData.aggregateTimestamp).to.equal(ethAttestData.report.timestamp);
        expect(btcData.aggregateTimestamp).to.equal(btcAttestData.report.timestamp);
        expect(ethEurData.aggregateTimestamp).to.equal(ethEurAttestData.report.timestamp);
      });

      it("Should handle multiple updates for the same query ID without affecting others", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        // Initial prices
        const ethPrice1 = h.toWei("2000");
        const ethPrice2 = h.toWei("2100");
        const btcPrice = h.toWei("45000");
        
        const ethValue1 = abiCoder.encode(["uint256"], [ethPrice1]);
        const ethValue2 = abiCoder.encode(["uint256"], [ethPrice2]);
        const btcValue = abiCoder.encode(["uint256"], [btcPrice]);
        
        // Store initial data for both query IDs
        let { attestData: ethAttestData1, currentValidatorSet: ethValidatorSet1, sigs: ethSigs1 } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          ethValue1,
          validatorSet
        );
        
        await time.increase(1);
        
        const { attestData: btcAttestData, currentValidatorSet: btcValidatorSet, sigs: btcSigs } = await h.prepareOracleData(
          BTC_USD_QUERY_ID,
          btcValue,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(ethAttestData1, ethValidatorSet1, ethSigs1);
        await tellorDataBank.updateOracleData(btcAttestData, btcValidatorSet, btcSigs);
        
        // Verify initial state
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(1);
        
        // Update ETH/USD again
        await time.increase(60);
        
        const { attestData: ethAttestData2, currentValidatorSet: ethValidatorSet2, sigs: ethSigs2 } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          ethValue2,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(ethAttestData2, ethValidatorSet2, ethSigs2);
        
        // Verify ETH/USD has 2 entries, BTC/USD still has 1
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(2);
        expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(1);
        
        // Verify latest ETH/USD data
        const latestEthData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 1);
        expect(abiCoder.decode(["uint256"], latestEthData.value)[0]).to.equal(ethPrice2);
        
        // Verify BTC/USD data is unchanged
        const btcData = await tellorDataBank.getAggregateByIndex(BTC_USD_QUERY_ID, 0);
        expect(abiCoder.decode(["uint256"], btcData.value)[0]).to.equal(btcPrice);
        expect(btcData.aggregateTimestamp).to.equal(btcAttestData.report.timestamp);
      });

      it("Should maintain independent data arrays for different query IDs", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        // Store 3 updates for ETH/USD and 2 updates for BTC/USD
        const ethPrices = [h.toWei("2000"), h.toWei("2100"), h.toWei("2200")];
        const btcPrices = [h.toWei("45000"), h.toWei("46000")];
        
        // Store ETH/USD data
        for (let i = 0; i < ethPrices.length; i++) {
          const ethValue = abiCoder.encode(["uint256"], [ethPrices[i]]);
          const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
            ETH_USD_QUERY_ID,
            ethValue,
            validatorSet
          );
          await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
          await time.increase(60);
          expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(i + 1);
          expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(0);
        }
        
        // Store BTC/USD data
        for (let i = 0; i < btcPrices.length; i++) {
          const btcValue = abiCoder.encode(["uint256"], [btcPrices[i]]);
          const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
            BTC_USD_QUERY_ID,
            btcValue,
            validatorSet,
          );
          await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
          await time.increase(60);
          expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(3);
          expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(i + 1);
        }
        
        // Verify independent counts
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(3);
        expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(2);
        
        // Verify all ETH/USD data
        for (let i = 0; i < ethPrices.length; i++) {
          const ethData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, i);
          expect(abiCoder.decode(["uint256"], ethData.value)[0]).to.equal(ethPrices[i]);
        }
        
        // Verify all BTC/USD data
        for (let i = 0; i < btcPrices.length; i++) {
          const btcData = await tellorDataBank.getAggregateByIndex(BTC_USD_QUERY_ID, i);
          expect(abiCoder.decode(["uint256"], btcData.value)[0]).to.equal(btcPrices[i]);
        }
      });
    });
  });

  describe("Data Retrieval Functions", function () {
    beforeEach(async function () {
      const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
      this.tellorDataBank = tellorDataBank;

      const mockPrice = h.toWei("2000");
      const mockValue = abiCoder.encode(["uint256"], [mockPrice]);
      const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
        ETH_USD_QUERY_ID,
        mockValue,
        validatorSet
      );

      await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
      this.testTimestamp = attestData.report.timestamp;
      this.testValue = mockPrice;
      this.testPower = attestData.report.aggregatePower;
      this.testAttestationTimestamp = attestData.attestationTimestamp;
    });

    describe("getAggregateValueCount", function () {
      it("Should return correct count of stored values", async function () {
        expect(await this.tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
      });
    });

    describe("getCurrentAggregateData", function () {
      it("Should return the latest stored aggregate", async function () {
        const current = await this.tellorDataBank.getCurrentAggregateData(ETH_USD_QUERY_ID);
        expect(current.aggregateTimestamp).to.equal(this.testTimestamp);
        expect(abiCoder.decode(["uint256"], current.value)[0]).to.equal(this.testValue);
        expect(current.power).to.equal(this.testPower);
        expect(current.attestationTimestamp).to.equal(this.testAttestationTimestamp);
      });

      it("Should return empty aggregate when no data exists", async function () {
        const emptyQueryId = h.hash("0xdeadbeef");
        const current = await this.tellorDataBank.getCurrentAggregateData(emptyQueryId);
        expect(current.value).to.equal("0x");
        expect(current.power).to.equal(0);
        expect(current.aggregateTimestamp).to.equal(0);
        expect(current.attestationTimestamp).to.equal(0);
        expect(current.relayTimestamp).to.equal(0);
      });
    });

    describe("getRelayBefore", function () {
      it("Should return not found when no relays exist", async function () {
        const emptyQueryId = h.hash("0xdeadbeef");
        const [found, aggregateData] = await this.tellorDataBank.getRelayBefore(emptyQueryId, 9999999999);
        expect(found).to.equal(false);
        expect(aggregateData.relayTimestamp).to.equal(0);
      });

      it("Should return not found when cutoff is at or before the only relay", async function () {
        const current = await this.tellorDataBank.getCurrentAggregateData(ETH_USD_QUERY_ID);
        const [foundAtRelayTime, atRelay] = await this.tellorDataBank.getRelayBefore(
          ETH_USD_QUERY_ID,
          current.relayTimestamp
        );
        expect(foundAtRelayTime).to.equal(false);
        expect(atRelay.relayTimestamp).to.equal(0);

        const [foundBeforeRelay, beforeRelay] = await this.tellorDataBank.getRelayBefore(
          ETH_USD_QUERY_ID,
          current.relayTimestamp - 1n
        );
        expect(foundBeforeRelay).to.equal(false);
        expect(beforeRelay.relayTimestamp).to.equal(0);
      });

      it("Should return the only relay when cutoff is after its relay time", async function () {
        const current = await this.tellorDataBank.getCurrentAggregateData(ETH_USD_QUERY_ID);
        const [found, aggregateData] = await this.tellorDataBank.getRelayBefore(
          ETH_USD_QUERY_ID,
          current.relayTimestamp + 1n
        );
        expect(found).to.equal(true);
        expect(aggregateData.relayTimestamp).to.equal(current.relayTimestamp);
        expect(aggregateData.aggregateTimestamp).to.equal(this.testTimestamp);
        expect(abiCoder.decode(["uint256"], aggregateData.value)[0]).to.equal(this.testValue);
      });

      it("Should return the newest relay strictly before the cutoff", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        const prices = [h.toWei("2000"), h.toWei("2100"), h.toWei("2200")];
        const relayTimes = [];

        for (const price of prices) {
          if (relayTimes.length > 0) await time.increase(60);
          const mockValue = abiCoder.encode(["uint256"], [price]);
          const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
            ETH_USD_QUERY_ID,
            mockValue,
            validatorSet
          );
          const tx = await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
          const receipt = await tx.wait();
          const block = await ethers.provider.getBlock(receipt.blockNumber);
          relayTimes.push(block.timestamp);
        }

        const [foundMiddle, middleRelay] = await tellorDataBank.getRelayBefore(
          ETH_USD_QUERY_ID,
          relayTimes[1] + 1
        );
        expect(foundMiddle).to.equal(true);
        expect(middleRelay.relayTimestamp).to.equal(relayTimes[1]);
        expect(abiCoder.decode(["uint256"], middleRelay.value)[0]).to.equal(prices[1]);

        const [foundExact, exactRelay] = await tellorDataBank.getRelayBefore(
          ETH_USD_QUERY_ID,
          relayTimes[2]
        );
        expect(foundExact).to.equal(true);
        expect(exactRelay.relayTimestamp).to.equal(relayTimes[1]);
        expect(abiCoder.decode(["uint256"], exactRelay.value)[0]).to.equal(prices[1]);

        const [foundLatest, latestRelay] = await tellorDataBank.getRelayBefore(
          ETH_USD_QUERY_ID,
          relayTimes[2] + 1
        );
        expect(foundLatest).to.equal(true);
        expect(latestRelay.relayTimestamp).to.equal(relayTimes[2]);
        expect(abiCoder.decode(["uint256"], latestRelay.value)[0]).to.equal(prices[2]);
      });
    });
  });

});
