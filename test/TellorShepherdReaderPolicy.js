const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

// Real reader contracts with an injected bank response, not real DataBank admission.
// The real bank rejects zero prices on admission; this tests the reader/Shepherd boundary.
describe("TellorShepherd - Reader usability policy", function () {
  const encode = value => ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [value]);
  for (const reader of ["TellorSpotSource", "TellorTwapSource"]) {
    for (const mode of [0, 1]) {
      const faults = ["zero price", "future timestamp", "stale", ...(reader === "TellorSpotSource" ? ["zero timestamp"] : [])];
      for (const fault of faults) {
        it(`${reader}: ${mode ? "recovery" : "challenge"} can leave ${fault} without serving it`, async function () {
          const [admin] = await ethers.getSigners();
          const queryId = ethers.id("reader-policy");
          const bank = await (await ethers.getContractFactory("TwapDataBankMock")).deploy();
          const Source = await ethers.getContractFactory(reader);
          const source = await Source.deploy(bank.target, queryId, 18, 60, ...(reader === "TellorTwapSource" ? [30000] : []));
          const other = await (await ethers.getContractFactory("PriceSourceMock")).deploy(queryId, 18);
          const stamp = BigInt(await time.latest()) * 1000n;
          async function configure(value, endMs) {
            const startMs = endMs >= 30000n ? endMs - 30000n : 0n;
            const start = [encode(value), 1, startMs, startMs, 1];
            const end = [encode(value), 1, endMs, endMs, 2];
            await bank.configureRecord(0, start); await bank.configureRecord(1, end);
            await bank.configureEnd(true, end);
            await bank.configureTwap(true, [value, 0, 1, startMs, endMs, 1], 0);
          }
          await configure(100, stamp);
          await other.configureRead(150, stamp, 0);
          const pair = mode ? [other.target, source.target] : [source.target, other.target];
          const s = await (await ethers.getContractFactory("TellorShepherd")).deploy(
            "ETH/USD", 18, ...pair, admin.address, 0, 300, 2000, [5, 7], 3600, true);
          if (mode) { await s.requestChallenge(); await time.increase(5); await s.executeChallenge(); }
          const value = fault === "zero price" ? 0 : 100;
          const timestamp = fault === "zero timestamp" ? 0n : fault === "future timestamp"
            ? stamp + 3_600_000n : fault === "stale" ? stamp - 7_200_000n : stamp;
          await configure(value, timestamp);
          expect(await source.getCurrentValue()).to.deep.equal([BigInt(value), timestamp]);
          for (const method of ["getCurrentValue", "latestRoundData", "validateSource"]) {
            await expect(s[method](...(method === "validateSource" ? [source.target] : [])))
              .to.be.revertedWithCustomError(s, "SourceNotUsable");
          }
          const kind = mode ? "Recovery" : "Challenge", delay = mode ? 7n : 5n;
          await s[`request${kind}`]();
          const requested = await s[`${kind.toLowerCase()}RequestedAt`]();
          await expect(s[`execute${kind}`]()).to.be.revertedWithCustomError(s, `${kind}DelayNotElapsed`);
          await time.setNextBlockTimestamp(requested + delay);
          await s[`execute${kind}`]();
          expect(await s.mode()).to.equal(1 - mode);
          expect(await s.getCurrentValue()).to.deep.equal([150n, stamp]);
          // The unusable source may be left, but must not be selected again.
          await expect(s[`request${mode ? "Challenge" : "Recovery"}`]())
            .to.be.revertedWithCustomError(s, mode ? "ChallengeNotAllowed" : "RecoveryNotAllowed");
        });
      }
    }
  }
});
