const { loadFixture, setCode, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

async function fixture() {
  const [admin, outsider] = await ethers.getSigners();
  const Source = await ethers.getContractFactory("PriceSourceMock");
  const primary = await Source.deploy(ethers.id("primary"), 8);
  const backup = await Source.deploy(ethers.id("backup"), 8);
  const candidate = await Source.deploy(ethers.id("unconfigured"), 8);
  const timestamp = BigInt(await time.latest() - 1) * 1000n + 17n;
  await primary.configureRead(100, timestamp, 0);
  await backup.configureRead(150, timestamp, 0);
  await candidate.configureRead(777, timestamp, 0);
  const s = await (await ethers.getContractFactory("TellorShepherd")).deploy(
    "ETH/USD", 8, primary.target, backup.target, admin.address, 10, 20, 2000, [5, 7], 60, true
  );
  return { s, primary, backup, candidate, timestamp, admin, outsider };
}

async function state(s) {
  const fields = ["admin", "mode", "paused", "pausedAt", "primarySource", "backupSource",
    "challengePending", "challengeRequestedAt", "recoveryPending", "recoveryRequestedAt",
    "pendingPrimarySource", "pendingBackupSource", "sourcesProposedAt", "pendingAdmin", "adminProposedAt"];
  return Promise.all(fields.map(field => s[field]()));
}

describe("TellorShepherd - Manual source validation", function () {
  for (const mode of [0, 1]) {
    for (const paused of [false, true]) {
      it(`allows an outsider to inspect an unconfigured candidate in mode ${mode}, paused=${paused}`, async function () {
        const { s, primary, backup, candidate, timestamp, outsider } = await loadFixture(fixture);
        if (mode) {
          await s.requestChallenge(); await time.increase(5); await s.executeChallenge();
          await backup.configureRead(100, timestamp, 0);
          await s.requestRecovery();
        } else await s.requestChallenge();
        await s.proposeAdminChange(outsider.address);
        await s.proposeSourcesChange(candidate.target, backup.target);
        if (paused) await s.pause();
        // Candidate inspection must not consult either configured source.
        await primary.configureRead(0, 0, 1);
        await backup.configureRead(0, 0, 1);
        const before = await state(s);
        expect(await s.connect(outsider).validateSource(candidate.target)).to.deep.equal([777n, timestamp]);
        await candidate.configureRead(0, timestamp, 0);
        await expect(s.connect(outsider).validateSource(candidate.target)).to.be.revertedWithCustomError(s, "SourceNotUsable");
        expect(await state(s)).to.deep.equal(before);
        await expect(s.getCurrentValue()).to.be.revertedWithCustomError(s, paused ? "ShepherdPaused" : "SourceNotUsable");
      });
    }
  }

  it("exposes a view ABI and accepts both configured sources", async function () {
    const { s, primary, backup, timestamp } = await loadFixture(fixture);
    expect(s.interface.getFunction("validateSource").stateMutability).to.equal("view");
    expect(await s.validateSource(primary.target)).to.deep.equal([100n, timestamp]);
    expect(await s.validateSource(backup.target)).to.deep.equal([150n, timestamp]);
  });

  it("accepts sources without a query ID and preserves full-width prices and original milliseconds", async function () {
    const { s, timestamp } = await loadFixture(fixture);
    const candidate = await (await ethers.getContractFactory("PriceSourceWithoutQueryIdMock"))
      .deploy(8, ethers.MaxUint256, timestamp);
    expect(await s.validateSource(candidate.target)).to.deep.equal([ethers.MaxUint256, timestamp]);
  });

  it("rejects zero and EOA addresses", async function () {
    const { s, outsider } = await loadFixture(fixture);
    for (const address of [ethers.ZeroAddress, outsider.address]) {
      await expect(s.validateSource(address)).to.be.revertedWithCustomError(s, "SourceHasNoCode");
    }
  });

  it("checks matching decimals before attempting a price read", async function () {
    const { s, candidate } = await loadFixture(fixture);
    await candidate.configureMetadata(ethers.ZeroHash, 9);
    await candidate.configureRead(0, 0, 1);
    await expect(s.validateSource(candidate.target)).to.be.revertedWithCustomError(s, "SourceDecimalsMismatch");
  });

  for (const code of ["0x60006000fd", "0x60006000f3"]) {
    it(`rejects reverting or malformed metadata: ${code}`, async function () {
      const { s, candidate } = await loadFixture(fixture);
      await setCode(candidate.target, code);
      await expect(s.validateSource(candidate.target)).to.be.reverted;
    });
  }

  for (const fault of ["zero price", "zero timestamp", "future timestamp", "revert", "malformed"]) {
    it(`rejects a candidate with ${fault}`, async function () {
      const { s, candidate, timestamp } = await loadFixture(fixture);
      const future = BigInt(await time.latest() + 1) * 1000n + 1n;
      await candidate.configureRead(fault === "zero price" ? 0 : 123,
        fault === "zero timestamp" ? 0 : fault === "future timestamp" ? future : timestamp,
        fault === "revert" ? 1 : fault === "malformed" ? 2 : 0);
      if (fault === "malformed") await expect(s.validateSource(candidate.target)).to.be.reverted;
      else await expect(s.validateSource(candidate.target)).to.be.revertedWithCustomError(s, "SourceNotUsable");
    });
  }

  for (const excess of [-1, 0, 1]) {
    it(`checks the instance age limit at 60 seconds ${excess >= 0 ? "+" : ""}${excess}ms`, async function () {
      const { s, candidate } = await loadFixture(fixture);
      const readAt = await time.latest() + 10;
      const timestamp = BigInt(readAt * 1000 - 60000 - excess);
      await candidate.configureRead(123, timestamp, 0);
      await time.increaseTo(readAt);
      if (excess > 0) await expect(s.validateSource(candidate.target)).to.be.revertedWithCustomError(s, "SourceNotUsable");
      else expect(await s.validateSource(candidate.target)).to.deep.equal([123n, timestamp]);
    });
  }
});
