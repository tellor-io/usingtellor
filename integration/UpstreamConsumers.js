const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { build } = require("./upstream/build");
const h = require("../src/helpers/evmHelpers");

// Real pinned consumers. Source mocks below inject faults; the final cases use real Tellor history.
describe("Upstream Morpho V2 and Euler Chainlink consumers", function () {
  let artifacts;
  before(function () {
    this.timeout(240000);
    artifacts = build(); // Always compiles pinned source, never loads pre-existing output JSON.
  });
  const zero = ethers.ZeroAddress;
  const pow = decimals => 10n ** BigInt(decimals);
  const signedMax = (1n << 255n) - 1n;

  async function deployConsumer(name, signer, args) {
    const a = artifacts[name];
    return new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  }
  async function deployShepherd(f, leg, primary, backup) {
    return f.Shepherd.deploy(f.ids[leg], f.feedDecimals[leg], primary.target, backup.target,
      f.admin.address, 10, 20, 2000, [5, 7], 3600);
  }
  async function consumers(f, maxStaleness = 3600) {
    const morpho = await deployConsumer("morpho", f.admin, [
      zero, 1, f.shepherds[0].target, zero, f.tokenDecimals[0],
      zero, 1, f.shepherds[1].target, zero, f.tokenDecimals[1],
    ]);
    const tokens = [];
    for (const decimals of f.tokenDecimals) tokens.push(await deployConsumer("token", f.admin, [decimals]));
    const euler = await deployConsumer("euler", f.admin, [tokens[0].target, tokens[1].target,
      f.shepherds[0].target, maxStaleness]);
    return { morpho, euler, tokens };
  }
  async function mockFixture() {
    const [admin] = await ethers.getSigners();
    const f = { admin, ids: [ethers.id("collateral/USD"), ethers.id("loan/USD")],
      feedDecimals: [8, 18], tokenDecimals: [18, 6], sources: [], shepherds: [],
      prices: [3000n * pow(8), pow(18)],
      Source: await ethers.getContractFactory("PriceSourceMock"),
      Shepherd: await ethers.getContractFactory("TellorShepherd") };
    f.stamp = BigInt(await time.latest() - 10) * 1000n + 987n;
    for (const leg of [0, 1]) {
      const pair = [await f.Source.deploy(f.ids[leg], f.feedDecimals[leg]),
        await f.Source.deploy(f.ids[leg], f.feedDecimals[leg])];
      await pair[0].configureRead(f.prices[leg], f.stamp, 0);
      await pair[1].configureRead(f.prices[leg] * 3n / 2n, f.stamp + 1000n, 0);
      f.sources.push(pair);
      f.shepherds.push(await deployShepherd(f, leg, ...pair));
    }
    return { ...f, ...await consumers(f) };
  }
  // Independent rational calculation in arbitrary-precision integers, rounded once at the end.
  function morphoPrice(f, prices) {
    return pow(36) * prices[0] * pow(f.feedDecimals[1]) * pow(f.tokenDecimals[1]) /
      (prices[1] * pow(f.feedDecimals[0]) * pow(f.tokenDecimals[0]));
  }
  async function eulerQuotes(f, price, amount = 1234567890123456789n, oracle = f.euler) {
    const numerator = price * pow(f.tokenDecimals[1]);
    const denominator = pow(f.tokenDecimals[0]) * pow(f.feedDecimals[0]);
    for (const inverse of [false, true]) {
      const [base, quote] = inverse ? [f.tokens[1].target, f.tokens[0].target] : f.tokens.map(t => t.target);
      const expected = inverse ? amount * denominator / numerator : amount * numerator / denominator;
      expect(await oracle.getQuote(amount, base, quote)).to.equal(expected);
      expect(await oracle.getQuotes(amount, base, quote)).to.deep.equal([expected, expected]);
    }
  }
  async function eulerRefusal(f, contract, error, args = [], oracle = f.euler) {
    for (const inverse of [false, true]) {
      const tokens = inverse ? [f.tokens[1].target, f.tokens[0].target] : f.tokens.map(t => t.target);
      for (const method of ["getQuote", "getQuotes"]) {
        const call = expect(oracle[method](pow(18), ...tokens));
        if (error) await call.to.be.revertedWithCustomError(contract, error).withArgs(...args);
        else await call.to.be.reverted;
      }
    }
  }
  async function switchToBackup(f, leg) {
    const s = f.shepherds[leg];
    await s.requestChallenge();
    await time.increase(5);
    await s.executeChallenge();
    expect(await s.mode()).to.equal(1);
  }

  it("wires Shepherds into V2 base/quote feed 1 with unequal token and feed decimals", async function () {
    const f = await loadFixture(mockFixture);
    expect(await f.morpho.BASE_FEED_1()).to.equal(f.shepherds[0].target);
    expect(await f.morpho.QUOTE_FEED_1()).to.equal(f.shepherds[1].target);
    for (const getter of ["BASE_FEED_2", "QUOTE_FEED_2", "BASE_VAULT", "QUOTE_VAULT"]) {
      expect(await f.morpho[getter]()).to.equal(zero);
    }
    expect(await f.euler.feed()).to.equal(f.shepherds[0].target);
    expect(await f.morpho.price()).to.equal(3000n * pow(24));
    expect(await f.morpho.price()).to.equal(morphoPrice(f, f.prices));
    await eulerQuotes(f, f.prices[0]);
    for (const s of f.shepherds) {
      const round = await s.latestRoundData();
      expect([round.roundId, round.startedAt, round.answeredInRound]).to.deep.equal([0n, 0n, 0n]);
    }
  });

  for (const modes of [[0, 1], [1, 0], [1, 1]]) {
    it(`composes selected modes ${modes} and supports explicit recovery`, async function () {
      const f = await loadFixture(mockFixture), prices = [...f.prices];
      for (const leg of [0, 1]) if (modes[leg]) {
        await switchToBackup(f, leg);
        prices[leg] = f.prices[leg] * 3n / 2n;
        const native = await f.shepherds[leg].getCurrentValue();
        expect(native[1]).to.equal(f.stamp + 1000n);
      }
      expect(await f.morpho.price()).to.equal(morphoPrice(f, prices));
      await eulerQuotes(f, prices[0]);
      for (const leg of [0, 1]) if (modes[leg]) {
        await f.sources[leg][1].configureRead(f.prices[leg], f.stamp + 1000n, 0);
        await f.shepherds[leg].requestRecovery();
        await time.increase(7);
        await f.shepherds[leg].executeRecovery();
      }
      expect(await f.morpho.price()).to.equal(morphoPrice(f, f.prices));
      await eulerQuotes(f, f.prices[0]);
    });
  }

  it("isolates query wiring and composes independently fresh observations without a skew check", async function () {
    const f = await loadFixture(mockFixture);
    const recent = BigInt(await time.latest() - 1) * 1000n;
    await f.sources[0][0].configureRead(f.prices[0], recent - 1200000n, 0);
    await f.sources[1][0].configureRead(2n * pow(18), recent, 0);
    const baseRound = await f.shepherds[0].latestRoundData(), quoteRound = await f.shepherds[1].latestRoundData();
    expect(quoteRound.updatedAt - baseRound.updatedAt).to.equal(1200n);
    expect(await f.morpho.price()).to.equal(morphoPrice(f, [f.prices[0], 2n * pow(18)]));
    await eulerQuotes(f, f.prices[0]); // Euler uses only the base feed, not the Morpho quote feed.
    const wrongQuery = await f.Source.deploy(f.ids[1], f.feedDecimals[0]);
    await expect(f.shepherds[0].proposeSourcesChange(wrongQuery.target, f.sources[0][1].target))
      .to.be.revertedWithCustomError(f.shepherds[0], "SourceQueryIdMismatch");
    expect(await f.shepherds[0].queryId()).to.equal(f.ids[0]);
    expect(await f.shepherds[1].queryId()).to.equal(f.ids[1]);
  });

  for (const leg of [0, 1]) {
    for (const mode of [0, 1]) {
      it(`preserves consumer wiring and selected observation through migration; leg=${leg}, mode=${mode}`, async function () {
        const f = await loadFixture(mockFixture);
        if (mode) await switchToBackup(f, leg);
        const next = [await f.Source.deploy(f.ids[leg], f.feedDecimals[leg]),
          await f.Source.deploy(f.ids[leg], f.feedDecimals[leg])];
        const price = f.prices[leg] * 2n, stamp = f.stamp + 123n;
        await next[mode].configureRead(price, stamp, 0); // Unselected replacement remains unavailable.
        const s = f.shepherds[leg];
        await s.proposeSourcesChange(...next.map(source => source.target));
        await s.pause();
        await expect(f.morpho.price()).to.be.revertedWithCustomError(s, "ShepherdPaused");
        if (leg === 0) await eulerRefusal(f, s, "ShepherdPaused");
        await time.increase(20);
        await s.executeSourcesChange();
        await s.unpause();
        for (const source of f.sources[leg]) await source.configureRead(0, 0, 1);
        const prices = [...f.prices]; prices[leg] = price;
        expect(await f.morpho.price()).to.equal(morphoPrice(f, prices));
        await eulerQuotes(f, prices[0]);
        expect(await s.getCurrentValue()).to.deep.equal([price, stamp]);
        expect((await s.latestRoundData()).updatedAt).to.equal(stamp / 1000n);
        expect(await s.MAX_DATA_AGE()).to.equal(3600);
      });

      for (const fault of ["zero price", "zero timestamp", "future", "stale", "unavailable", "malformed", "signed overflow"]) {
        it(`propagates selected ${fault}; leg=${leg}, mode=${mode}`, async function () {
          const f = await loadFixture(mockFixture);
          if (mode) await switchToBackup(f, leg);
          const s = f.shepherds[leg], source = f.sources[leg][mode];
          await source.configureRead(fault === "zero price" ? 0 : fault === "signed overflow" ? signedMax + 1n : f.prices[leg],
            fault === "zero timestamp" ? 0 : fault === "future" ? ethers.MaxUint256 :
              fault === "stale" ? f.stamp - 3600000n : f.stamp,
            fault === "unavailable" ? 1 : fault === "malformed" ? 2 : 0);
          const error = { "zero price": "ZeroValue", "zero timestamp": "InvalidTimestamp", future: "InvalidTimestamp",
            stale: "StalePrice", unavailable: "ReadUnavailable", "signed overflow": "SignedPriceOverflow" }[fault];
          const origin = fault === "unavailable" ? source : s;
          if (error) await expect(f.morpho.price()).to.be.revertedWithCustomError(origin, error);
          else await expect(f.morpho.price()).to.be.reverted;
          if (leg === 0) await eulerRefusal(f, origin, error);
          else await eulerQuotes(f, f.prices[0]);
          expect(await s.mode()).to.equal(mode);
        });
      }
      it(`ignores unavailable/stale unselected data; leg=${leg}, mode=${mode}`, async function () {
        const f = await loadFixture(mockFixture), prices = [...f.prices];
        if (mode) { await switchToBackup(f, leg); prices[leg] *= 3n; prices[leg] /= 2n; }
        for (const behavior of [0, 1]) {
          await f.sources[leg][1 - mode].configureRead(999, f.stamp - 3600000n, behavior);
          expect(await f.morpho.price()).to.equal(morphoPrice(f, prices));
          await eulerQuotes(f, prices[0]);
        }
      });
    }
  }

  for (const excess of [-1, 0, 1]) {
    it(`equal integer-second age limits at 3600s ${excess >= 0 ? "+" : ""}${excess}ms`, async function () {
      const f = await loadFixture(mockFixture);
      const at = await time.latest() + 10, stamp = BigInt(at * 1000 - 3600000 - excess);
      await f.sources[0][0].configureRead(f.prices[0], stamp, 0);
      await time.increaseTo(at);
      if (excess <= 0) {
        expect(await f.morpho.price()).to.equal(morphoPrice(f, f.prices));
        await eulerQuotes(f, f.prices[0]);
        expect(BigInt(at) - (await f.shepherds[0].latestRoundData()).updatedAt).to.equal(3600n);
      } else {
        await expect(f.morpho.price()).to.be.revertedWithCustomError(f.shepherds[0], "StalePrice");
        await eulerRefusal(f, f.shepherds[0], "StalePrice");
      }
    });
  }

  it("Euler's stricter independent age bound can refuse while Shepherd and V2 accept", async function () {
    const f = await loadFixture(mockFixture);
    const strict = await deployConsumer("euler", f.admin, [f.tokens[0].target, f.tokens[1].target, f.shepherds[0].target, 60]);
    const at = await time.latest() + 10;
    const stamp = BigInt((at - 60) * 1000 + 987);
    await f.sources[0][0].configureRead(f.prices[0], stamp, 0);
    await time.increaseTo(at);
    await eulerQuotes(f, f.prices[0], pow(18), strict);
    await time.increase(1); // True age 60.013s; floored seconds age 61s.
    expect(await f.shepherds[0].getCurrentValue()).to.deep.equal([f.prices[0], stamp]);
    expect(await f.morpho.price()).to.equal(morphoPrice(f, f.prices));
    await eulerRefusal(f, strict, "PriceOracle_TooStale", [61, 60], strict);
  });

  it("rejects a 1ms future observation before a consumer could accept its floored second", async function () {
    const f = await loadFixture(mockFixture), at = await time.latest() + 10;
    await f.sources[0][0].configureRead(f.prices[0], at * 1000 + 1, 0);
    await time.increaseTo(at);
    await expect(f.morpho.price()).to.be.revertedWithCustomError(f.shepherds[0], "InvalidTimestamp");
    await eulerRefusal(f, f.shepherds[0], "InvalidTimestamp");
  });

  async function bankFixture() {
    const f = await mockFixture();
    const valset = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const bridge = await (await ethers.getContractFactory("TellorDataBridge")).deploy(f.admin.address, valset.domainSeparator);
    await bridge.init(valset.powerThreshold, valset.timestamp, 21 * 86400, valset.checkpoint);
    const bank = await (await ethers.getContractFactory("TellorDataBank")).deploy(bridge.target, 43200, 600, 86400);
    const pairs = [], shepherds = [];
    for (const leg of [0, 1]) {
      const primary = await (await ethers.getContractFactory("TellorTwapSource")).deploy(bank.target, f.ids[leg], f.feedDecimals[leg], 60, 30000);
      const backup = await (await ethers.getContractFactory("TellorSpotSource")).deploy(bank.target, f.ids[leg], f.feedDecimals[leg], 60);
      pairs.push([primary, backup]);
      shepherds.push(await deployShepherd(f, leg, primary, backup));
    }
    const real = { ...f, valset, bank, sources: pairs, shepherds, stamp: BigInt(await time.latest() - 120) * 1000n + 17n };
    for (const leg of [0, 1]) {
      await relay(real, leg, f.prices[leg], real.stamp);
      await relay(real, leg, f.prices[leg], real.stamp + 30000n);
    }
    await time.increase(61);
    return { ...real, ...await consumers(real) };
  }
  async function relay(f, leg, value, stamp) {
    const report = await h.prepareOracleData(f.ids[leg], ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [value]), f.valset,
      { aggregateTimestamp: Number(stamp), attestationTimestamp: (await time.latest()) * 1000 });
    await f.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
  }
  it("composes real bridge/bank TWAPs, isolates queries, then consumes a mature backup", async function () {
    const f = await loadFixture(bankFixture);
    expect(await f.morpho.price()).to.equal(morphoPrice(f, f.prices));
    await eulerQuotes(f, f.prices[0]);
    const loanBefore = await f.shepherds[1].getCurrentValue();
    await relay(f, 0, f.prices[0] * 3n / 2n, f.stamp + 40000n);
    await time.increase(61);
    await switchToBackup(f, 0);
    expect(await f.shepherds[0].getCurrentValue()).to.deep.equal([f.prices[0] * 3n / 2n, f.stamp + 40000n]);
    expect(await f.shepherds[1].getCurrentValue()).to.deep.equal(loanBefore);
    expect(await f.morpho.price()).to.equal(morphoPrice(f, [f.prices[0] * 3n / 2n, f.prices[1]]));
    await eulerQuotes(f, f.prices[0] * 3n / 2n);
    await f.shepherds[0].pause();
    await expect(f.morpho.price()).to.be.revertedWithCustomError(f.shepherds[0], "ShepherdPaused");
    await eulerRefusal(f, f.shepherds[0], "ShepherdPaused");
  });
});
