const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

// This short common age is a test input, not a recommended deployment setting.
async function fixture() {
  const [admin] = await ethers.getSigners();
  const queryId = ethers.id("shared-freshness");
  const Source = await ethers.getContractFactory("PriceSourceMock");
  const sources = [await Source.deploy(queryId, 8), await Source.deploy(queryId, 8)];
  const timestamp = BigInt(await time.latest()) * 1000n;
  await sources[0].configureRead(100, timestamp, 0);
  await sources[1].configureRead(150, timestamp, 0);
  const Shepherd = await ethers.getContractFactory("TellorShepherdHarness");
  const args = [queryId, 8, sources[0].target, sources[1].target, admin.address,
    10, 20, 2000, [5, 7], 60, true];
  const s = await Shepherd.deploy(...args);
  return { admin, queryId, Source, sources, timestamp, Shepherd, args, s };
}

async function state(s) {
  return Promise.all([s.mode(), s.paused(), s.pausedAt(), s.challengePending(),
    s.challengeRequestedAt(), s.recoveryPending(), s.recoveryRequestedAt()]);
}

describe("TellorShepherd - Immutable shared freshness", function () {
  for (const invalid of [0n, ethers.MaxUint256 / 1000n + 1n]) {
    it(`rejects age ${invalid} before conversion`, async function () {
      const f = await loadFixture(fixture);
      const args = [...f.args]; args[9] = invalid;
      await expect(f.Shepherd.deploy(...args)).to.be.revertedWithCustomError(f.Shepherd, "InvalidMaxAge");
    });
  }
  for (const role of [0, 1]) {
    for (const excessMs of [-1, 0, 1]) {
      it(`role ${role}: age limit ${excessMs >= 0 ? "+" : ""}${excessMs}ms`, async function () {
        const f = await loadFixture(fixture);
        await f.s.setModeForTest(role);
        const readAt = await time.latest() + 10;
        const timestamp = BigInt(readAt * 1000 - 60000 - excessMs);
        await f.sources[role].configureRead(123, timestamp, 0);
        await time.increaseTo(readAt);
        const before = await state(f.s);
        if (excessMs > 0) await expect(f.s.getCurrentValue()).to.be.revertedWithCustomError(f.s, "StalePrice");
        else {
          expect(await f.s.getCurrentValue()).to.deep.equal([123n, timestamp]);
          expect(await f.s.getCurrentValue()).to.deep.equal([123n, timestamp]);
        }
        expect(await state(f.s)).to.deep.equal(before);
      });
    }
    it(`role ${role}: stale unselected data does not block selected reads`, async function () {
      const f = await loadFixture(fixture);
      await f.s.setModeForTest(role);
      await f.sources[1 - role].configureRead(999, f.timestamp - 61000n, 0);
      const pair = await f.sources[role].getCurrentValue();
      expect(await f.s.getCurrentValue()).to.deep.equal(pair);
      // The same pair cannot authorize a transition assessment.
      await expect(f.s.readDeviation()).to.be.revertedWithCustomError(f.s, "StalePrice");
      expect(await f.s.mode()).to.equal(role);
    });
  }

  it("accepts one second and the largest safely convertible second count", async function () {
    const f = await loadFixture(fixture);
    const largest = ethers.MaxUint256 / 1000n;
    for (const age of [1n, largest]) {
      const args = [...f.args]; args[9] = age;
      const s = await f.Shepherd.deploy(...args);
      expect(await s.MAX_DATA_AGE()).to.equal(age);
      // Exercise the multiplication on a read, including the uint256 boundary.
      const stamp = BigInt(await time.latest() + 1) * 1000n;
      await f.sources[0].configureRead(100, stamp, 0);
      expect(await s.getCurrentValue()).to.deep.equal([100n, stamp]);
    }
  });

  it("applies the common limit when both slots share one source address", async function () {
    const f = await loadFixture(fixture);
    const args = [...f.args]; args[3] = args[2];
    const s = await f.Shepherd.deploy(...args);
    for (const role of [0, 1]) {
      await s.setModeForTest(role);
      expect(await s.getCurrentValue()).to.deep.equal([100n, f.timestamp]);
    }
    expect(await s.readDeviation()).to.equal(false);
    await time.increaseTo(f.timestamp / 1000n + 61n);
    for (const role of [0, 1]) {
      await s.setModeForTest(role);
      await expect(s.getCurrentValue()).to.be.revertedWithCustomError(s, "StalePrice");
    }
    await expect(s.readDeviation()).to.be.revertedWithCustomError(s, "StalePrice");
  });

  // All six actions must apply the common limit to both sources, even during pause. staticCall checks
  // exact age equality without consuming the pending request before the refusal case.
  for (const kind of ["Challenge", "Recovery"]) {
    const mode = kind === "Challenge" ? 0 : 1;
    for (const phase of ["request", "execute", "cancel"]) {
      for (const role of [0, 1]) {
        for (const paused of [false, true]) {
          it(`${phase}${kind}: role ${role} equality succeeds, +1ms refuses and preserves state; paused=${paused}`, async function () {
            const f = await loadFixture(fixture), s = f.s;
            await s.setModeForTest(mode);
            const eligible = mode ? 100 : 150;
            await f.sources[1].configureRead(eligible, f.timestamp, 0);
            if (phase !== "request") await s[`request${kind}`]();
            if (paused) await s.pause();
            const values = [100, phase === "cancel" ? (mode ? 150 : 100) : eligible];
            const at = await time.latest() + 20; // Both transition waits have elapsed.
            const limit = 60000;
            await f.sources[1 - role].configureRead(values[1 - role], (at - 1) * 1000, 0);
            await f.sources[role].configureRead(values[role], at * 1000 - limit, 0);
            await time.increaseTo(at);
            const before = await state(s);
            await expect(s[`${phase}${kind}`].staticCall()).not.to.be.reverted;
            const refusalAt = at + 10;
            await f.sources[role].configureRead(values[role], refusalAt * 1000 - limit - 1, 0);
            await time.setNextBlockTimestamp(refusalAt);
            await expect(s[`${phase}${kind}`]()).to.be.revertedWithCustomError(s, "StalePrice");
            expect(await state(s)).to.deep.equal(before);
          });
        }
      }
    }
  }

  it("pause and unpause never renew an observation", async function () {
    const f = await loadFixture(fixture);
    await f.s.pause();
    await time.increase(61);
    await f.s.unpause();
    expect(await f.sources[0].getCurrentValue()).to.deep.equal([100n, f.timestamp]);
    await expect(f.s.getCurrentValue()).to.be.revertedWithCustomError(f.s, "StalePrice");
  });

  it("a real switch and repeated reads preserve observation time and pending clocks", async function () {
    const f = await loadFixture(fixture);
    await f.s.requestChallenge();
    const requestedAt = await f.s.challengeRequestedAt();
    expect(await f.s.getCurrentValue()).to.deep.equal([100n, f.timestamp]);
    expect(await f.s.challengeRequestedAt()).to.equal(requestedAt);
    await time.setNextBlockTimestamp(requestedAt + 5n);
    await f.s.executeChallenge();
    expect(await f.s.getCurrentValue()).to.deep.equal([150n, f.timestamp]);
    expect(await f.s.getCurrentValue()).to.deep.equal([150n, f.timestamp]);
    await time.increaseTo(f.timestamp / 1000n + 61n);
    await expect(f.s.getCurrentValue()).to.be.revertedWithCustomError(f.s, "StalePrice");
    expect(await f.s.mode()).to.equal(1);
  });

  it("migration preserves the common limit and never renews replacement timestamps", async function () {
    const f = await loadFixture(fixture);
    const replacements = [await f.Source.deploy(f.queryId, 8), await f.Source.deploy(f.queryId, 8)];
    const stamp = BigInt(await time.latest() - 65) * 1000n + 17n;
    for (const source of replacements) await source.configureRead(111, stamp, 0);
    await f.s.pause();
    const pauseClock = await f.s.pausedAt();
    await f.s.proposeSourcesChange(...replacements.map(source => source.target));
    await time.increase(20);
    await f.s.executeSourcesChange(); // Metadata-only migration permits stale history.
    expect(await f.s.pausedAt()).to.equal(pauseClock);
    expect(await f.s.MAX_DATA_AGE()).to.equal(60);
    await f.s.unpause();
    for (const role of [0, 1]) {
      await f.s.setModeForTest(role);
      expect(await replacements[role].getCurrentValue()).to.deep.equal([111n, stamp]);
      await expect(f.s.getCurrentValue()).to.be.revertedWithCustomError(f.s, "StalePrice");
    }
  });
});
