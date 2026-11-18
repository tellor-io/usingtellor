const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

async function fixture() {
  const [admin] = await ethers.getSigners();
  const Source = await ethers.getContractFactory("GasConsumingSourceMock");
  const primary = await Source.deploy(), backup = await Source.deploy();
  const s = await (await ethers.getContractFactory("TellorShepherd")).deploy(
    "ETH/USD", 18, primary.target, backup.target, admin.address, 0, 300, 2000, [30, 90], 3600, true
  );
  const timestamp = BigInt(await time.latest()) * 1000n;
  await primary.configure(100, timestamp, 0);
  await backup.configure(150, timestamp, 0);
  return { s, primary, backup, timestamp };
}

describe("TellorShepherd - Source call gas failures", function () {
  it("allows reads above the former 500,000 gas cap and propagates insufficient-gas failures", async function () {
    const { s, primary, timestamp } = await loadFixture(fixture);
    await primary.configure(100, timestamp, 600_000);
    for (const method of ["getCurrentValue", "latestRoundData", "validateSource"]) {
      const args = method === "validateSource" ? [primary.target] : [];
      await expect(s[method](...args, { gasLimit: 300_000 })).to.be.reverted;
      const result = await s[method](...args, { gasLimit: 1_000_000 });
      expect(result).to.deep.equal(method === "latestRoundData"
        ? [0n, 100n, 0n, timestamp / 1000n, 0n] : [100n, timestamp]);
    }
  });

  it("does not promise gas-independent output from a gas-sensitive source", async function () {
    const { s, primary, timestamp } = await loadFixture(fixture);
    await primary.configure(0, timestamp, 0); // This mock returns entry gas as its price.
    const low = await s.validateSource(primary.target, { gasLimit: 200_000 });
    const high = await s.validateSource(primary.target, { gasLimit: 1_000_000 });
    expect(high[0]).to.be.greaterThan(low[0]);
  });

  for (const kind of ["Challenge", "Recovery"]) {
    for (const side of ["primary", "backup"]) {
      for (const action of ["execute", "cancel"]) {
        it(`${kind}: starving ${side} reverts request and ${action} without changing state`, async function () {
          const f = await loadFixture(fixture), s = f.s;
          const mode = kind === "Recovery" ? 1 : 0;
          const prefix = kind.toLowerCase();
          if (mode) {
            await s.requestChallenge(); await time.increase(30); await s.executeChallenge();
          }
          async function configure(eligible) {
            await f.primary.configure(100, f.timestamp, side === "primary" ? 200_000 : 0);
            await f.backup.configure((eligible === !mode) ? 150 : 100, f.timestamp, side === "backup" ? 200_000 : 0);
          }
          await configure(true);
          await expect(s[`request${kind}`]({ gasLimit: 150_000 })).to.be.reverted;
          expect(await s[`${prefix}Pending`]()).to.equal(false);
          expect(await s[`${prefix}RequestedAt`]()).to.equal(0);
          await s[`request${kind}`]({ gasLimit: 1_000_000 });
          const started = await s[`${prefix}RequestedAt`]();
          if (action === "cancel") await configure(false);
          await time.increase(mode ? 90 : 30);
          await expect(s[`${action}${kind}`]({ gasLimit: 150_000 })).to.be.reverted;
          expect(await s[`${prefix}Pending`]()).to.equal(true);
          expect(await s[`${prefix}RequestedAt`]()).to.equal(started);
          expect(await s.mode()).to.equal(mode);
          await s[`${action}${kind}`]({ gasLimit: 1_000_000 });
          expect(await s[`${prefix}Pending`]()).to.equal(false);
          expect(await s[`${prefix}RequestedAt`]()).to.equal(0);
          expect(await s.mode()).to.equal(action === "execute" ? 1 - mode : mode);
        });
      }
    }
  }
});
