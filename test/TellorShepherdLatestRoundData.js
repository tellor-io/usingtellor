const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const signedMax = (1n << 255n) - 1n;
const methods = ["getCurrentValue", "latestRoundData"];
async function fixture() {
  const [admin] = await ethers.getSigners();
  const queryId = ethers.id("latest-read-feed");
  const Source = await ethers.getContractFactory("PriceSourceMock");
  const sources = [await Source.deploy(queryId, 18), await Source.deploy(queryId, 18)];
  const timestamp = BigInt(await time.latest() - 10) * 1000n + 987n;
  await sources[0].configureRead(100, timestamp, 0);
  await sources[1].configureRead(150, timestamp + 1000n, 0);
  const Shepherd = await ethers.getContractFactory("TellorShepherdHarness");
  const args = [queryId, 18, sources[0].target, sources[1].target, admin.address,
    10, 20, 2000, [5, 7], 3600, true];
  const s = await Shepherd.deploy(...args);
  return { queryId, Source, sources, timestamp, Shepherd, args, s };
}
async function state(s) {
  return Promise.all([s.mode(), s.paused(), s.pausedAt(), s.challengePending(),
    s.challengeRequestedAt(), s.recoveryPending(), s.recoveryRequestedAt()]);
}
async function parity(s, value, timestamp) {
  const before = await state(s);
  expect(await s.getCurrentValue()).to.deep.equal([value, timestamp]);
  expect(await s.latestRoundData()).to.deep.equal([0n, value, 0n, timestamp / 1000n, 0n]);
  expect(await state(s)).to.deep.equal(before);
}
async function refusal(s, error, contract = s) {
  const before = await state(s);
  for (const method of methods) {
    if (error) await expect(s[method]()).to.be.revertedWithCustomError(contract, error);
    else await expect(s[method]()).to.be.reverted;
  }
  expect(await state(s)).to.deep.equal(before);
}

