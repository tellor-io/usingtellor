const { loadFixture, time, mine } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers, network } = require("hardhat");

describe("StreamBackupOracle - Trusted example", function () {
  async function fixture() {
    const [deployer, admin, streamer, outsider] = await ethers.getSigners();
    const queryId = ethers.id("stream-example-feed");
    const Stream = await ethers.getContractFactory("StreamBackupOracle");
    const stream = await Stream.deploy(admin.address, streamer.address, 60);
    return { deployer, admin, streamer, outsider, queryId, Stream, stream };
  }
  async function submit(f, value) {
    await f.stream.connect(f.streamer).submitValue(f.queryId, value);
    return BigInt(await time.latest());
  }
  it("binds configuration and rejects zero constructor inputs", async function () {
    const f = await loadFixture(fixture);
    expect(await f.stream.admin()).to.equal(f.admin.address);
    expect(await f.stream.READ_DELAY_SECONDS()).to.equal(60);
    expect(await f.stream.isStreamer(f.streamer.address)).to.equal(true);
    const args = [f.admin.address, f.streamer.address, 60];
    for (const [index, value, error] of [[0, ethers.ZeroAddress, "InvalidAddress"], [1, ethers.ZeroAddress, "InvalidAddress"], [2, 0, "InvalidReadDelay"]]) {
      const invalid = [...args]; invalid[index] = value;
      await expect(f.Stream.deploy(...invalid)).to.be.revertedWithCustomError(f.stream, error);
    }
  });
  it("authenticates authorship and permits admin self-appointment without editing history", async function () {
    const f = await loadFixture(fixture);
    for (const caller of [f.deployer, f.admin, f.outsider]) {
      await expect(f.stream.connect(caller).submitValue(f.queryId, 100)).to.be.revertedWithCustomError(f.stream, "NotStreamer");
      expect(await f.stream.isStreamer(caller.address)).to.equal(false);
    }
    await expect(f.stream.connect(f.streamer).setStreamer(f.outsider.address, true)).to.be.revertedWithCustomError(f.stream, "NotAdmin");
    await expect(f.stream.connect(f.admin).setStreamer(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(f.stream, "InvalidAddress");
    await expect(f.stream.connect(f.admin).setStreamer(f.streamer.address, true)).to.be.revertedWithCustomError(f.stream, "StreamerUnchanged");
    await expect(f.stream.connect(f.admin).setStreamer(f.admin.address, true)).to.emit(f.stream, "StreamerChanged").withArgs(f.admin.address, true);
    await f.stream.connect(f.admin).submitValue(f.queryId, 123);
    await f.stream.connect(f.admin).setStreamer(f.admin.address, false);
    await expect(f.stream.connect(f.admin).submitValue(f.queryId, 456)).to.be.revertedWithCustomError(f.stream, "NotStreamer");
    expect((await f.stream.reports(f.queryId, 0)).value).to.equal(123);
  });
  it("rejects zero feed IDs, zero prices and truncated ABI without appending", async function () {
    const f = await loadFixture(fixture);
    await expect(f.stream.connect(f.streamer).submitValue(ethers.ZeroHash, 100)).to.be.revertedWithCustomError(f.stream, "InvalidQueryId");
    await expect(f.stream.connect(f.streamer).submitValue(f.queryId, 0)).to.be.revertedWithCustomError(f.stream, "ZeroValue");
    const data = f.stream.interface.encodeFunctionData("submitValue", [f.queryId, 100]);
    await expect(f.streamer.sendTransaction({ to: f.stream.target, data: data.slice(0, -2) })).to.be.reverted;
    expect(await f.stream.reportCount(f.queryId)).to.equal(0);
  });
  it("uses submission time, accepts exact maturity, and preserves timestamps on repeated reads", async function () {
    const f = await loadFixture(fixture);
    await expect(f.stream.getCurrentValue(f.queryId)).to.be.revertedWithCustomError(f.stream, "NoUsableReport");
    const at = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(at);
    await expect(f.stream.connect(f.streamer).submitValue(f.queryId, ethers.MaxUint256))
      .to.emit(f.stream, "ReportSubmitted").withArgs(f.queryId, 0, f.streamer.address, ethers.MaxUint256, at);
    expect(await f.stream.reports(f.queryId, 0)).to.deep.equal([ethers.MaxUint256, BigInt(at), f.streamer.address]);
    await time.increaseTo(at + 59);
    await expect(f.stream.getCurrentValue(f.queryId)).to.be.revertedWithCustomError(f.stream, "NoUsableReport");
    await time.increase(1);
    expect(await f.stream.getCurrentValue(f.queryId)).to.deep.equal([ethers.MaxUint256, BigInt(at) * 1000n]);
    await time.increase(1000);
    expect((await f.stream.getCurrentValue(f.queryId))[1]).to.equal(BigInt(at) * 1000n);
    const huge = await f.Stream.deploy(f.admin.address, f.streamer.address, ethers.MaxUint256);
    await expect(huge.getCurrentValue(f.queryId)).to.be.revertedWithCustomError(huge, "NoUsableReport");
  });
  it("skips immature and permanently disputed reports, including disputes after maturity", async function () {
    const f = await loadFixture(fixture);
    const first = await submit(f, 100);
    await time.increase(60);
    const second = await submit(f, 200);
    expect(await f.stream.getCurrentValue(f.queryId)).to.deep.equal([100n, first * 1000n]);
    await time.increaseTo(second + 60n);
    expect((await f.stream.getCurrentValue(f.queryId))[0]).to.equal(200);
    await expect(f.stream.connect(f.outsider).disputeValue(f.queryId, 1)).to.be.revertedWithCustomError(f.stream, "NotAdmin");
    await expect(f.stream.connect(f.admin).disputeValue(f.queryId, 2)).to.be.revertedWithCustomError(f.stream, "InvalidReportIndex");
    await expect(f.stream.connect(f.admin).disputeValue(f.queryId, 1)).to.emit(f.stream, "ReportDisputed").withArgs(f.queryId, 1);
    expect(await f.stream.getCurrentValue(f.queryId)).to.deep.equal([100n, first * 1000n]);
    expect((await f.stream.reports(f.queryId, 1)).value).to.equal(200);
    await expect(f.stream.connect(f.admin).disputeValue(f.queryId, 1)).to.be.revertedWithCustomError(f.stream, "AlreadyDisputed");
    await f.stream.connect(f.admin).disputeValue(f.queryId, 0);
    await expect(f.stream.getCurrentValue(f.queryId)).to.be.revertedWithCustomError(f.stream, "NoUsableReport");
    await submit(f, 300);
    await f.stream.connect(f.admin).disputeValue(f.queryId, 2); // Before maturity also excludes permanently.
    await time.increase(60);
    await expect(f.stream.getCurrentValue(f.queryId)).to.be.revertedWithCustomError(f.stream, "NoUsableReport");
  });
  it("selects the last same-block report by index", async function () {
    const f = await loadFixture(fixture);
    const nonce = await f.streamer.getNonce();
    await network.provider.send("evm_setAutomine", [false]);
    try {
      const a = await f.stream.connect(f.streamer).submitValue(f.queryId, 100, { nonce, gasLimit: 300000 });
      const b = await f.stream.connect(f.streamer).submitValue(f.queryId, 200, { nonce: nonce + 1, gasLimit: 300000 });
      await mine(); await a.wait(); await b.wait();
    } finally { await network.provider.send("evm_setAutomine", [true]); }
    expect((await f.stream.reports(f.queryId, 0)).submittedAt).to.equal((await f.stream.reports(f.queryId, 1)).submittedAt);
    await time.increase(60);
    expect((await f.stream.getCurrentValue(f.queryId))[0]).to.equal(200);
    await f.stream.connect(f.admin).disputeValue(f.queryId, 1);
    expect((await f.stream.getCurrentValue(f.queryId))[0]).to.equal(100);
  });
  it("enforces the 32-report bound and resumes when a new usable report matures", async function () {
    const f = await loadFixture(fixture);
    const other = ethers.id("feed-outside-bounded-search");
    await f.stream.connect(f.streamer).submitValue(other, 222);
    await submit(f, 100);
    for (let i = 1; i < 32; i++) {
      await submit(f, 100 + i);
      await f.stream.connect(f.admin).disputeValue(f.queryId, i);
    }
    await time.increase(60);
    expect((await f.stream.getCurrentValue(f.queryId))[0]).to.equal(100); // 32nd inspected record.
    await submit(f, 999);
    await f.stream.connect(f.admin).disputeValue(f.queryId, 32);
    await time.increase(60);
    await expect(f.stream.getCurrentValue(f.queryId)).to.be.revertedWithCustomError(f.stream, "NoUsableReport");
    expect((await f.stream.getCurrentValue(other))[0]).to.equal(222);
    const fresh = await submit(f, 555);
    await time.increase(60);
    expect(await f.stream.getCurrentValue(f.queryId)).to.deep.equal([555n, fresh * 1000n]);
  });
  it("uses only admin recovery permission, independently of reports and read availability", async function () {
    const f = await loadFixture(fixture);
    expect(await f.stream.canRecover(f.queryId)).to.equal(false);
    expect(await f.stream.canRecover(ethers.ZeroHash)).to.equal(false);
    await expect(f.stream.connect(f.streamer).setCanRecover(f.queryId, true)).to.be.revertedWithCustomError(f.stream, "NotAdmin");
    await expect(f.stream.connect(f.admin).setCanRecover(ethers.ZeroHash, true)).to.be.revertedWithCustomError(f.stream, "InvalidQueryId");
    await expect(f.stream.connect(f.admin).setCanRecover(f.queryId, true)).to.emit(f.stream, "RecoveryPermissionChanged").withArgs(f.queryId, true);
    expect(await f.stream.canRecover(f.queryId)).to.equal(true);
    await expect(f.stream.getCurrentValue(f.queryId)).to.be.revertedWithCustomError(f.stream, "NoUsableReport");
    await f.stream.connect(f.admin).setCanRecover(f.queryId, false);
    expect(await f.stream.canRecover(f.queryId)).to.equal(false);
  });

  it("isolates history, maturity, disputes, and recovery by feed while sharing streamer authority", async function () {
    const f = await loadFixture(fixture);
    const other = ethers.id("second-stream-feed");
    const absent = ethers.id("unreported-feed");
    const firstAt = await submit(f, 100);
    await time.increase(60);
    await f.stream.connect(f.streamer).submitValue(other, 200);
    const otherAt = BigInt(await time.latest());
    expect(await f.stream.reportCount(f.queryId)).to.equal(1);
    expect(await f.stream.reportCount(other)).to.equal(1);
    expect(await f.stream.reportCount(absent)).to.equal(0);
    expect(await f.stream.getCurrentValue(f.queryId)).to.deep.equal([100n, firstAt * 1000n]);
    await expect(f.stream.getCurrentValue(other)).to.be.revertedWithCustomError(f.stream, "NoUsableReport");
    await expect(f.stream.getCurrentValue(absent)).to.be.revertedWithCustomError(f.stream, "NoUsableReport");
    await time.increaseTo(otherAt + 60n);
    await f.stream.connect(f.admin).disputeValue(f.queryId, 0);
    expect(await f.stream.isDisputed(f.queryId, 0)).to.equal(true);
    expect(await f.stream.isDisputed(other, 0)).to.equal(false);
    await expect(f.stream.getCurrentValue(f.queryId)).to.be.revertedWithCustomError(f.stream, "NoUsableReport");
    expect(await f.stream.getCurrentValue(other)).to.deep.equal([200n, otherAt * 1000n]);
    await f.stream.connect(f.admin).setCanRecover(f.queryId, true);
    expect(await f.stream.canRecover(f.queryId)).to.equal(true);
    expect(await f.stream.canRecover(other)).to.equal(false);
    expect(await f.stream.canRecover(absent)).to.equal(false);
    await f.stream.connect(f.admin).setCanRecover(other, true);
    await f.stream.connect(f.admin).setCanRecover(f.queryId, false);
    expect(await f.stream.canRecover(other)).to.equal(true);
    // Revocation is deliberately global, unlike report and recovery state.
    await f.stream.connect(f.admin).setStreamer(f.streamer.address, false);
    for (const id of [f.queryId, other]) {
      await expect(f.stream.connect(f.streamer).submitValue(id, 300)).to.be.revertedWithCustomError(f.stream, "NotStreamer");
    }
  });
});
