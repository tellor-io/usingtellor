const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Backup oracle interface and test double", function () {
  const Normal = 0, Revert = 1, Malformed = 2;

  async function deployFixture() {
    const queryId = ethers.id("backup-test-feed");
    const Mock = await ethers.getContractFactory("BackupOracleMock");
    const mock = await Mock.deploy(queryId);
    const backup = await ethers.getContractAt("IBackupOracle", mock.target);
    return { queryId, mock, backup };
  }

  it("identifies its feed, starts unavailable, and defaults to no recovery", async function () {
    const { queryId, mock, backup } = await loadFixture(deployFixture);
    expect(await mock.queryId()).to.equal(queryId);
    await expect(backup.getCurrentValue(queryId)).to.be.revertedWithCustomError(mock, "ReadUnavailable");
    expect(await backup.canRecover(queryId)).to.equal(false);
  });

  it("preserves price and millisecond observation time as the observation becomes stale", async function () {
    const { queryId, mock, backup } = await loadFixture(deployFixture);
    const observation = BigInt(await time.latest() - 10) * 1000n + 123n;
    const price = ethers.parseEther("2000");
    await mock.configureRead(price, observation, Normal);
    expect(await backup.getCurrentValue(queryId)).to.deep.equal([price, observation]);
    await time.increase(7 * 86400);
    expect(await backup.getCurrentValue(queryId)).to.deep.equal([price, observation]);
  });

  it("can supply zero prices and zero/future timestamps for downstream validation tests", async function () {
    const { queryId, mock, backup } = await loadFixture(deployFixture);
    for (const [value, timestamp] of [[0n, 1000n], [1n, 0n], [ethers.MaxUint256, ethers.MaxUint256]]) {
      await mock.configureRead(value, timestamp, Normal);
      expect(await backup.getCurrentValue(queryId)).to.deep.equal([value, timestamp]);
    }
  });

  it("exposes recovery false/true and dependency failure through the query-ID-only ABI", async function () {
    const { queryId, mock, backup } = await loadFixture(deployFixture);
    await mock.configureRecovery(true, Normal);
    expect(await backup.canRecover(queryId)).to.equal(true);
    // Read availability and recovery assessment are independent test controls.
    await expect(backup.getCurrentValue(queryId)).to.be.revertedWithCustomError(mock, "ReadUnavailable");
    await mock.configureRecovery(false, Normal);
    expect(await backup.canRecover(queryId)).to.equal(false);
    await mock.configureRead(100, 123456, Normal);
    await mock.configureRecovery(true, Revert);
    await expect(backup.canRecover(queryId)).to.be.revertedWithCustomError(mock, "RecoveryUnavailable");
    expect(await backup.getCurrentValue(queryId)).to.deep.equal([100n, 123456n]);
  });

  it("rejects other feeds even when recovery is enabled", async function () {
    const { queryId, mock, backup } = await loadFixture(deployFixture);
    await mock.configureRecovery(true, Normal);
    for (const wrongId of [ethers.ZeroHash, ethers.id("another-feed")]) {
      await mock.configureRead(100, 123456, Normal);
      await expect(backup.getCurrentValue(wrongId)).to.be.revertedWithCustomError(mock, "UnsupportedQueryId");
      await expect(backup.canRecover(wrongId)).to.be.revertedWithCustomError(mock, "UnsupportedQueryId");
    }
  });

  it("can make an available read fail without silently returning the configured price", async function () {
    const { queryId, mock, backup } = await loadFixture(deployFixture);
    await mock.configureRead(100, 123456, Normal);
    await mock.configureRead(100, 123456, Revert);
    await expect(backup.getCurrentValue(queryId)).to.be.revertedWithCustomError(mock, "ReadUnavailable");
  });

  it("injects successful calls with undecodable read and recovery responses", async function () {
    const { queryId, mock, backup } = await loadFixture(deployFixture);
    await mock.configureRead(100, 123456, Malformed);
    await mock.configureRecovery(true, Malformed);
    for (const [method, args] of [["getCurrentValue", [queryId]], ["canRecover", [queryId]]]) {
      const data = backup.interface.encodeFunctionData(method, args);
      const raw = await ethers.provider.call({ to: mock.target, data });
      expect(raw).to.equal("0x");
      expect(() => backup.interface.decodeFunctionResult(method, raw)).to.throw();
    }
  });
});
