const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TellorShepherdFactory", function () {
  async function deployFixture() {
    const [deployer, caller, admin, otherAdmin] = await ethers.getSigners();
    const queryId = ethers.id("factory-feed");
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(deployer.address);
    const Factory = await ethers.getContractFactory("TellorShepherdFactory");
    const factory = await Factory.deploy();
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const primary = await (await ethers.getContractFactory("TellorTwapSource")).deploy(bank.target, queryId, 8, 61, 30001);
    const backup = await (await ethers.getContractFactory("TellorSpotSource")).deploy(bank.target, queryId, 8, 61);
    // One challenge second is permitted despite the 30001ms TWAP window.
    // Timing suitability is deliberately the deployer/admin responsibility.
    const configuration = {
      queryId, decimals: 8, primarySource: primary.target, backupSource: backup.target, admin: admin.address,
      minPauseDuration: 122n, configChangeDelay: 303n,
      challengeThresholdBps: 2005n,
      challengeDelaySeconds: 1n, recoveryDelaySeconds: 97n,
      maxDataAge: 3600n,
    };
    return { deployer, caller, admin, otherAdmin, bank, primary, backup, Factory, factory, Shepherd, configuration };
  }

  function constructorArgs(c) {
    return [c.queryId, c.decimals, c.primarySource, c.backupSource, c.admin,
      c.minPauseDuration, c.configChangeDelay, c.challengeThresholdBps,
      [c.challengeDelaySeconds, c.recoveryDelaySeconds], c.maxDataAge];
  }

  async function create(factory, caller, configuration) {
    const address = await factory.connect(caller).createShepherd.staticCall(configuration);
    const tx = await factory.connect(caller).createShepherd(configuration);
    await expect(tx).to.emit(factory, "ShepherdCreated")
      .withArgs(address, caller.address, Object.values(configuration));
    expect(await factory.isShepherd(address)).to.equal(true);
    return ethers.getContractAt("TellorShepherd", address);
  }

  it("forwards every setting and emits the complete initial configuration", async function () {
    const f = await loadFixture(deployFixture);
    const c = f.configuration;
    const shepherd = await create(f.factory, f.caller, c);
    const getters = {
      queryId: "queryId", decimals: "decimals", primarySource: "primarySource", backupSource: "backupSource", admin: "admin",
      minPauseDuration: "MIN_PAUSE_DURATION",
      configChangeDelay: "CONFIG_CHANGE_DELAY",
      challengeThresholdBps: "CHALLENGE_THRESHOLD_BPS",
      challengeDelaySeconds: "CHALLENGE_DELAY_SECONDS", recoveryDelaySeconds: "RECOVERY_DELAY_SECONDS",
    };
    for (const [field, getter] of Object.entries(getters)) {
      expect(await shepherd[getter](), field).to.equal(c[field]);
    }
    expect(await shepherd.MAX_DATA_AGE()).to.equal(c.maxDataAge);
    expect(await shepherd.mode()).to.equal(0);
    expect(await shepherd.paused()).to.equal(false);
    expect(await shepherd.challengePending()).to.equal(false);
    expect(await shepherd.recoveryPending()).to.equal(false);
    expect(await shepherd.pendingPrimarySource()).to.equal(ethers.ZeroAddress);
    // Empty sources are allowed by the existing constructor policy.
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.primary, "NoTwapData");
  });

  it("gives authority only to the nominated admin, independently of deployment callers", async function () {
    const f = await loadFixture(deployFixture);
    const shepherd = await create(f.factory, f.caller, f.configuration);
    expect(await shepherd.admin()).not.to.equal(f.factory.target);
    for (const account of [f.deployer, f.caller]) {
      await expect(shepherd.connect(account).pause()).to.be.revertedWithCustomError(shepherd, "NotAuthorizedToPause");
      await expect(shepherd.connect(account).addPauser(account.address))
        .to.be.revertedWithCustomError(shepherd, "NotAdmin");
    }
    for (const address of [f.factory.target, f.deployer.address, f.caller.address, f.admin.address]) {
      expect(await shepherd.isPauser(address)).to.equal(false);
    }
    await shepherd.connect(f.admin).addPauser(f.caller.address);
    await shepherd.connect(f.caller).pause();
    expect(await shepherd.paused()).to.equal(true);
  });

  it("allows duplicate configurations and independent instances for the same feed", async function () {
    const f = await loadFixture(deployFixture);
    const first = await create(f.factory, f.caller, f.configuration);
    const duplicate = await create(f.factory, f.otherAdmin, f.configuration);
    const second = await create(f.factory, f.caller, {
      ...f.configuration, admin: f.otherAdmin.address, minPauseDuration: 123n,
    });
    expect(new Set([first.target, duplicate.target, second.target]).size).to.equal(3);
    await first.connect(f.admin).pause();
    expect(await duplicate.paused()).to.equal(false);
    expect(await second.paused()).to.equal(false);
    expect(await second.MIN_PAUSE_DURATION()).to.equal(123);
    await expect(second.connect(f.admin).pause()).to.be.revertedWithCustomError(second, "NotAuthorizedToPause");
    await second.connect(f.otherAdmin).pause();
  });

  it("registers only its own deployments, not equivalent direct or other-factory instances", async function () {
    const f = await loadFixture(deployFixture);
    const direct = await f.Shepherd.deploy(...constructorArgs(f.configuration));
    const otherFactory = await f.Factory.deploy();
    const other = await create(otherFactory, f.caller, f.configuration);
    for (const address of [ethers.ZeroAddress, f.caller.address, f.bank.target, direct.target, other.target]) {
      expect(await f.factory.isShepherd(address)).to.equal(false);
    }
  });

  it("forwards both valid age-conversion endpoints without truncation", async function () {
    const f = await loadFixture(deployFixture);
    const largest = ethers.MaxUint256 / 1000n;
    for (const maxDataAge of [1n, largest]) {
      const s = await create(f.factory, f.caller, { ...f.configuration, maxDataAge });
      expect(await s.MAX_DATA_AGE()).to.equal(maxDataAge);
    }
  });

  for (const minPauseDuration of [0n, ethers.MaxUint256]) {
    it(`accepts initial minimum pause duration ${minPauseDuration}`, async function () {
      const f = await loadFixture(deployFixture);
      const s = await create(f.factory, f.caller, { ...f.configuration, minPauseDuration });
      expect(await s.MIN_PAUSE_DURATION()).to.equal(minPauseDuration);
      await s.connect(f.admin).pause();
      if (minPauseDuration === 0n) await s.connect(f.admin).unpause();
      else await expect(s.connect(f.admin).unpause()).to.be.revertedWithCustomError(s, "PauseDurationNotElapsed");
    });
  }

  const invalidCases = [
    ["queryId", ethers.ZeroHash, "InvalidQueryId"],
    ["primarySource", ethers.ZeroAddress, "SourceHasNoCode"],
    ["backupSource", ethers.ZeroAddress, "SourceHasNoCode"],
    ["decimals", 78, "InvalidDecimals"],
    ["admin", ethers.ZeroAddress, "InvalidAdmin"],
    ["configChangeDelay", 0n, "InvalidConfigChangeDelay"],
    ["challengeThresholdBps", 0n, "InvalidChallengeThreshold"],
    ["challengeThresholdBps", 10000n, "InvalidChallengeThreshold"],
    ["challengeDelaySeconds", 0n, "InvalidChallengeDelay"],
    ["recoveryDelaySeconds", 0n, "InvalidRecoveryDelay"],
    ...[0n, ethers.MaxUint256 / 1000n + 1n].map(value => ["maxDataAge", value, "InvalidMaxAge"]),
  ];

  for (const [field, value, error] of invalidCases) {
    it(`propagates ${error} for ${field}=${value} without partial registration`, async function () {
      const f = await loadFixture(deployFixture);
      const nonce = await ethers.provider.getTransactionCount(f.factory.target);
      const predicted = ethers.getCreateAddress({ from: f.factory.target, nonce });
      await expect(f.factory.connect(f.caller).createShepherd({ ...f.configuration, [field]: value }))
        .to.be.revertedWithCustomError(f.Shepherd, error);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");
      expect(await f.factory.isShepherd(predicted)).to.equal(false);
      expect(await f.factory.queryFilter(f.factory.filters.ShepherdCreated())).to.have.length(0);
      // The failed CREATE also rolls back the factory nonce; a corrected retry works.
      const shepherd = await create(f.factory, f.caller, f.configuration);
      expect(shepherd.target).to.equal(predicted);
    });
  }
});
