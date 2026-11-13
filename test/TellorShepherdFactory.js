const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TellorShepherdFactory", function () {
  async function deployFixture() {
    const [deployer, caller, admin, otherAdmin] = await ethers.getSigners();
    const queryId = ethers.id("factory-feed");
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(deployer.address, 43200, 600, 86400);
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
      maxDataAge: 3600n, isPausable: true,
    };
    return { deployer, caller, admin, otherAdmin, bank, primary, backup, Factory, factory, Shepherd, configuration };
  }

  function constructorArgs(c) {
    return [c.queryId, c.decimals, c.primarySource, c.backupSource, c.admin,
      c.minPauseDuration, c.configChangeDelay, c.challengeThresholdBps,
      [c.challengeDelaySeconds, c.recoveryDelaySeconds], c.maxDataAge, c.isPausable];
  }

  async function predict(f, configuration, salt = ethers.ZeroHash, caller = f.caller) {
    const { data } = await f.Shepherd.getDeployTransaction(...constructorArgs(configuration));
    const scopedSalt = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder()
      .encode(["address", "bytes32"], [caller.address, salt]));
    return ethers.getCreate2Address(f.factory.target, scopedSalt, ethers.keccak256(data));
  }

  async function create(factory, caller, configuration, salt = ethers.ZeroHash) {
    const address = await factory.connect(caller).createShepherd.staticCall(configuration, salt);
    const tx = await factory.connect(caller).createShepherd(configuration, salt);
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
      minPauseDuration: "minPauseDuration", isPausable: "isPausable",
      configChangeDelay: "CONFIG_CHANGE_DELAY",
      challengeThresholdBps: "challengeThresholdBps",
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

  it("deploys and records a non-pausable instance at the address bound to its flag", async function () {
    const f = await loadFixture(deployFixture);
    const configuration = { ...f.configuration, isPausable: false };
    const s = await create(f.factory, f.caller, configuration);
    expect(s.target).to.equal(await predict(f, configuration));
    expect(s.target).not.to.equal(await predict(f, f.configuration));
    expect(await s.isPausable()).to.equal(false);
    await expect(s.connect(f.admin).pause()).to.be.revertedWithCustomError(s, "NotPausable");
    const direct = await f.Shepherd.deploy(...constructorArgs(configuration));
    expect(await direct.isPausable()).to.equal(false);
    expect(await s.paused()).to.equal(false);
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
    expect(await second.minPauseDuration()).to.equal(123);
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

  it("binds addresses to every setting and isolates callers and salts", async function () {
    const f = await loadFixture(deployFixture);
    const predicted = await predict(f, f.configuration);
    const mutations = {
      queryId: ethers.id("other-feed"), decimals: 9, primarySource: f.backup.target,
      backupSource: f.primary.target, admin: f.otherAdmin.address, minPauseDuration: 123n,
      configChangeDelay: 304n, challengeThresholdBps: 2006n, challengeDelaySeconds: 2n,
      recoveryDelaySeconds: 98n, maxDataAge: 3601n, isPausable: false,
    };
    for (const [field, value] of Object.entries(mutations)) {
      expect(await predict(f, { ...f.configuration, [field]: value }), field).not.to.equal(predicted);
    }
    // An intervening attacker deployment cannot occupy the intended configuration's address.
    const changed = await create(f.factory, f.caller, { ...f.configuration, admin: f.otherAdmin.address });
    expect(changed.target).not.to.equal(predicted);
    const other = await create(f.factory, f.otherAdmin, f.configuration);
    expect(other.target).not.to.equal(predicted);
    const first = await create(f.factory, f.caller, f.configuration);
    expect(first.target).to.equal(predicted);
    const duplicate = await create(f.factory, f.caller, f.configuration, ethers.id("duplicate"));
    expect(duplicate.target).to.equal(await predict(f, f.configuration, ethers.id("duplicate")));
    expect(duplicate.target).not.to.equal(first.target);
    await expect(f.factory.connect(f.caller).createShepherd(f.configuration, ethers.ZeroHash)).to.be.reverted;
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
      expect(await s.minPauseDuration()).to.equal(minPauseDuration);
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
      const invalid = { ...f.configuration, [field]: value };
      const predicted = await predict(f, invalid);
      await expect(f.factory.connect(f.caller).createShepherd(invalid, ethers.ZeroHash))
        .to.be.revertedWithCustomError(f.Shepherd, error);
      expect(await ethers.provider.getCode(predicted)).to.equal("0x");
      expect(await f.factory.isShepherd(predicted)).to.equal(false);
      expect(await f.factory.queryFilter(f.factory.filters.ShepherdCreated())).to.have.length(0);
      // A failed creation leaves the salt usable; corrected arguments bind a different address.
      const shepherd = await create(f.factory, f.caller, f.configuration);
      expect(shepherd.target).to.equal(await predict(f, f.configuration));
    });
  }
});
