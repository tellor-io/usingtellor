const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

async function fixture() {
  const [admin] = await ethers.getSigners();
  const Source = await ethers.getContractFactory("GasConsumingSourceMock");
  const primary = await Source.deploy();
  const backup = await Source.deploy();
  const s = await (await ethers.getContractFactory("TellorShepherd")).deploy(
    "ETH/USD", 18, primary.target, backup.target, admin.address, 0, 300, 2000, [30, 90], 3600, true
  );
  const timestamp = BigInt(await time.latest()) * 1000n;
  return { s, primary, timestamp, budget: await s.SOURCE_READ_GAS() };
}

describe("TellorShepherd - Source read gas budget", function () {
  it("forwards exactly SOURCE_READ_GAS or reverts, whatever gas the caller supplies", async function () {
    const { s, primary, timestamp, budget } = await loadFixture(fixture);
    await primary.configure(0, timestamp, 0); // report the gas received at entry
    const received = new Set();
    const failures = new Set();
    for (let gasLimit = Number(budget); gasLimit <= Number(budget) + 60_000; gasLimit += 100) {
      try {
        received.add((await s.validateSource(primary.target, { gasLimit }))[0]);
      } catch (error) {
        failures.add(error.data && error.data !== "0x" ? s.interface.parseError(error.data).name : "out of gas");
      }
    }
    // Starving the source would yield varying entry gas or SourceNotUsable; neither may occur.
    expect(received.size).to.equal(1);
    const [entryGas] = received;
    expect(entryGas).to.be.within(budget - 1_000n, budget);
    expect(failures).to.include("InsufficientGasForSourceRead");
    expect(failures).to.not.include("SourceNotUsable");
  });

  it("treats a source needing more than SOURCE_READ_GAS as unusable for every caller", async function () {
    const { s, primary, timestamp, budget } = await loadFixture(fixture);
    await primary.configure(100, timestamp, budget - 20_000n);
    expect(await s.getCurrentValue()).to.deep.equal([100n, timestamp]);
    await primary.configure(100, timestamp, budget + 1n);
    for (const gasLimit of [1_000_000, 10_000_000]) {
      await expect(s.getCurrentValue({ gasLimit })).to.be.revertedWithCustomError(s, "SourceNotUsable");
    }
  });
});
