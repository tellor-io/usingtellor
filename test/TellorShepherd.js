const { time, loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

describe("TellorShepherd", function () {
  const abi = new ethers.AbiCoder();
  const queryId = h.hash(abi.encode(["string", "bytes"], ["SpotPrice", abi.encode(["string", "string"], ["eth", "usd"])]));
  const delay = 3600, adminDelay = 86400, roleDelay = 7200;

  async function fixture() {
    const [deployer, admin, pauser, overrider, keeper, stranger, nextAdmin] = await ethers.getSigners();
    const valset = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, valset.domainSeparator);
    await bridge.init(valset.powerThreshold, valset.timestamp, 1814400, valset.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target, 86400, 600, 43200);
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherd = await Shepherd.deploy(bank.target, admin.address, queryId, 1000, delay, adminDelay, adminDelay, adminDelay, adminDelay, adminDelay, roleDelay, adminDelay, [pauser.address], [overrider.address], [keeper.address], false);
    return { shepherd, bank, valset, admin, pauser, overrider, keeper, stranger, nextAdmin };
  }
  async function relay(bank, valset, value) {
    const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(queryId, abi.encode(["uint256"], [value]), valset);
    const tx = await bank.updateOracleData(attestData, currentValidatorSet, sigs);
    const receipt = await tx.wait();
    return { aggregateTimestamp: attestData.report.timestamp, relayTimestamp: (await ethers.provider.getBlock(receipt.blockNumber)).timestamp };
  }
  async function unpause(shepherd, admin) { await shepherd.connect(admin).proposeUnpause(); await time.increase(adminDelay); await shepherd.connect(admin).executeUnpause(); }

  it("configures one immutable feed and authorized retrieval", async function () {
    const { shepherd, keeper, stranger, pauser, overrider } = await loadFixture(fixture);
    expect(await shepherd.queryId()).to.equal(queryId);
    expect(await shepherd.pausers(pauser.address)).to.equal(true);
    expect(await shepherd.overriders(overrider.address)).to.equal(true);
    await expect(shepherd.connect(stranger).retrieveData()).to.be.revertedWith("Shepherd: not retriever");
    await expect(shepherd.connect(keeper).retrieveData()).to.be.revertedWith("Shepherd: no Tellor value");
  });

  it("delays normal data and checks deviations against the consumed value", async function () {
    const { shepherd, bank, valset, keeper } = await loadFixture(fixture);
    const p1 = h.toWei("2000"), p2 = h.toWei("2400");
    const first = await relay(bank, valset, p1);
    await time.increase(delay);
    await expect(shepherd.connect(keeper).retrieveData()).to.emit(shepherd, "OracleUpdated").withArgs(p1, first.aggregateTimestamp, first.relayTimestamp);
    await relay(bank, valset, p2);
    await time.increase(delay);
    await expect(shepherd.connect(keeper).retrieveData()).to.be.revertedWith("Shepherd: price deviation");
    expect((await shepherd.getCurrentValue())[0]).to.equal(p1);
  });

  it("lets any pauser halt reads and only delayed admin action restore them", async function () {
    const { shepherd, pauser, admin, keeper } = await loadFixture(fixture);
    await shepherd.connect(pauser).pause();
    await expect(shepherd.connect(keeper).retrieveData()).to.be.revertedWith("Shepherd: paused");
    await expect(shepherd.getCurrentValue()).to.be.revertedWith("Shepherd: paused");
    await expect(shepherd.connect(admin).executeUnpause()).to.be.revertedWith("Shepherd: no unpause proposal");
    await unpause(shepherd, admin);
    expect(await shepherd.paused()).to.equal(false);
  });

  it("uses a delayed override pipeline and newest eligible submission", async function () {
    const { shepherd, admin, pauser, overrider, keeper } = await loadFixture(fixture);
    await shepherd.connect(pauser).pause();
    await shepherd.connect(admin).proposeOverrideEntry();
    await time.increase(adminDelay);
    await shepherd.connect(admin).executeOverrideEntry(h.toWei("2000"));
    await time.increase(1);
    await shepherd.connect(overrider).submitOverride(h.toWei("2100"));
    await unpause(shepherd, admin);
    await time.increase(delay);
    await shepherd.connect(keeper).retrieveData();
    expect((await shepherd.getCurrentValue())[0]).to.equal(h.toWei("2100"));
    expect(await shepherd.overrideSubmissionCount()).to.equal(2);
  });

  it("recovers through delayed Tellor validation using the override as its anchor", async function () {
    const { shepherd, bank, valset, admin, pauser, overrider, keeper } = await loadFixture(fixture);
    await shepherd.connect(pauser).pause(); await shepherd.connect(admin).proposeOverrideEntry(); await time.increase(adminDelay); await shepherd.connect(admin).executeOverrideEntry(h.toWei("2000")); await unpause(shepherd, admin); await time.increase(delay); await shepherd.connect(keeper).retrieveData();
    const normal = await relay(bank, valset, h.toWei("2050"));
    await time.increase(delay);
    await shepherd.connect(admin).proposeOverrideExit();
    await time.increase(adminDelay);
    await expect(shepherd.connect(admin).executeOverrideExit()).to.emit(shepherd, "OverrideExited").withArgs(h.toWei("2050"), normal.aggregateTimestamp, normal.relayTimestamp);
    expect(await shepherd.overrideActive()).to.equal(false);
  });

  it("delays authority expansion and admin replacement, while removal is immediate", async function () {
    const { shepherd, admin, pauser, stranger, nextAdmin } = await loadFixture(fixture);
    await shepherd.connect(admin).proposePauser(stranger.address);
    await expect(shepherd.connect(stranger).executePauser(stranger.address)).to.be.revertedWith("Shepherd: role delay");
    await time.increase(roleDelay); await shepherd.connect(stranger).executePauser(stranger.address);
    await shepherd.connect(admin).removePauser(pauser.address);
    expect(await shepherd.pausers(pauser.address)).to.equal(false);
    await shepherd.connect(admin).proposeAdmin(nextAdmin.address);
    await time.increase(adminDelay); await shepherd.connect(nextAdmin).acceptAdmin();
    expect(await shepherd.admin()).to.equal(nextAdmin.address);
  });
});