describe("TellorShepherd - Chainlink latest-read subset", function () {
  it("exposes the exact latest-read ABI with zero unavailable round fields", async function () {
    const { s } = await loadFixture(fixture);
    const fragment = s.interface.getFunction("latestRoundData");
    expect(fragment.inputs).to.have.length(0);
    expect(fragment.stateMutability).to.equal("view");
    expect(fragment.outputs.map(output => output.type)).to.deep.equal(["uint80", "int256", "uint256", "uint256", "uint80"]);
    expect(fragment.outputs.map(output => output.name)).to.deep.equal(["roundId", "answer", "startedAt", "updatedAt", "answeredInRound"]);
    // Decode through an independent consumer ABI, not the Shepherd output definition.
    const feed = new ethers.Contract(s.target, [
      "function decimals() view returns (uint8)",
      "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
    ], ethers.provider);
    expect(await feed.decimals()).to.equal(18);
    const native = await s.getCurrentValue();
    expect(await feed.latestRoundData()).to.deep.equal([0n, native[0], 0n, native[1] / 1000n, 0n]);
  });

  for (const precision of [0, 8, 18, 77]) {
    it(`retains declared precision ${precision} and raw scale in both modes`, async function () {
      const f = await loadFixture(fixture);
      for (const source of f.sources) await source.configureMetadata(f.queryId, precision);
      const args = [...f.args]; args[1] = precision;
      const s = await f.Shepherd.deploy(...args);
      expect(await s.decimals()).to.equal(precision);
      for (const mode of [0, 1]) {
        await s.setModeForTest(mode);
        await parity(s, ...await f.sources[mode].getCurrentValue());
      }
    });
  }

  for (const mode of [0, 1]) {
    for (const value of [1n, signedMax, signedMax + 1n, ethers.MaxUint256]) {
      it(`mode ${mode}: signed boundary price ${value}`, async function () {
        const f = await loadFixture(fixture);
        await f.s.setModeForTest(mode);
        await f.sources[mode].configureRead(value, f.timestamp, 0);
        if (value <= signedMax) await parity(f.s, value, f.timestamp);
        else {
          const before = await state(f.s);
          expect(await f.s.getCurrentValue()).to.deep.equal([value, f.timestamp]);
          await expect(f.s.latestRoundData()).to.be.revertedWithCustomError(f.s, "SignedPriceOverflow");
          expect(await state(f.s)).to.deep.equal(before);
        }
      });
    }
    for (const fault of ["zero price", "zero timestamp", "future", "stale", "revert", "malformed"]) {
      it(`mode ${mode}: both entry points refuse ${fault} without fallback`, async function () {
        const f = await loadFixture(fixture);
        await f.s.setModeForTest(mode);
        await f.sources[mode].configureRead(fault === "zero price" ? 0 : 100,
          fault === "zero timestamp" ? 0 : fault === "future" ? ethers.MaxUint256 :
            fault === "stale" ? f.timestamp - 3600000n : f.timestamp,
          fault === "revert" ? 1 : fault === "malformed" ? 2 : 0);
        const error = { "zero price": "ZeroValue", "zero timestamp": "InvalidTimestamp",
          future: "InvalidTimestamp", stale: "StalePrice", revert: "ReadUnavailable" }[fault];
        await refusal(f.s, error, fault === "revert" ? f.sources[mode] : f.s);
      });
    }
    it(`mode ${mode}: pause precedes source and signed-range failures`, async function () {
      const f = await loadFixture(fixture);
      await f.s.setModeForTest(mode);
      await f.sources[mode].configureRead(ethers.MaxUint256, f.timestamp, 0);
      await f.s.pause();
      await refusal(f.s, "ShepherdPaused");
      await f.sources[mode].configureRead(0, 0, 1);
      await refusal(f.s, "ShepherdPaused");
    });
    it(`mode ${mode}: stale or unavailable unselected source does not block reads`, async function () {
      const f = await loadFixture(fixture);
      await f.s.setModeForTest(mode);
      for (const behavior of [0, 1]) {
        await f.sources[1 - mode].configureRead(999, f.timestamp - 3600000n, behavior);
        await parity(f.s, ...await f.sources[mode].getCurrentValue());
      }
    });
    for (const excess of [-1, 0, 1]) {
      it(`mode ${mode}: validates original age at limit ${excess >= 0 ? "+" : ""}${excess}ms`, async function () {
        const f = await loadFixture(fixture);
        await f.s.setModeForTest(mode);
        const at = await time.latest() + 10;
        const stamp = BigInt(at * 1000 - 3600000 - excess);
        await f.sources[mode].configureRead(100, stamp, 0);
        await time.increaseTo(at);
        if (excess > 0) await refusal(f.s, "StalePrice");
        else await parity(f.s, 100n, stamp);
      });
    }
    it(`mode ${mode}: flooring cannot launder a 1ms future timestamp or signed overflow`, async function () {
      const f = await loadFixture(fixture);
      await f.s.setModeForTest(mode);
      const at = await time.latest() + 10;
      await f.sources[mode].configureRead(ethers.MaxUint256, at * 1000 + 1, 0);
      await time.increaseTo(at);
      // Flooring first would turn this invalid timestamp into the current second.
      await refusal(f.s, "InvalidTimestamp");
    });
    it(`mode ${mode}: source migration preserves selected timestamp and scale`, async function () {
      const f = await loadFixture(fixture);
      await f.s.setModeForTest(mode);
      const next = [await f.Source.deploy(f.queryId, 18), await f.Source.deploy(f.queryId, 18)];
      const stamp = f.timestamp + 123n;
      await next[mode].configureRead(1234567890123456789n, stamp, 0);
      await f.s.proposeSourcesChange(...next.map(source => source.target));
      await f.s.pause();
      const pauseClock = await f.s.pausedAt();
      await time.increase(20);
      await f.s.executeSourcesChange();
      expect(await f.s.pausedAt()).to.equal(pauseClock);
      await refusal(f.s, "ShepherdPaused");
      await f.s.unpause();
      for (const source of f.sources) await source.configureRead(0, 0, 1);
      // The new unselected source is also unavailable; only the selected source is read.
      await parity(f.s, 1234567890123456789n, stamp);
      expect(await f.s.decimals()).to.equal(18);
      expect(await f.s.mode()).to.equal(mode);
    });
  }

  it("floors seconds conservatively without changing native milliseconds", async function () {
    const f = await loadFixture(fixture);
    await parity(f.s, 100n, f.timestamp);
    const round = await f.s.latestRoundData();
    const nowMs = BigInt(await time.latest()) * 1000n;
    const trueAgeMs = nowMs - f.timestamp;
    const downstreamAgeMs = nowMs - round.updatedAt * 1000n;
    expect(downstreamAgeMs - trueAgeMs).to.equal(987n);
    expect(downstreamAgeMs).to.be.at.least(trueAgeMs);
    expect(downstreamAgeMs - trueAgeMs).to.be.lessThan(1000n);
  });

  it("actual challenge and recovery switches retain source timestamps and zero round sentinels", async function () {
    const f = await loadFixture(fixture);
    await f.s.requestChallenge();
    const clock = await f.s.challengeRequestedAt();
    await parity(f.s, 100n, f.timestamp);
    expect(await f.s.challengeRequestedAt()).to.equal(clock);
    await time.setNextBlockTimestamp(clock + 5n);
    await f.s.executeChallenge();
    await parity(f.s, 150n, f.timestamp + 1000n);
    await f.sources[1].configureRead(100, f.timestamp + 1000n, 0);
    await f.s.requestRecovery();
    await time.increase(7);
    await f.s.executeRecovery();
    await parity(f.s, 100n, f.timestamp); // Older than backup: no fabricated round progression.
  });
});
