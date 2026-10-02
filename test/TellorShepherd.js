const { loadFixture, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TellorShepherd - Configuration", function () {
  async function deployFixture() {
    const [deployer, admin] = await ethers.getSigners();
    const queryId = ethers.id("constructor-test-feed");
    // No relays occur here, so the bank's bridge is not exercised.
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(deployer.address);
    await bank.waitForDeployment();
    // Identity-compatible backup; no available price is required at construction.
    const Backup = await ethers.getContractFactory("BackupOracleMock");
    const backup = await Backup.deploy(queryId);
    await backup.waitForDeployment();
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const args = [queryId, bank.target, backup.target, admin.address, 60, 120, 300, 600, 30000, 2000, [30, 90]];
    return { deployer, admin, queryId, bank, backup, Shepherd, args };
  }

  it("preserves explicit configuration and starts in primary mode with an empty bank", async function () {
    const { deployer, admin, queryId, bank, backup, Shepherd, args } = await loadFixture(deployFixture);
    expect(await bank.getAggregateValueCount(queryId)).to.equal(0);
    const shepherd = await Shepherd.deploy(...args);
    await shepherd.waitForDeployment();

    expect(await shepherd.queryId()).to.equal(queryId);
    expect(await shepherd.dataBank()).to.equal(bank.target);
    expect(await shepherd.backupOracle()).to.equal(backup.target);
    expect(await shepherd.admin()).to.equal(admin.address);
    expect(await shepherd.admin()).not.to.equal(deployer.address);
    expect(await shepherd.RELAY_READ_DELAY()).to.equal(60);
    expect(await shepherd.mode()).to.equal(0); // Mode.PRIMARY
    expect(await shepherd.MIN_PAUSE_DURATION()).to.equal(120);
    expect(await shepherd.DATA_BANK_CHANGE_DELAY()).to.equal(300);
    expect(await shepherd.BACKUP_CHANGE_DELAY()).to.equal(600);
    expect(await shepherd.TWAP_WINDOW_MS()).to.equal(30000);
    expect(await shepherd.CHALLENGE_THRESHOLD_BPS()).to.equal(2000);
    expect(await shepherd.CHALLENGE_DELAY_SECONDS()).to.equal(30);
    expect(await shepherd.RECOVERY_DELAY_SECONDS()).to.equal(90);
    expect(await shepherd.pendingBackupOracle()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.backupProposedAt()).to.equal(0);
    expect(await shepherd.pendingDataBank()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.dataBankProposedAt()).to.equal(0);
    expect(await shepherd.paused()).to.equal(false);
    expect(await shepherd.pausedAt()).to.equal(0);
  });

  const invalidCases = [
    ["zero query ID", 0, () => ethers.ZeroHash, "InvalidQueryId"],
    ["zero bank address", 1, () => ethers.ZeroAddress, "DataBankHasNoCode"],
    ["wallet bank address", 1, ({ deployer }) => deployer.address, "DataBankHasNoCode"],
    ["zero backup address", 2, () => ethers.ZeroAddress, "BackupOracleHasNoCode"],
    ["wallet backup address", 2, ({ deployer }) => deployer.address, "BackupOracleHasNoCode"],
    ["zero admin", 3, () => ethers.ZeroAddress, "InvalidAdmin"],
    ["zero read delay", 4, () => 0, "InvalidRelayReadDelay"],
    ["zero pause duration", 5, () => 0, "InvalidMinPauseDuration"],
    ["zero bank change delay", 6, () => 0, "InvalidDataBankChangeDelay"],
    ["zero backup change delay", 7, () => 0, "InvalidBackupChangeDelay"],
    ["zero recovery delay", 10, () => [30, 0], "InvalidRecoveryDelay"],
    ["zero TWAP window", 8, () => 0, "InvalidTwapWindow"],
    ["zero threshold", 9, () => 0, "InvalidChallengeThreshold"],
    ["100 percent threshold", 9, () => 10000, "InvalidChallengeThreshold"],
    ["oversized threshold", 9, () => ethers.MaxUint256, "InvalidChallengeThreshold"],
    ["zero challenge delay", 10, () => [0, 90], "InvalidChallengeDelay"],
    ["challenge delay shorter than window", 10, () => [29, 90], "InvalidChallengeDelay"],
  ];

  for (const [label, index, invalidValue, error] of invalidCases) {
    it(`rejects ${label}`, async function () {
      const fixture = await loadFixture(deployFixture);
      const args = [...fixture.args];
      args[index] = invalidValue(fixture);
      await expect(fixture.Shepherd.deploy(...args)).to.be.revertedWithCustomError(fixture.Shepherd, error);
    });
  }

  it("rounds challenge windows upward, including maximum uint256, without overflow", async function () {
    const { Shepherd, args: fixtureArgs } = await loadFixture(deployFixture);
    const args = [...fixtureArgs];
    for (const window of [1n, 1000n, 1001n, ethers.MaxUint256]) {
      args[8] = window;
      const minimumSeconds = (window + 999n) / 1000n; // JS bigint is unbounded.
      args[10] = [minimumSeconds - 1n, 90];
      await expect(Shepherd.deploy(...args)).to.be.revertedWithCustomError(Shepherd, "InvalidChallengeDelay");
      args[10] = [minimumSeconds, 90];
      const shepherd = await Shepherd.deploy(...args);
      expect(await shepherd.CHALLENGE_DELAY_SECONDS()).to.equal(minimumSeconds);
    }
    for (const threshold of [1, 9999]) {
      args[9] = threshold;
      expect(await (await Shepherd.deploy(...args)).CHALLENGE_THRESHOLD_BPS()).to.equal(threshold);
    }
  });

  it("accepts positive recovery delays independently of the TWAP window", async function () {
    const { Shepherd, args: fixtureArgs } = await loadFixture(deployFixture);
    const args = [...fixtureArgs];
    for (const delay of [1n, ethers.MaxUint256]) {
      args[10] = [30, delay];
      expect(await (await Shepherd.deploy(...args)).RECOVERY_DELAY_SECONDS()).to.equal(delay);
    }
  });

  it("accepts the minimum positive delay in seconds", async function () {
    const { Shepherd, args: fixtureArgs } = await loadFixture(deployFixture);
    const args = [...fixtureArgs];
    args[4] = 1;
    args[5] = 1;
    args[6] = 1;
    args[7] = 1;
    args[8] = 1;
    const shepherd = await Shepherd.deploy(...args);
    expect(await shepherd.RELAY_READ_DELAY()).to.equal(1);
    expect(await shepherd.MIN_PAUSE_DURATION()).to.equal(1);
    expect(await shepherd.DATA_BANK_CHANGE_DELAY()).to.equal(1);
    expect(await shepherd.BACKUP_CHANGE_DELAY()).to.equal(1);
    expect(await shepherd.TWAP_WINDOW_MS()).to.equal(1);
  });
});

describe("TellorShepherd - Mature primary reads", function () {
  const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
  const h = require("../src/helpers/evmHelpers");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const delay = 60;
  const encode = (value) => coder.encode(["uint256"], [value]);

  async function deployReadFixture() {
    const [deployer, admin] = await ethers.getSigners();
    const queryId = ethers.id("primary-read-test-feed");
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target);
    const Backup = await ethers.getContractFactory("BackupOracleMock");
    const backup = await Backup.deploy(queryId);
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherd = await Shepherd.deploy(queryId, bank.target, backup.target, admin.address, delay, 120, 300, 600, 30000, 2000, [30, 90]);
    await shepherd.waitForDeployment();
    return { deployer, admin, queryId, validatorSet, bank, backup, Shepherd, shepherd };
  }

  async function relay(fixture, payload, overrides = {}, queryId = fixture.queryId) {
    const report = await h.prepareOracleData(queryId, payload, fixture.validatorSet, overrides);
    const tx = await fixture.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    return { relayTime: block.timestamp, aggregateTimestamp: BigInt(report.attestData.report.timestamp) };
  }

  async function injectLookupPayload(fixture, payload) {
    // The real bank now rejects invalid prices at admission. Model an incompatible/misbehaving
    // dependency with a correctly encoded lookup response to retain Shepherd validation coverage.
    const record = await relay(fixture, encode(100));
    await time.increaseTo(record.relayTime + delay + 1);
    const response = coder.encode(
      ["bool", "tuple(bytes,uint256,uint256,uint256,uint256)"],
      [true, [payload, 1, record.aggregateTimestamp, record.aggregateTimestamp, record.relayTime]]
    );
    const length = ((response.length - 2) / 2).toString(16).padStart(4, "0");
    // Copy the ABI response following this 15-byte runtime prefix into memory, then return it.
    await setCode(fixture.bank.target, `0x61${length}61000f60003961${length}6000f3${response.slice(2)}`);
    return record;
  }

  it("blocks a valid read immediately and lets relay maturity advance during pause", async function () {
    const f = await loadFixture(deployReadFixture);
    const first = await relay(f, encode(100));
    await time.increaseTo(first.relayTime + delay + 1);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
    await f.shepherd.connect(f.admin).pause();
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
    const second = await relay(f, encode(200));
    await time.increaseTo(Number(await f.shepherd.pausedAt()) + 120);
    await f.shepherd.connect(f.admin).unpause();
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([200n, second.aggregateTimestamp]);
    expect(await f.shepherd.mode()).to.equal(0);
  });

  it("reports pause before an empty-history failure", async function () {
    const f = await loadFixture(deployReadFixture);
    await f.shepherd.connect(f.admin).pause();
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
  });

  it("keeps serving the original bank during notice and switches reads only after paused migration", async function () {
    const f = await loadFixture(deployReadFixture);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const replacement = await Bank.deploy(await f.bank.dataBridge());
    const original = await relay(f, encode(100));
    const updated = await relay({ ...f, bank: replacement }, encode(200));
    await time.increaseTo(updated.relayTime + delay + 1);
    await f.shepherd.connect(f.admin).proposeDataBankChange(replacement.target);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, original.aggregateTimestamp]);
    await f.shepherd.connect(f.admin).pause();
    const pausedAt = await f.shepherd.pausedAt();
    await time.setNextBlockTimestamp(Number(await f.shepherd.dataBankProposedAt()) + 300);
    await expect(f.shepherd.connect(f.admin).executeDataBankChange())
      .to.emit(f.shepherd, "DataBankChanged").withArgs(f.bank.target, replacement.target);
    expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
    expect(await f.shepherd.mode()).to.equal(0);
    expect(await f.shepherd.queryId()).to.equal(f.queryId);
    expect(await f.shepherd.backupOracle()).to.equal(f.backup.target);
    expect(await f.shepherd.pendingDataBank()).to.equal(ethers.ZeroAddress);
    expect(await f.shepherd.dataBankProposedAt()).to.equal(0);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
    await f.shepherd.connect(f.admin).unpause();
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([200n, updated.aggregateTimestamp]);
    await expect(f.shepherd.connect(f.admin).executeDataBankChange())
      .to.be.revertedWithCustomError(f.shepherd, "NoPendingDataBankChange");
  });

  it("rejects an empty history", async function () {
    const { shepherd } = await loadFixture(deployReadFixture);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "NoMatureData");
  });

  it("uses relay time for strict maturity and preserves subsecond observation time", async function () {
    const f = await loadFixture(deployReadFixture);
    const observation = (await time.latest() - 300) * 1000 + 123;
    const record = await relay(f, encode(2000), {
      aggregateTimestamp: observation,
      attestationTimestamp: (await time.latest()) * 1000,
    });
    // The observation is already old; only EVM relay time starts the read delay.
    await time.increaseTo(record.relayTime + delay - 1);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoMatureData");
    await time.increaseTo(record.relayTime + delay);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoMatureData");
    await time.increaseTo(record.relayTime + delay + 1);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([2000n, BigInt(observation)]);
  });

  it("selects the newest mature relay despite a newer immature relay", async function () {
    const f = await loadFixture(deployReadFixture);
    await relay(f, encode(100));
    await time.increase(10);
    const second = await relay(f, encode(200));
    await time.increaseTo(second.relayTime + delay + 1);
    const third = await relay(f, encode(300));
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([200n, second.aggregateTimestamp]);
    await time.increaseTo(third.relayTime + delay);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([200n, second.aggregateTimestamp]);
    await time.increaseTo(third.relayTime + delay + 1);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([300n, third.aggregateTimestamp]);
  });

  it("does not consume another feed's history", async function () {
    const f = await loadFixture(deployReadFixture);
    const record = await relay(f, encode(2000), {}, ethers.id("another-feed"));
    await time.increaseTo(record.relayTime + delay + 1);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoMatureData");
  });

  for (const length of [0, 1, 31]) {
    it(`rejects a ${length}-byte selected payload without using an older valid record`, async function () {
      const f = await loadFixture(deployReadFixture);
      await relay(f, encode(100));
      await time.increase(10);
      await injectLookupPayload(f, "0x" + "ab".repeat(length));
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "InvalidValueLength");
    });
  }

  for (const suffix of ["", "ff", "ab".repeat(32)]) {
    it(`rejects a zero first word with ${suffix.length / 2} trailing bytes`, async function () {
      const f = await loadFixture(deployReadFixture);
      await relay(f, encode(100));
      await time.increase(10);
      await injectLookupPayload(f, encode(0) + suffix);
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ZeroValue");
    });
  }

  for (const suffix of ["ff", "ab".repeat(32)]) {
    it(`accepts ${suffix.length / 2} trailing bytes and decodes only the first word`, async function () {
      const f = await loadFixture(deployReadFixture);
      const record = await injectLookupPayload(f, encode(ethers.MaxUint256) + suffix);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([ethers.MaxUint256, record.aggregateTimestamp]);
    });
  }

  it("reverts when the configured dependency cannot answer the lookup", async function () {
    const f = await loadFixture(deployReadFixture);
    // BackupOracleMock has deployed code but no getRelayBefore function; it reverts on this selector.
    const shepherd = await f.Shepherd.deploy(f.queryId, f.backup.target, f.backup.target, f.admin.address, delay, 120, 300, 600, 30000, 2000, [30, 90]);
    await expect(shepherd.getCurrentValue()).to.be.reverted;
  });

  it("uses checked subtraction for underflow and reports no data at a zero cutoff", async function () {
    const f = await loadFixture(deployReadFixture);
    const futureDelay = (await time.latest()) + 100;
    const shepherd = await f.Shepherd.deploy(f.queryId, f.bank.target, f.backup.target, f.admin.address, futureDelay, 120, 300, 600, 30000, 2000, [30, 90]);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithPanic(0x11);
    await time.increaseTo(futureDelay);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "NoMatureData");
    await time.increaseTo(futureDelay + 1);
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "NoMatureData");
  });
});

describe("TellorShepherd - Pauser membership", function () {
  async function deployPauserFixture() {
    const [deployer, admin, pauser, other] = await ethers.getSigners();
    const Lab = await ethers.getContractFactory("TellorLab");
    const source = await Lab.deploy();
    const Backup = await ethers.getContractFactory("BackupOracleMock");
    const backup = await Backup.deploy(ethers.id("pauser-test-feed"));
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    // Membership operations do not read either source.
    const shepherd = await Shepherd.deploy(ethers.id("pauser-test-feed"), source.target, backup.target, admin.address, 60, 120, 300, 600, 30000, 2000, [30, 90]);
    await shepherd.waitForDeployment();
    return { deployer, admin, pauser, other, shepherd };
  }

  it("starts with no pauser memberships, including for admin and deployer", async function () {
    const { deployer, admin, pauser, shepherd } = await loadFixture(deployPauserFixture);
    for (const address of [deployer.address, admin.address, pauser.address, ethers.ZeroAddress]) {
      expect(await shepherd.isPauser(address)).to.equal(false);
    }
  });

  it("lets the admin add, remove, and re-add a member immediately with events", async function () {
    const { admin, pauser, other, shepherd } = await loadFixture(deployPauserFixture);
    await shepherd.connect(admin).addPauser(other.address);
    await expect(shepherd.connect(admin).addPauser(pauser.address))
      .to.emit(shepherd, "PauserAdded").withArgs(pauser.address);
    expect(await shepherd.isPauser(pauser.address)).to.equal(true);
    await expect(shepherd.connect(admin).removePauser(pauser.address))
      .to.emit(shepherd, "PauserRemoved").withArgs(pauser.address);
    expect(await shepherd.isPauser(pauser.address)).to.equal(false);
    expect(await shepherd.isPauser(other.address)).to.equal(true);
    await expect(shepherd.connect(admin).addPauser(pauser.address))
      .to.emit(shepherd, "PauserAdded").withArgs(pauser.address);
    expect(await shepherd.isPauser(pauser.address)).to.equal(true);
  });

  it("rejects membership changes from deployer, outsiders, active and removed pausers", async function () {
    const { deployer, admin, pauser, other, shepherd } = await loadFixture(deployPauserFixture);
    await shepherd.connect(admin).addPauser(pauser.address);
    await shepherd.connect(admin).addPauser(other.address);
    for (const caller of [deployer, pauser]) {
      await expect(shepherd.connect(caller).addPauser(admin.address))
        .to.be.revertedWithCustomError(shepherd, "NotAdmin");
      await expect(shepherd.connect(caller).removePauser(other.address))
        .to.be.revertedWithCustomError(shepherd, "NotAdmin");
    }
    await shepherd.connect(admin).removePauser(pauser.address);
    await expect(shepherd.connect(pauser).addPauser(pauser.address))
      .to.be.revertedWithCustomError(shepherd, "NotAdmin");
    await expect(shepherd.connect(pauser).removePauser(other.address))
      .to.be.revertedWithCustomError(shepherd, "NotAdmin");
    expect(await shepherd.isPauser(pauser.address)).to.equal(false);
    expect(await shepherd.isPauser(other.address)).to.equal(true);
    expect(await shepherd.isPauser(admin.address)).to.equal(false);
  });

  for (const method of ["addPauser", "removePauser"]) {
    it(`rejects the zero address in ${method}`, async function () {
      const { admin, shepherd } = await loadFixture(deployPauserFixture);
      await expect(shepherd.connect(admin)[method](ethers.ZeroAddress))
        .to.be.revertedWithCustomError(shepherd, "InvalidPauser");
      expect(await shepherd.isPauser(ethers.ZeroAddress)).to.equal(false);
    });
  }

  it("rejects duplicate additions and removal of nonmembers", async function () {
    const { admin, pauser, shepherd } = await loadFixture(deployPauserFixture);
    await expect(shepherd.connect(admin).removePauser(pauser.address))
      .to.be.revertedWithCustomError(shepherd, "NotPauser");
    await shepherd.connect(admin).addPauser(pauser.address);
    await expect(shepherd.connect(admin).addPauser(pauser.address))
      .to.be.revertedWithCustomError(shepherd, "AlreadyPauser");
    expect(await shepherd.isPauser(pauser.address)).to.equal(true);
    await shepherd.connect(admin).removePauser(pauser.address);
    await expect(shepherd.connect(admin).removePauser(pauser.address))
      .to.be.revertedWithCustomError(shepherd, "NotPauser");
  });

  it("keeps admin authority independent of its optional membership", async function () {
    const { admin, pauser, shepherd } = await loadFixture(deployPauserFixture);
    await shepherd.connect(admin).addPauser(admin.address);
    await shepherd.connect(admin).removePauser(admin.address);
    expect(await shepherd.isPauser(admin.address)).to.equal(false);
    expect(await shepherd.admin()).to.equal(admin.address);
    await shepherd.connect(admin).addPauser(pauser.address);
    expect(await shepherd.isPauser(pauser.address)).to.equal(true);
  });
});


describe("TellorShepherd - Pause and unpause", function () {
  const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
  const duration = 120;

  async function deployPauseFixture() {
    const [deployer, admin, pauser, outsider] = await ethers.getSigners();
    const Lab = await ethers.getContractFactory("TellorLab");
    const source = await Lab.deploy();
    const Backup = await ethers.getContractFactory("BackupOracleMock");
    const backup = await Backup.deploy(ethers.id("pause-test-feed"));
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    // This dependency cannot answer primary reads, allowing pause precedence tests.
    const shepherd = await Shepherd.deploy(ethers.id("pause-test-feed"), source.target, backup.target,
      admin.address, 60, duration, 300, 600, 30000, 2000, [30, 90]);
    await shepherd.connect(admin).addPauser(pauser.address);
    return { deployer, admin, pauser, outsider, source, backup, Shepherd, shepherd };
  }

  it("allows admin pause even after removing its optional membership", async function () {
    const { admin, shepherd } = await loadFixture(deployPauseFixture);
    await shepherd.connect(admin).addPauser(admin.address);
    await shepherd.connect(admin).removePauser(admin.address);
    await expect(shepherd.connect(admin).pause()).to.emit(shepherd, "Paused").withArgs(admin.address);
    expect(await shepherd.paused()).to.equal(true);
    expect(await shepherd.pausedAt()).to.equal(await time.latest());
    expect(await shepherd.mode()).to.equal(0);
  });

  it("allows an active pauser to halt but rejects deployer, outsider, and removed pauser", async function () {
    const { deployer, admin, pauser, outsider, shepherd } = await loadFixture(deployPauseFixture);
    for (const caller of [deployer, outsider]) {
      await expect(shepherd.connect(caller).pause()).to.be.revertedWithCustomError(shepherd, "NotAuthorizedToPause");
    }
    await shepherd.connect(admin).removePauser(pauser.address);
    await expect(shepherd.connect(pauser).pause()).to.be.revertedWithCustomError(shepherd, "NotAuthorizedToPause");
    await shepherd.connect(admin).addPauser(pauser.address);
    await expect(shepherd.connect(pauser).pause()).to.emit(shepherd, "Paused").withArgs(pauser.address);
    expect(await shepherd.paused()).to.equal(true);
  });

  it("rejects repeated pauses from both authorities without extending the original clock", async function () {
    const { admin, pauser, shepherd } = await loadFixture(deployPauseFixture);
    await shepherd.connect(pauser).pause();
    const start = Number(await shepherd.pausedAt());
    await time.increaseTo(start + 30);
    for (const caller of [pauser, admin]) {
      await expect(shepherd.connect(caller).pause()).to.be.revertedWithCustomError(shepherd, "AlreadyPaused");
      expect(await shepherd.pausedAt()).to.equal(start);
    }
    await time.setNextBlockTimestamp(start + duration);
    await shepherd.connect(admin).unpause();
    expect(await shepherd.paused()).to.equal(false);
  });

  it("requires admin unpause even after the full duration", async function () {
    const { deployer, admin, pauser, outsider, shepherd } = await loadFixture(deployPauseFixture);
    await shepherd.connect(pauser).pause();
    await time.increase(duration);
    for (const caller of [deployer, outsider, pauser]) {
      await expect(shepherd.connect(caller).unpause()).to.be.revertedWithCustomError(shepherd, "NotAdmin");
    }
    await shepherd.connect(admin).removePauser(pauser.address);
    await expect(shepherd.connect(pauser).unpause()).to.be.revertedWithCustomError(shepherd, "NotAdmin");
    expect(await shepherd.paused()).to.equal(true);
  });

  it("rejects unpaused and early unpause, accepts equality, and starts a fresh clock next time", async function () {
    const { admin, pauser, shepherd } = await loadFixture(deployPauseFixture);
    await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "NotPaused");
    await shepherd.connect(pauser).pause();
    const start = Number(await shepherd.pausedAt());
    await time.setNextBlockTimestamp(start + duration - 1);
    await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "PauseDurationNotElapsed");
    expect(await shepherd.paused()).to.equal(true);
    expect(await shepherd.pausedAt()).to.equal(start);
    await time.setNextBlockTimestamp(start + duration);
    await expect(shepherd.connect(admin).unpause()).to.emit(shepherd, "Unpaused").withArgs(admin.address);
    expect(await shepherd.paused()).to.equal(false);
    expect(await shepherd.pausedAt()).to.equal(0);
    expect(await shepherd.mode()).to.equal(0);
    await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "NotPaused");
    await shepherd.connect(pauser).pause();
    const nextStart = Number(await shepherd.pausedAt());
    expect(nextStart).to.be.greaterThan(start + duration);
    await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "PauseDurationNotElapsed");
    await time.setNextBlockTimestamp(nextStart + duration);
    await shepherd.connect(admin).unpause();
  });

  it("reports pause before dependency failure or cutoff underflow", async function () {
    const { admin, source, backup, Shepherd, shepherd } = await loadFixture(deployPauseFixture);
    await expect(shepherd.getCurrentValue()).to.be.reverted;
    await shepherd.connect(admin).pause();
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "ShepherdPaused");
    const underflow = await Shepherd.deploy(ethers.id("pause-test-feed"), source.target, backup.target,
      admin.address, ethers.MaxUint256, duration, 300, 600, 30000, 2000, [30, 90]);
    await expect(underflow.getCurrentValue()).to.be.revertedWithPanic(0x11);
    await underflow.connect(admin).pause();
    await expect(underflow.getCurrentValue()).to.be.revertedWithCustomError(underflow, "ShepherdPaused");
  });
});


describe("TellorShepherd - DataBank migration", function () {
  const { time, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
  const changeDelay = 300;

  async function deployMigrationFixture() {
    const [deployer, admin, pauser, outsider] = await ethers.getSigners();
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(deployer.address);
    const replacement = await Bank.deploy(deployer.address);
    const alternate = await Bank.deploy(deployer.address);
    const Lab = await ethers.getContractFactory("TellorLab");
    const incompatible = await Lab.deploy();
    const Backup = await ethers.getContractFactory("BackupOracleMock");
    const backup = await Backup.deploy(ethers.id("migration-feed"));
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherd = await Shepherd.deploy(ethers.id("migration-feed"), bank.target, backup.target,
      admin.address, 60, 120, changeDelay, 600, 30000, 2000, [30, 90]);
    await shepherd.connect(admin).addPauser(pauser.address);
    return { deployer, admin, pauser, outsider, bank, replacement, alternate, incompatible, shepherd };
  }

  it("requires admin for every migration action, including while paused", async function () {
    const { deployer, admin, pauser, outsider, replacement, shepherd } = await loadFixture(deployMigrationFixture);
    await shepherd.connect(admin).proposeDataBankChange(replacement.target);
    await shepherd.connect(pauser).pause();
    await time.increase(changeDelay);
    for (const caller of [deployer, pauser, outsider]) {
      await expect(shepherd.connect(caller).proposeDataBankChange(replacement.target))
        .to.be.revertedWithCustomError(shepherd, "NotAdmin");
      for (const method of ["cancelDataBankChange", "executeDataBankChange"]) {
        await expect(shepherd.connect(caller)[method]()).to.be.revertedWithCustomError(shepherd, "NotAdmin");
      }
    }
  });

  it("rejects absent proposals and invalid targets without starting a clock", async function () {
    const { admin, outsider, bank, incompatible, shepherd } = await loadFixture(deployMigrationFixture);
    for (const method of ["cancelDataBankChange", "executeDataBankChange"]) {
      await expect(shepherd.connect(admin)[method]()).to.be.revertedWithCustomError(shepherd, "NoPendingDataBankChange");
    }
    for (const target of [ethers.ZeroAddress, outsider.address]) {
      await expect(shepherd.connect(admin).proposeDataBankChange(target))
        .to.be.revertedWithCustomError(shepherd, "DataBankHasNoCode");
    }
    await expect(shepherd.connect(admin).proposeDataBankChange(bank.target))
      .to.be.revertedWithCustomError(shepherd, "DataBankUnchanged");
    await expect(shepherd.connect(admin).proposeDataBankChange(incompatible.target)).to.be.reverted;
    expect(await shepherd.pendingDataBank()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.dataBankProposedAt()).to.equal(0);
  });

  it("requires cancellation before replacement and gives a new proposal its own full delay", async function () {
    const { admin, replacement, alternate, shepherd } = await loadFixture(deployMigrationFixture);
    const proposedAt = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(proposedAt);
    await expect(shepherd.connect(admin).proposeDataBankChange(replacement.target))
      .to.emit(shepherd, "DataBankChangeProposed").withArgs(replacement.target, proposedAt);
    await time.increase(changeDelay);
    for (const target of [replacement.target, alternate.target]) {
      await expect(shepherd.connect(admin).proposeDataBankChange(target))
        .to.be.revertedWithCustomError(shepherd, "DataBankChangePending");
    }
    expect(await shepherd.pendingDataBank()).to.equal(replacement.target);
    expect(await shepherd.dataBankProposedAt()).to.equal(proposedAt);
    await expect(shepherd.connect(admin).cancelDataBankChange())
      .to.emit(shepherd, "DataBankChangeCancelled").withArgs(replacement.target);
    expect(await shepherd.pendingDataBank()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.dataBankProposedAt()).to.equal(0);
    await expect(shepherd.connect(admin).executeDataBankChange())
      .to.be.revertedWithCustomError(shepherd, "NoPendingDataBankChange");
    await shepherd.connect(admin).pause();
    await shepherd.connect(admin).proposeDataBankChange(alternate.target);
    expect(await shepherd.dataBankProposedAt()).to.be.greaterThan(proposedAt);
    await expect(shepherd.connect(admin).executeDataBankChange())
      .to.be.revertedWithCustomError(shepherd, "DataBankChangeDelayNotElapsed");
  });

  it("rejects one second early, allows equality with empty history, and preserves the pause minimum", async function () {
    const { admin, bank, replacement, shepherd } = await loadFixture(deployMigrationFixture);
    await shepherd.connect(admin).proposeDataBankChange(replacement.target);
    const start = Number(await shepherd.dataBankProposedAt());
    await time.setNextBlockTimestamp(start + changeDelay - 2);
    await shepherd.connect(admin).pause();
    const pausedAt = await shepherd.pausedAt();
    await time.setNextBlockTimestamp(start + changeDelay - 1);
    await expect(shepherd.connect(admin).executeDataBankChange())
      .to.be.revertedWithCustomError(shepherd, "DataBankChangeDelayNotElapsed");
    expect(await shepherd.dataBank()).to.equal(bank.target);
    await time.setNextBlockTimestamp(start + changeDelay);
    await shepherd.connect(admin).executeDataBankChange();
    expect(await shepherd.dataBank()).to.equal(replacement.target);
    expect(await shepherd.paused()).to.equal(true);
    expect(await shepherd.pausedAt()).to.equal(pausedAt);
    await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "PauseDurationNotElapsed");
    await time.setNextBlockTimestamp(Number(pausedAt) + 120);
    await shepherd.connect(admin).unpause();
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "NoMatureData");
  });

  it("requires pause for execution and blocks unpause until cancellation or execution", async function () {
    const { admin, bank, replacement, shepherd } = await loadFixture(deployMigrationFixture);
    await shepherd.connect(admin).proposeDataBankChange(replacement.target);
    await time.increase(changeDelay);
    await expect(shepherd.connect(admin).executeDataBankChange()).to.be.revertedWithCustomError(shepherd, "NotPaused");
    await shepherd.connect(admin).pause();
    await time.increase(120);
    await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "DataBankChangePending");
    await shepherd.connect(admin).cancelDataBankChange();
    await shepherd.connect(admin).unpause();
    expect(await shepherd.dataBank()).to.equal(bank.target);
  });

  // Fault injection only: production migration never writes a target's bytecode.
  // These cases distinguish code presence from a successful, decodable lookup.
  for (const [label, code] of [
    ["missing code", "0x"],
    ["reverting lookup", "0x60006000fd"],
    ["empty return", "0x60006000f3"],
    ["truncated return", "0x60016000f3"],
  ]) {
    it(`rechecks ${label} at execution and leaves the failed proposal cancellable`, async function () {
      const { admin, bank, replacement, alternate, shepherd } = await loadFixture(deployMigrationFixture);
      await setCode(alternate.target, code);
      await expect(shepherd.connect(admin).proposeDataBankChange(alternate.target)).to.be.reverted;
      await shepherd.connect(admin).proposeDataBankChange(replacement.target);
      const start = await shepherd.dataBankProposedAt();
      await shepherd.connect(admin).pause();
      const pausedAt = await shepherd.pausedAt();
      await time.increase(changeDelay);
      await setCode(replacement.target, code);
      await expect(shepherd.connect(admin).executeDataBankChange()).to.be.reverted;
      expect(await shepherd.dataBank()).to.equal(bank.target);
      expect(await shepherd.pendingDataBank()).to.equal(replacement.target);
      expect(await shepherd.dataBankProposedAt()).to.equal(start);
      expect(await shepherd.pausedAt()).to.equal(pausedAt);
      await shepherd.connect(admin).cancelDataBankChange();
      await shepherd.connect(admin).unpause();
    });
  }
});

describe("TellorShepherd - Backup migration", function () {
  const { time, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
  async function fixture() {
    const [deployer, admin, pauser, outsider] = await ethers.getSigners();
    const queryId = ethers.id("backup-migration-feed");
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(deployer.address);
    const newBank = await Bank.deploy(deployer.address);
    const Backup = await ethers.getContractFactory("BackupOracleMock");
    const backup = await Backup.deploy(queryId);
    const replacement = await Backup.deploy(queryId);
    const alternate = await Backup.deploy(queryId);
    const wrongFeed = await Backup.deploy(ethers.id("wrong-feed"));
    await replacement.configureRead(100, 123456, 0);
    await alternate.configureRead(101, 123457, 0);
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const args = [queryId, bank.target, backup.target, admin.address, 60, 120, 300, 600, 30000, 2000, [30, 90]];
    const shepherd = await Shepherd.deploy(...args);
    await shepherd.connect(admin).addPauser(pauser.address);
    return { deployer, admin, pauser, outsider, queryId, bank, newBank, backup, replacement,
      alternate, wrongFeed, Shepherd, args, shepherd };
  }

  it("checks only code at construction but rejects an unsupported feed at proposal", async function () {
    const f = await loadFixture(fixture);
    f.args[2] = f.wrongFeed.target;
    const deployed = await f.Shepherd.deploy(...f.args);
    expect(await deployed.backupOracle()).to.equal(f.wrongFeed.target);
    await expect(f.shepherd.connect(f.admin).proposeBackupChange(f.wrongFeed.target))
      .to.be.revertedWithCustomError(f.wrongFeed, "UnsupportedQueryId");
    expect(await f.shepherd.backupOracle()).to.equal(f.backup.target);
    expect(await f.shepherd.pendingBackupOracle()).to.equal(ethers.ZeroAddress);
    expect(await f.shepherd.backupProposedAt()).to.equal(0);
  });

  it("rejects missing proposals, no-code targets, and the current backup", async function () {
    const { admin, outsider, backup, shepherd } = await loadFixture(fixture);
    for (const method of ["cancelBackupChange", "executeBackupChange"]) {
      await expect(shepherd.connect(admin)[method]()).to.be.revertedWithCustomError(shepherd, "NoPendingBackupChange");
    }
    for (const target of [ethers.ZeroAddress, outsider.address]) {
      await expect(shepherd.connect(admin).proposeBackupChange(target))
        .to.be.revertedWithCustomError(shepherd, "BackupHasNoCode");
    }
    await expect(shepherd.connect(admin).proposeBackupChange(backup.target))
      .to.be.revertedWithCustomError(shepherd, "BackupUnchanged");
  });

  it("reserves every migration action for admin", async function () {
    const { deployer, admin, pauser, outsider, replacement, shepherd } = await loadFixture(fixture);
    await shepherd.connect(admin).proposeBackupChange(replacement.target);
    await shepherd.connect(pauser).pause();
    await time.increase(600);
    for (const caller of [deployer, pauser, outsider]) {
      await expect(shepherd.connect(caller).proposeBackupChange(replacement.target))
        .to.be.revertedWithCustomError(shepherd, "NotAdmin");
      for (const method of ["cancelBackupChange", "executeBackupChange"]) {
        await expect(shepherd.connect(caller)[method]()).to.be.revertedWithCustomError(shepherd, "NotAdmin");
      }
    }
  });

  it("requires cancellation before replacement and starts a fresh notice period", async function () {
    const { admin, replacement, alternate, shepherd } = await loadFixture(fixture);
    const start = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(start);
    await expect(shepherd.connect(admin).proposeBackupChange(replacement.target))
      .to.emit(shepherd, "BackupChangeProposed").withArgs(replacement.target, start);
    await time.increase(600);
    for (const target of [replacement.target, alternate.target]) {
      await expect(shepherd.connect(admin).proposeBackupChange(target))
        .to.be.revertedWithCustomError(shepherd, "BackupChangePending");
    }
    expect(await shepherd.backupProposedAt()).to.equal(start);
    await expect(shepherd.connect(admin).cancelBackupChange())
      .to.emit(shepherd, "BackupChangeCancelled").withArgs(replacement.target);
    expect(await shepherd.pendingBackupOracle()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.backupProposedAt()).to.equal(0);
    await shepherd.connect(admin).pause();
    await shepherd.connect(admin).proposeBackupChange(alternate.target);
    expect(await shepherd.backupProposedAt()).to.be.greaterThan(start);
    await expect(shepherd.connect(admin).executeBackupChange())
      .to.be.revertedWithCustomError(shepherd, "BackupChangeDelayNotElapsed");
  });

  it("requires pause, allows exact delay equality, and does not probe recovery", async function () {
    const { admin, queryId, bank, backup, replacement, shepherd } = await loadFixture(fixture);
    // A successful price call is required; recovery assessment is independent.
    await replacement.configureRecovery(false, 1);
    await expect(replacement.canRecover(queryId)).to.be.revertedWithCustomError(replacement, "RecoveryUnavailable");
    await shepherd.connect(admin).proposeBackupChange(replacement.target);
    const start = Number(await shepherd.backupProposedAt());
    await expect(shepherd.connect(admin).executeBackupChange()).to.be.revertedWithCustomError(shepherd, "NotPaused");
    await time.setNextBlockTimestamp(start + 598);
    await shepherd.connect(admin).pause();
    const pausedAt = await shepherd.pausedAt();
    await time.setNextBlockTimestamp(start + 599);
    await expect(shepherd.connect(admin).executeBackupChange())
      .to.be.revertedWithCustomError(shepherd, "BackupChangeDelayNotElapsed");
    expect(await shepherd.backupOracle()).to.equal(backup.target);
    await time.setNextBlockTimestamp(start + 600);
    await expect(shepherd.connect(admin).executeBackupChange())
      .to.emit(shepherd, "BackupChanged").withArgs(backup.target, replacement.target);
    expect(await shepherd.backupOracle()).to.equal(replacement.target);
    expect(await shepherd.pendingBackupOracle()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.backupProposedAt()).to.equal(0);
    expect(await shepherd.paused()).to.equal(true);
    expect(await shepherd.pausedAt()).to.equal(pausedAt);
    expect(await shepherd.mode()).to.equal(0);
    expect(await shepherd.queryId()).to.equal(queryId);
    expect(await shepherd.dataBank()).to.equal(bank.target);
    await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "PauseDurationNotElapsed");
    await time.setNextBlockTimestamp(Number(pausedAt) + 120);
    await shepherd.connect(admin).unpause();
    await expect(shepherd.connect(admin).executeBackupChange()).to.be.revertedWithCustomError(shepherd, "NoPendingBackupChange");
  });

  for (const first of ["bank", "backup"]) {
    it(`keeps timers independent and blocks unpause after executing the ${first} proposal first`, async function () {
      const { admin, replacement, newBank, shepherd } = await loadFixture(fixture);
      await shepherd.connect(admin).proposeDataBankChange(newBank.target);
      const bankStart = await shepherd.dataBankProposedAt();
      await time.increase(20);
      await shepherd.connect(admin).proposeBackupChange(replacement.target);
      const backupStart = await shepherd.backupProposedAt();
      expect(await shepherd.dataBankProposedAt()).to.equal(bankStart);
      await shepherd.connect(admin).pause();
      const pausedAt = await shepherd.pausedAt();
      await time.setNextBlockTimestamp(Number(bankStart) + 300);
      // Bank's shorter delay cannot mature the backup proposal.
      await expect(shepherd.connect(admin).executeBackupChange())
        .to.be.revertedWithCustomError(shepherd, "BackupChangeDelayNotElapsed");
      await time.increaseTo(Number(backupStart) + 600);
      await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "DataBankChangePending");
      if (first === "bank") {
        await shepherd.connect(admin).executeDataBankChange();
        expect(await shepherd.pendingBackupOracle()).to.equal(replacement.target);
        expect(await shepherd.backupProposedAt()).to.equal(backupStart);
        await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "BackupChangePending");
        await shepherd.connect(admin).cancelBackupChange();
      } else {
        await shepherd.connect(admin).executeBackupChange();
        expect(await shepherd.pendingDataBank()).to.equal(newBank.target);
        expect(await shepherd.dataBankProposedAt()).to.equal(bankStart);
        await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "DataBankChangePending");
        await shepherd.connect(admin).cancelDataBankChange();
      }
      expect(await shepherd.pausedAt()).to.equal(pausedAt);
      await shepherd.connect(admin).unpause();
    });
  }

  for (const code of ["0x60006000fd", "0x60006000f3", "0x60016000f3"]) {
    it(`rejects a failing or malformed backup at proposal and execution (${code})`, async function () {
      const f = await loadFixture(fixture);
      await setCode(f.alternate.target, code);
      const args = [...f.args];
      args[2] = f.alternate.target;
      const deployed = await f.Shepherd.deploy(...args);
      expect(await deployed.backupOracle()).to.equal(f.alternate.target);
      await expect(f.shepherd.connect(f.admin).proposeBackupChange(f.alternate.target)).to.be.reverted;
      expect(await f.shepherd.pendingBackupOracle()).to.equal(ethers.ZeroAddress);
      expect(await f.shepherd.backupProposedAt()).to.equal(0);
      await f.shepherd.connect(f.admin).proposeBackupChange(f.replacement.target);
      const start = await f.shepherd.backupProposedAt();
      await f.shepherd.connect(f.admin).pause();
      const pausedAt = await f.shepherd.pausedAt();
      await time.increase(600);
      await setCode(f.replacement.target, code);
      await expect(f.shepherd.connect(f.admin).executeBackupChange()).to.be.reverted;
      expect(await f.shepherd.backupOracle()).to.equal(f.backup.target);
      expect(await f.shepherd.pendingBackupOracle()).to.equal(f.replacement.target);
      expect(await f.shepherd.backupProposedAt()).to.equal(start);
      expect(await f.shepherd.paused()).to.equal(true);
      expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
      expect(await f.shepherd.mode()).to.equal(0);
      await f.shepherd.connect(f.admin).cancelBackupChange();
      await f.shepherd.connect(f.admin).unpause();
    });
  }

  it("propagates an unavailable price without creating a proposal", async function () {
    const { admin, replacement, backup, shepherd } = await loadFixture(fixture);
    await replacement.configureRead(100, 123456, 1);
    await expect(shepherd.connect(admin).proposeBackupChange(replacement.target))
      .to.be.revertedWithCustomError(replacement, "ReadUnavailable");
    expect(await shepherd.pendingBackupOracle()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.backupProposedAt()).to.equal(0);
    expect(await shepherd.backupOracle()).to.equal(backup.target);
  });

  for (const timestamp of [0n, ethers.MaxUint256]) {
    it(`does not validate a decodable zero price or timestamp ${timestamp} during migration`, async function () {
      const { admin, replacement, shepherd } = await loadFixture(fixture);
      await replacement.configureRead(0, timestamp, 0);
      await shepherd.connect(admin).proposeBackupChange(replacement.target);
      await shepherd.connect(admin).pause();
      await time.increase(600);
      await shepherd.connect(admin).executeBackupChange();
      expect(await shepherd.backupOracle()).to.equal(replacement.target);
    });
  }

  it("rejects missing code at construction/proposal/execution and permits cancellation", async function () {
    const f = await loadFixture(fixture);
    const code = "0x";
    // Test-only code replacement simulates a target changing behavior after proposal.
    await setCode(f.alternate.target, code);
    f.args[2] = f.alternate.target;
    await expect(f.Shepherd.deploy(...f.args)).to.be.reverted;
    await expect(f.shepherd.connect(f.admin).proposeBackupChange(f.alternate.target)).to.be.reverted;
    await f.shepherd.connect(f.admin).proposeBackupChange(f.replacement.target);
    const start = await f.shepherd.backupProposedAt();
    await f.shepherd.connect(f.admin).pause();
    await time.increase(600);
    await setCode(f.replacement.target, code);
    await expect(f.shepherd.connect(f.admin).executeBackupChange()).to.be.reverted;
    expect(await f.shepherd.backupOracle()).to.equal(f.backup.target);
    expect(await f.shepherd.pendingBackupOracle()).to.equal(f.replacement.target);
    expect(await f.shepherd.backupProposedAt()).to.equal(start);
    await f.shepherd.connect(f.admin).cancelBackupChange();
    await f.shepherd.connect(f.admin).unpause();
  });
});

describe("TellorShepherd - TWAP reference validation", function () {
  const { time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
  const h = require("../src/helpers/evmHelpers");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encode = (value) => coder.encode(["uint256"], [value]);
  const empty = [false, [0n, 0n, 0n, 0n, 0n, 0n]];

  async function fixture() {
    const [admin] = await ethers.getSigners();
    const queryId = ethers.id("shepherd-twap-feed");
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target);
    const Backup = await ethers.getContractFactory("BackupOracleMock");
    const backup = await Backup.deploy(queryId);
    const Harness = await ethers.getContractFactory("TellorShepherdHarness");
    const args = [queryId, bank.target, backup.target, admin.address, 60, 120, 300, 600, 30000, 2000, [30, 90]];
    const shepherd = await Harness.deploy(...args);
    return { admin, queryId, validatorSet, bank, backup, Harness, args, shepherd, startTime: (await time.latest() - 10800) * 1000 + 17 };
  }

  async function append(f, offset, price) {
    const report = await h.prepareOracleData(f.queryId, encode(price), f.validatorSet, {
      aggregateTimestamp: f.startTime + offset,
      attestationTimestamp: (await time.latest()) * 1000,
      previousTimestamp: f.startTime - 1,
    });
    await f.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    return (await f.bank.getCurrentAggregateData(f.queryId)).relayTimestamp;
  }

  it("distinguishes missing references from consumer readability and preserves strict relay maturity", async function () {
    const f = await loadFixture(fixture);
    expect(await f.shepherd.readTwapReference()).to.deep.equal(empty);
    const firstRelay = await append(f, 0, 100);
    await time.increaseTo(firstRelay + 61n);
    expect(await f.shepherd.readTwapReference()).to.deep.equal(empty);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, BigInt(f.startTime)]);
    const lastRelay = await append(f, 30000, 900);
    await time.increaseTo(lastRelay + 60n);
    expect(await f.shepherd.readTwapReference()).to.deep.equal(empty);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
    await time.increase(1);
    expect(await f.shepherd.readTwapReference())
      .to.deep.equal([true, [100n, 0n, 1n, BigInt(f.startTime), BigInt(f.startTime + 30000), 1n]]);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(900);
  });

  it("accepts a two-record, two-hour interval for a 30-second window, even paused or much later", async function () {
    const f = await loadFixture(fixture);
    await append(f, 0, 100);
    const lastRelay = await append(f, 7200000, 900);
    await time.increaseTo(lastRelay + 61n);
    const expected = [true, [100n, 0n, 1n, BigInt(f.startTime), BigInt(f.startTime + 7200000), 1n]];
    expect(await f.shepherd.readTwapReference()).to.deep.equal(expected);
    await f.shepherd.pause();
    expect(await f.shepherd.readTwapReference()).to.deep.equal(expected);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
    await time.increase(7 * 86400);
    expect(await f.shepherd.readTwapReference()).to.deep.equal(expected);
  });

  it("preserves the real bank's floored average and excludes an immature latest observation", async function () {
    const f = await loadFixture(fixture);
    await append(f, 0, 100);
    await append(f, 10001, 120);
    const endpoint = await append(f, 30003, 900);
    await time.increaseTo(endpoint + 61n);
    await append(f, 40000, (1n << 192n) - 1n);
    expect(await f.shepherd.readTwapReference())
      .to.deep.equal([true, [113n, 0n, 2n, BigInt(f.startTime), BigInt(f.startTime + 30003), 2n]]);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(900);
    const args = [...f.args];
    args[8] = ethers.MaxUint256;
    args[10] = [ethers.MaxUint256, 90];
    const longerWindow = await f.Harness.deploy(...args);
    expect(await longerWindow.readTwapReference()).to.deep.equal(empty);
    expect((await longerWindow.getCurrentValue())[0]).to.equal(900);
  });

  async function faultyFixture() {
    const f = await fixture();
    const Mock = await ethers.getContractFactory("TwapDataBankMock");
    const mock = await Mock.deploy();
    const start = [encode(100), 1n, BigInt(f.startTime), BigInt(f.startTime), 1n];
    const end = [encode(500), 1n, BigInt(f.startTime + 30000), BigInt(f.startTime + 30000), 2n];
    const twap = [100n, 0n, 1n, start[2], end[2], 1n];
    await mock.configureRecord(0, start);
    await mock.configureRecord(1, end);
    await mock.configureEnd(true, end);
    await mock.configureTwap(true, twap, 0);
    await mock.configureCandidate(end);
    const args = [...f.args];
    args[1] = mock.target;
    const shepherd = await f.Harness.deploy(...args);
    return { ...f, mock, start, end, twap, shepherd };
  }

  it("discards payloads marked unavailable rather than treating them as an in-band result", async function () {
    const f = await loadFixture(faultyFixture);
    await f.mock.configureTwap(false, f.twap, 0);
    expect(await f.shepherd.readTwapReference()).to.deep.equal(empty);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(500);
  });

  for (const [label, mutate] of [
    ["zero value", (t) => { t[0] = 0n; }],
    ["equal indices", (t) => { t[1] = t[2]; }],
    ["reversed indices", (t) => { t[1] = t[2] + 1n; }],
    ["equal timestamps", (t) => { t[3] = t[4]; }],
    ["reversed timestamps", (t) => { t[3] = t[4] + 1n; }],
    ["inconsistent contributor count", (t) => { t[5] = 2n; }],
    ["duration below the requested minimum", (t) => { t[3] += 1n; }],
    ["start timestamp inconsistent with indexed history", (t) => { t[3] -= 1n; }],
    ["end timestamp inconsistent with indexed history", (t) => { t[4] += 1n; }],
  ]) {
    it(`rejects a TWAP with ${label} without affecting primary reads`, async function () {
      const f = await loadFixture(faultyFixture);
      const malformed = [...f.twap];
      mutate(malformed);
      await f.mock.configureTwap(true, malformed, 0);
      await expect(f.shepherd.readTwapReference()).to.be.revertedWithCustomError(f.shepherd, "InvalidTwapReference");
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(500);
    });
  }

  it("requires the indexed endpoint to match the strict delayed selection", async function () {
    const f = await loadFixture(faultyFixture);
    expect((await f.shepherd.readTwapReference())[0]).to.equal(true);
    await f.mock.configureEnd(false, f.end);
    await expect(f.shepherd.readTwapReference()).to.be.revertedWithCustomError(f.shepherd, "InvalidTwapReference");
    await f.mock.configureEnd(true, f.start);
    await expect(f.shepherd.readTwapReference()).to.be.revertedWithCustomError(f.shepherd, "InvalidTwapReference");
    await f.mock.configureEnd(true, [...f.end.slice(0, 4), 3n]);
    await expect(f.shepherd.readTwapReference()).to.be.revertedWithCustomError(f.shepherd, "InvalidTwapReference");
    const futureEnd = [...f.end];
    futureEnd[4] = BigInt(await time.latest()) + 1000n;
    await f.mock.configureRecord(1, futureEnd);
    await f.mock.configureEnd(true, futureEnd);
    await expect(f.shepherd.readTwapReference()).to.be.revertedWithCustomError(f.shepherd, "InvalidTwapReference");
  });

  it("propagates TWAP reverts and malformed ABI responses without blocking consumer reads", async function () {
    const f = await loadFixture(faultyFixture);
    await f.mock.configureTwap(true, f.twap, 1);
    await expect(f.shepherd.readTwapReference()).to.be.revertedWithCustomError(f.mock, "TwapUnavailable");
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(500);
    await f.mock.configureTwap(true, f.twap, 2);
    await expect(f.shepherd.readTwapReference()).to.be.reverted;
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(500);
  });

  it("diagnoses the latest same-block relay while reads keep the mature value, including while paused", async function () {
    const f = await loadFixture(fixture);
    expect(await f.shepherd.readDeviation()).to.deep.equal([false, false]);
    await append(f, 0, 100);
    const endpoint = await append(f, 30000, 100);
    await time.increaseTo(endpoint + 61n);
    expect(await f.shepherd.readDeviation()).to.deep.equal([true, false]);
    const latestRelay = await append(f, 40000, 121);
    expect(BigInt(await time.latest())).to.equal(latestRelay);
    expect(await f.shepherd.readDeviation()).to.deep.equal([true, true]);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
    await time.increaseTo(latestRelay + 61n);
    expect(await f.shepherd.readDeviation()).to.deep.equal([true, true]);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(121);
    await f.shepherd.pause();
    expect(await f.shepherd.readDeviation()).to.deep.equal([true, true]);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
  });

  it("keeps unavailable history distinct from in-band data without blocking a mature read", async function () {
    const f = await loadFixture(fixture);
    const first = await append(f, 0, 100);
    await time.increaseTo(first + 61n);
    expect(await f.shepherd.readDeviation()).to.deep.equal([false, false]);
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
    await f.shepherd.pause();
    expect(await f.shepherd.readDeviation()).to.deep.equal([false, false]);
  });

  it("matches exact rational comparisons at equality, fractional boundaries, and uint256 extremes", async function () {
    const f = await loadFixture(faultyFixture);
    for (const threshold of [1n, 2000n, 9999n]) {
      const args = [...f.args];
      args[1] = f.mock.target;
      args[9] = threshold;
      const shepherd = await f.Harness.deploy(...args);
      for (const reference of [1n, 100n, 10001n, (1n << 192n) - 1n, ethers.MaxUint256]) {
        await f.mock.configureTwap(true, [reference, ...f.twap.slice(1)], 0);
        const boundary = reference * threshold / 10000n;
        const candidates = new Set([1n, ethers.MaxUint256, reference,
          reference - boundary, reference - boundary - 1n,
          reference + boundary, reference + boundary + 1n]);
        for (const candidate of candidates) {
          if (candidate <= 0n || candidate > ethers.MaxUint256) continue;
          await f.mock.configureCandidate([encode(candidate), ...f.end.slice(1)]);
          const difference = candidate > reference ? candidate - reference : reference - candidate;
          // Independent unbounded cross-product oracle avoids mirroring Solidity's decomposition.
          const expected = difference * 10000n > reference * threshold;
          expect(await shepherd.readDeviation(), `R=${reference}, P=${candidate}, T=${threshold}`)
            .to.deep.equal([true, expected]);
        }
      }
    }
  });

  it("rejects malformed or zero candidates but preserves first-word decoding with trailing bytes", async function () {
    const f = await loadFixture(faultyFixture);
    for (const [payload, error] of [["0x", "InvalidValueLength"],
      ["0x" + "11".repeat(31), "InvalidValueLength"], [encode(0), "ZeroValue"]]) {
      await f.mock.configureCandidate([payload, ...f.end.slice(1)]);
      await expect(f.shepherd.readDeviation()).to.be.revertedWithCustomError(f.shepherd, error);
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(500);
    }
    await f.mock.configureCandidate([encode(120) + "aabb", ...f.end.slice(1)]);
    expect(await f.shepherd.readDeviation()).to.deep.equal([true, false]);
  });

  it("propagates failed diagnostics without interpreting them as resolution or blocking reads", async function () {
    const f = await loadFixture(faultyFixture);
    await f.mock.configureTwap(false, f.twap, 0);
    expect(await f.shepherd.readDeviation()).to.deep.equal([false, false]);
    await f.mock.configureTwap(true, [0n, ...f.twap.slice(1)], 0);
    await expect(f.shepherd.readDeviation()).to.be.revertedWithCustomError(f.shepherd, "InvalidTwapReference");
    for (const failure of [1, 2]) {
      await f.mock.configureTwap(true, f.twap, failure);
      await expect(f.shepherd.readDeviation()).to.be.reverted;
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(500);
    }
  });

  describe("Challenge request and cancellation", function () {
    async function challengeFixture() {
      const f = await fixture();
      const [, requester, canceller] = await ethers.getSigners();
      await append(f, 0, 100);
      const endpoint = await append(f, 30000, 100);
      await time.increaseTo(endpoint + 61n);
      await append(f, 40000, 121);
      return { ...f, requester, canceller };
    }

    async function expectPending(shepherd, pending, timestamp) {
      expect(await shepherd.challengePending()).to.equal(pending);
      expect(await shepherd.challengeRequestedAt()).to.equal(timestamp);
    }

    for (const paused of [false, true]) {
      it(`allows different outsiders to request and immediately cancel with paused=${paused}`, async function () {
        const f = await loadFixture(challengeFixture);
        await expectPending(f.shepherd, false, 0);
        if (paused) await f.shepherd.pause();
        const pauseClock = await f.shepherd.pausedAt();
        const requestTime = (await time.latest()) + 1;
        await time.setNextBlockTimestamp(requestTime);
        await expect(f.shepherd.connect(f.requester).requestChallenge())
          .to.emit(f.shepherd, "ChallengeRequested").withArgs(f.requester.address, requestTime);
        await expectPending(f.shepherd, true, requestTime);
        // Exact upper threshold equality is sufficient evidence of resolution.
        await append(f, 50000, 120);
        await expect(f.shepherd.connect(f.canceller).cancelChallenge())
          .to.emit(f.shepherd, "ChallengeCancelled").withArgs(f.canceller.address);
        expect(BigInt(await time.latest()) - BigInt(requestTime)).to.be.lessThan(await f.shepherd.CHALLENGE_DELAY_SECONDS());
        await expectPending(f.shepherd, false, 0);
        expect(await f.shepherd.mode()).to.equal(0);
        expect(await f.shepherd.paused()).to.equal(paused);
        expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
        await expect(f.shepherd.cancelChallenge()).to.be.revertedWithCustomError(f.shepherd, "NoPendingChallenge");
      });

      it(`rejects in-band and unavailable requests with paused=${paused}`, async function () {
        const f = await loadFixture(fixture);
        if (paused) await f.shepherd.pause();
        await expect(f.shepherd.requestChallenge()).to.be.revertedWithCustomError(f.shepherd, "DiagnosticUnavailable");
        await append(f, 0, 100);
        const endpoint = await append(f, 30000, 80);
        await time.increaseTo(endpoint + 61n);
        await expect(f.shepherd.requestChallenge()).to.be.revertedWithCustomError(f.shepherd, "NotDeviating");
        await expectPending(f.shepherd, false, 0);
      });
    }

    it("executes permissionlessly at exact delay equality and immediately routes to backup", async function () {
      const f = await loadFixture(challengeFixture);
      await f.backup.configureRead(777, 123456789, 0);
      await expect(f.shepherd.executeChallenge()).to.be.revertedWithCustomError(f.shepherd, "NoPendingChallenge");
      await f.shepherd.connect(f.requester).requestChallenge();
      const start = await f.shepherd.challengeRequestedAt();
      const deadline = start + await f.shepherd.CHALLENGE_DELAY_SECONDS();
      await time.setNextBlockTimestamp(deadline - 1n);
      await expect(f.shepherd.connect(f.canceller).executeChallenge())
        .to.be.revertedWithCustomError(f.shepherd, "ChallengeDelayNotElapsed");
      await expectPending(f.shepherd, true, start);
      expect(await f.shepherd.mode()).to.equal(0);
      await time.setNextBlockTimestamp(deadline);
      await expect(f.shepherd.connect(f.canceller).executeChallenge())
        .to.emit(f.shepherd, "ChallengeExecuted").withArgs(f.canceller.address);
      await expectPending(f.shepherd, false, 0);
      expect(await f.shepherd.mode()).to.equal(1);
      expect(await f.shepherd.paused()).to.equal(false);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([777n, 123456789n]);
      for (const action of ["executeChallenge", "requestChallenge", "cancelChallenge"]) {
        await expect(f.shepherd[action]()).to.be.revertedWithCustomError(f.shepherd, "NotPrimaryMode");
      }
      // Neither primary reads nor TWAP diagnostics may gate a selected backup read.
      await setCode(f.bank.target, "0x60006000fd");
      for (const timestamp of [0n, BigInt(await time.latest()) * 1000n + 1000000n]) {
        await f.backup.configureRead(888, timestamp, 0);
        expect(await f.shepherd.getCurrentValue()).to.deep.equal([888n, timestamp]);
      }
    });

    it("preserves pause through execution and serves backup only after valid unpause", async function () {
      const f = await loadFixture(challengeFixture);
      await f.shepherd.pause();
      const pauseClock = await f.shepherd.pausedAt();
      await f.shepherd.connect(f.requester).requestChallenge();
      await time.increase(30);
      await f.shepherd.connect(f.canceller).executeChallenge();
      expect(await f.shepherd.mode()).to.equal(1);
      expect(await f.shepherd.paused()).to.equal(true);
      expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
      await expectPending(f.shepherd, false, 0);
      // The backup currently reverts; the global pause guard must win first.
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
      await expect(f.shepherd.unpause()).to.be.revertedWithCustomError(f.shepherd, "PauseDurationNotElapsed");
      await f.backup.configureRead(777, 17, 0);
      await time.setNextBlockTimestamp(pauseClock + await f.shepherd.MIN_PAUSE_DURATION());
      await f.shepherd.unpause();
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([777n, 17n]);
    });

    for (const behavior of ["unavailable", "zero", "malformed"]) {
      it(`selects a ${behavior} backup, then refuses reads without falling back to primary`, async function () {
        const f = await loadFixture(challengeFixture);
        await f.backup.configureRead(0, 17, behavior === "unavailable" ? 1 : behavior === "malformed" ? 2 : 0);
        await f.shepherd.requestChallenge();
        await time.increase(30);
        await f.shepherd.executeChallenge();
        expect(await f.shepherd.mode()).to.equal(1);
        await expectPending(f.shepherd, false, 0);
        if (behavior === "unavailable") {
          await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.backup, "ReadUnavailable");
        } else if (behavior === "zero") {
          await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ZeroValue");
        } else await expect(f.shepherd.getCurrentValue()).to.be.reverted;
        // A later usable backup observation needs no second switch or waiting period.
        await f.backup.configureRead(555, 123, 0);
        expect(await f.shepherd.getCurrentValue()).to.deep.equal([555n, 123n]);
      });
    }

    it("rejects resolved deviation while paused without clearing the elapsed challenge", async function () {
      const f = await loadFixture(challengeFixture);
      await f.shepherd.requestChallenge();
      const start = await f.shepherd.challengeRequestedAt();
      await f.shepherd.pause();
      await append(f, 50000, 120);
      await time.increase(30);
      await expect(f.shepherd.executeChallenge()).to.be.revertedWithCustomError(f.shepherd, "NotDeviating");
      await expectPending(f.shepherd, true, start);
      expect(await f.shepherd.mode()).to.equal(0);
      await append(f, 60000, 121);
      await f.shepherd.executeChallenge();
      expect(await f.shepherd.mode()).to.equal(1);
      expect(await f.shepherd.paused()).to.equal(true);
    });

    describe("Recovery request and explicit cancellation", function () {
      async function recoveryFixture() {
        const f = await challengeFixture();
        await f.shepherd.requestChallenge();
        await time.increase(30);
        await f.shepherd.executeChallenge();
        return f;
      }

      async function expectRecovery(shepherd, pending, timestamp) {
        expect(await shepherd.recoveryPending()).to.equal(pending);
        expect(await shepherd.recoveryRequestedAt()).to.equal(timestamp);
        expect(await shepherd.mode()).to.equal(1);
        expect(await shepherd.challengePending()).to.equal(false);
        expect(await shepherd.challengeRequestedAt()).to.equal(0);
      }

      it("executes at exact equality, preserves failed attempts, and immediately serves primary", async function () {
        const f = await loadFixture(recoveryFixture);
        await expect(f.shepherd.executeRecovery()).to.be.revertedWithCustomError(f.shepherd, "NoPendingRecovery");
        await f.backup.configureRecovery(true, 0);
        await f.shepherd.connect(f.requester).requestRecovery();
        const start = await f.shepherd.recoveryRequestedAt();
        const deadline = start + await f.shepherd.RECOVERY_DELAY_SECONDS();
        await time.setNextBlockTimestamp(deadline - 1n);
        await expect(f.shepherd.connect(f.canceller).executeRecovery())
          .to.be.revertedWithCustomError(f.shepherd, "RecoveryDelayNotElapsed");
        await expectRecovery(f.shepherd, true, start);
        await time.setNextBlockTimestamp(deadline);
        await expect(f.shepherd.connect(f.canceller).executeRecovery())
          .to.emit(f.shepherd, "RecoveryExecuted").withArgs(f.canceller.address);
        expect(await f.shepherd.mode()).to.equal(0);
        expect(await f.shepherd.recoveryPending()).to.equal(false);
        expect(await f.shepherd.recoveryRequestedAt()).to.equal(0);
        expect(await f.shepherd.paused()).to.equal(false);
        expect((await f.shepherd.getCurrentValue())[0]).to.equal(121);
        for (const action of ["executeRecovery", "requestRecovery", "cancelRecovery"]) {
          await expect(f.shepherd[action]()).to.be.revertedWithCustomError(f.shepherd, "NotBackupMode");
        }
      });

      it("retains a paused recovery through false and broken assessments, then preserves pause on success", async function () {
        const f = await loadFixture(recoveryFixture);
        await f.backup.configureRecovery(true, 0);
        await f.shepherd.requestRecovery();
        const start = await f.shepherd.recoveryRequestedAt();
        await f.shepherd.pause();
        const pauseClock = await f.shepherd.pausedAt();
        await time.increase(90);
        for (const behavior of [0, 1, 2]) {
          await f.backup.configureRecovery(false, behavior);
          const call = f.shepherd.connect(f.canceller).executeRecovery();
          if (behavior === 0) await expect(call).to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
          else if (behavior === 1) await expect(call).to.be.revertedWithCustomError(f.backup, "RecoveryUnavailable");
          else await expect(call).to.be.reverted;
          await expectRecovery(f.shepherd, true, start);
          expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
        }
        await f.backup.configureRecovery(true, 0);
        await f.shepherd.executeRecovery();
        expect(await f.shepherd.mode()).to.equal(0);
        expect(await f.shepherd.paused()).to.equal(true);
        expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
        expect(await f.shepherd.recoveryPending()).to.equal(false);
        expect(await f.shepherd.recoveryRequestedAt()).to.equal(0);
        await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
        await expect(f.shepherd.unpause()).to.be.revertedWithCustomError(f.shepherd, "PauseDurationNotElapsed");
        await time.setNextBlockTimestamp(pauseClock + await f.shepherd.MIN_PAUSE_DURATION());
        await f.shepherd.unpause();
        expect((await f.shepherd.getCurrentValue())[0]).to.equal(121);
      });

      it("trusts recovery assessment without a primary-read prerequisite or backup fallback", async function () {
        const f = await loadFixture(recoveryFixture);
        await f.backup.configureRecovery(true, 0);
        await f.backup.configureRead(777, 123, 0);
        await f.shepherd.requestRecovery();
        await setCode(f.bank.target, "0x60006000fd");
        await time.increase(90);
        await f.shepherd.executeRecovery();
        expect(await f.shepherd.mode()).to.equal(0);
        await expect(f.shepherd.getCurrentValue()).to.be.reverted;
      });

      for (const source of ["DataBank", "Backup"]) {
        for (const transition of ["Challenge", "Recovery"]) {
          it(`invalidates ${transition} only on successful ${source} replacement and requires a fresh timer`, async function () {
            const f = await loadFixture(transition === "Challenge" ? challengeFixture : recoveryFixture);
            if (transition === "Recovery") await f.backup.configureRecovery(true, 0);
            await f.shepherd[`request${transition}`]();
            const clock = `${transition.toLowerCase()}RequestedAt`;
            const pending = `${transition.toLowerCase()}Pending`;
            const original = await f.shepherd[clock]();
            const mode = await f.shepherd.mode();
            await f.shepherd.pause();
            const pauseClock = await f.shepherd.pausedAt();
            let replacement;
            if (source === "DataBank") {
              replacement = await (await ethers.getContractFactory("TellorDataBank")).deploy(await f.bank.dataBridge());
              const next = { ...f, bank: replacement };
              await append(next, 0, 100);
              await append(next, 30000, 100);
              await append(next, 40000, 121);
            } else {
              replacement = await (await ethers.getContractFactory("BackupOracleMock")).deploy(f.queryId);
              await replacement.configureRead(100, 123456, 0);
              await replacement.configureRecovery(true, 0);
            }
            const propose = `propose${source}Change`;
            const cancel = `cancel${source}Change`;
            const execute = `execute${source}Change`;
            await f.shepherd[propose](replacement.target);
            expect(await f.shepherd[clock]()).to.equal(original);
            await f.shepherd[cancel]();
            expect(await f.shepherd[pending]()).to.equal(true);
            expect(await f.shepherd[clock]()).to.equal(original);
            await f.shepherd[propose](replacement.target);
            await expect(f.shepherd[execute]()).to.be.revertedWithCustomError(f.shepherd,
              source === "DataBank" ? "DataBankChangeDelayNotElapsed" : "BackupChangeDelayNotElapsed");
            await time.increase(600);
            const code = await ethers.provider.getCode(replacement.target);
            await setCode(replacement.target, "0x60006000fd");
            await expect(f.shepherd[execute]()).to.be.reverted;
            expect(await f.shepherd[pending]()).to.equal(true);
            expect(await f.shepherd[clock]()).to.equal(original);
            await setCode(replacement.target, code);
            // Invalidating a request must not consult either old dependency.
            const old = source === "DataBank" ? f.bank : f.backup;
            const oldCode = await ethers.provider.getCode(old.target);
            await setCode(old.target, "0x60006000fd");
            await expect(f.shepherd[execute]()).to.emit(f.shepherd, `${transition}Invalidated`);
            expect(await f.shepherd.challengePending()).to.equal(false);
            expect(await f.shepherd.challengeRequestedAt()).to.equal(0);
            expect(await f.shepherd.recoveryPending()).to.equal(false);
            expect(await f.shepherd.recoveryRequestedAt()).to.equal(0);
            expect(await f.shepherd.mode()).to.equal(mode);
            expect(await f.shepherd.paused()).to.equal(true);
            expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
            await expect(f.shepherd[`execute${transition}`]()).to.be.revertedWithCustomError(f.shepherd, `NoPending${transition}`);
            await setCode(old.target, oldCode);
            await f.shepherd[`request${transition}`]();
            expect(await f.shepherd[clock]()).to.be.greaterThan(original);
            await expect(f.shepherd[`execute${transition}`]()).to.be.revertedWithCustomError(f.shepherd, `${transition}DelayNotElapsed`);
          });
        }
      }

      for (const paused of [false, true]) {
        it(`allows outsiders to request and immediately cancel with paused=${paused}`, async function () {
          const f = await loadFixture(recoveryFixture);
          await expectRecovery(f.shepherd, false, 0);
          if (paused) await f.shepherd.pause();
          const pauseClock = await f.shepherd.pausedAt();
          await f.backup.configureRecovery(true, 0);
          const requestedAt = (await time.latest()) + 1;
          await time.setNextBlockTimestamp(requestedAt);
          // Backup reads are unavailable by default: price availability is not recovery assessment.
          await expect(f.shepherd.connect(f.requester).requestRecovery())
            .to.emit(f.shepherd, "RecoveryRequested").withArgs(f.requester.address, requestedAt);
          await expectRecovery(f.shepherd, true, requestedAt);
          await f.backup.configureRecovery(false, 0);
          await expect(f.shepherd.connect(f.canceller).cancelRecovery())
            .to.emit(f.shepherd, "RecoveryCancelled").withArgs(f.canceller.address);
          expect(BigInt(await time.latest()) - BigInt(requestedAt)).to.be.lessThan(await f.shepherd.RECOVERY_DELAY_SECONDS());
          await expectRecovery(f.shepherd, false, 0);
          expect(await f.shepherd.paused()).to.equal(paused);
          expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
          await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(
            paused ? f.shepherd : f.backup, paused ? "ShepherdPaused" : "ReadUnavailable");
        });

        it(`rejects negative request assessments and positive cancellation assessments with paused=${paused}`, async function () {
          const f = await loadFixture(recoveryFixture);
          if (paused) await f.shepherd.pause();
          await expect(f.shepherd.requestRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
          await expectRecovery(f.shepherd, false, 0);
          await f.backup.configureRecovery(true, 0);
          await f.shepherd.requestRecovery();
          const start = await f.shepherd.recoveryRequestedAt();
          await expect(f.shepherd.cancelRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryStillAllowed");
          await expectRecovery(f.shepherd, true, start);
        });
      }

      it("rejects primary-mode actions and cancellation without a request", async function () {
        const f = await loadFixture(challengeFixture);
        for (const action of ["requestRecovery", "cancelRecovery"]) {
          await expect(f.shepherd[action]()).to.be.revertedWithCustomError(f.shepherd, "NotBackupMode");
        }
        const b = await loadFixture(recoveryFixture);
        await expect(b.shepherd.cancelRecovery()).to.be.revertedWithCustomError(b.shepherd, "NoPendingRecovery");
        await expectRecovery(b.shepherd, false, 0);
      });

      it("retains the original timer across transient false assessments and long waits", async function () {
        const f = await loadFixture(recoveryFixture);
        await f.backup.configureRead(777, 123, 0);
        await f.backup.configureRecovery(true, 0);
        await f.shepherd.connect(f.requester).requestRecovery();
        const start = await f.shepherd.recoveryRequestedAt();
        await f.backup.configureRecovery(false, 0);
        expect(await f.backup.canRecover(f.queryId)).to.equal(false);
        await time.increase(86400);
        await expect(f.shepherd.connect(f.canceller).requestRecovery())
          .to.be.revertedWithCustomError(f.shepherd, "RecoveryAlreadyPending");
        await expectRecovery(f.shepherd, true, start);
        await f.backup.configureRecovery(true, 0);
        await expect(f.shepherd.requestRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryAlreadyPending");
        await expectRecovery(f.shepherd, true, start);
        expect(await f.shepherd.getCurrentValue()).to.deep.equal([777n, 123n]);
        await f.backup.configureRecovery(false, 0);
        await f.shepherd.connect(f.canceller).cancelRecovery();
        await expectRecovery(f.shepherd, false, 0);
        await expect(f.shepherd.cancelRecovery()).to.be.revertedWithCustomError(f.shepherd, "NoPendingRecovery");
        await f.backup.configureRecovery(true, 0);
        await f.shepherd.connect(f.requester).requestRecovery();
        expect(await f.shepherd.recoveryRequestedAt()).to.be.greaterThan(start);
        expect(await f.shepherd.getCurrentValue()).to.deep.equal([777n, 123n]);
      });

      for (const behavior of [1, 2]) {
        it(`preserves recovery state on ${behavior === 1 ? "reverting" : "malformed"} assessments`, async function () {
          const f = await loadFixture(recoveryFixture);
          await f.shepherd.pause();
          const pauseClock = await f.shepherd.pausedAt();
          async function expectFailure(call) {
            if (behavior === 1) await expect(call).to.be.revertedWithCustomError(f.backup, "RecoveryUnavailable");
            else await expect(call).to.be.reverted;
          }
          await f.backup.configureRecovery(true, behavior);
          await expectFailure(f.shepherd.requestRecovery());
          await expectRecovery(f.shepherd, false, 0);
          await f.backup.configureRecovery(true, 0);
          await f.shepherd.requestRecovery();
          const start = await f.shepherd.recoveryRequestedAt();
          await f.backup.configureRecovery(false, behavior);
          await expectFailure(f.shepherd.cancelRecovery());
          await expectRecovery(f.shepherd, true, start);
          expect(await f.shepherd.paused()).to.equal(true);
          expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
        });
      }
    });

    it("rejects duplicate requests without resetting the clock, even after its delay", async function () {
      const f = await loadFixture(challengeFixture);
      await f.shepherd.connect(f.requester).requestChallenge();
      const start = await f.shepherd.challengeRequestedAt();
      await f.shepherd.pause();
      await time.increase(100);
      await expect(f.shepherd.connect(f.canceller).requestChallenge())
        .to.be.revertedWithCustomError(f.shepherd, "ChallengeAlreadyPending");
      await expect(f.shepherd.connect(f.canceller).cancelChallenge())
        .to.be.revertedWithCustomError(f.shepherd, "StillDeviating");
      await expectPending(f.shepherd, true, start);
    });

    it("does not halt mature reads while a challenge is pending", async function () {
      const f = await loadFixture(challengeFixture);
      await f.shepherd.requestChallenge();
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
      await time.increase(61);
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(121);
      expect(await f.shepherd.challengePending()).to.equal(true);
    });

    it("retains an uncancelled clock through oscillation but starts fresh after explicit cancellation", async function () {
      const f = await loadFixture(challengeFixture);
      await f.shepherd.requestChallenge();
      const original = await f.shepherd.challengeRequestedAt();
      await append(f, 50000, 100);
      expect(await f.shepherd.readDeviation()).to.deep.equal([true, false]);
      await expectPending(f.shepherd, true, original);
      await append(f, 60000, 79);
      await expect(f.shepherd.cancelChallenge()).to.be.revertedWithCustomError(f.shepherd, "StillDeviating");
      await expectPending(f.shepherd, true, original);
      await append(f, 70000, 80);
      await f.shepherd.connect(f.canceller).cancelChallenge();
      await expectPending(f.shepherd, false, 0);
      await append(f, 80000, 121);
      await f.shepherd.connect(f.requester).requestChallenge();
      expect(await f.shepherd.challengeRequestedAt()).to.be.greaterThan(original);
      expect(await f.shepherd.challengePending()).to.equal(true);
    });

    it("rejects both actions in backup mode and cancellation without a pending request", async function () {
      const f = await loadFixture(challengeFixture);
      await expect(f.shepherd.cancelChallenge()).to.be.revertedWithCustomError(f.shepherd, "NoPendingChallenge");
      await f.shepherd.requestChallenge();
      const start = await f.shepherd.challengeRequestedAt();
      await f.shepherd.setModeForTest(1);
      await expect(f.shepherd.requestChallenge()).to.be.revertedWithCustomError(f.shepherd, "NotPrimaryMode");
      await expect(f.shepherd.cancelChallenge()).to.be.revertedWithCustomError(f.shepherd, "NotPrimaryMode");
      await expectPending(f.shepherd, true, start);
    });

    for (const fault of ["unavailable", "revert", "malformed ABI", "invalid reference", "invalid candidate"]) {
      it(`preserves state on ${fault} during requests, paused cancellations, and executions`, async function () {
        const f = await loadFixture(faultyFixture);
        const healthyTwap = [...f.twap];
        async function breakDiagnostic() {
          if (fault === "invalid candidate") {
            await f.mock.configureCandidate([encode(0), ...f.end.slice(1)]);
          } else {
            const value = fault === "invalid reference" ? [0n, ...f.twap.slice(1)] : f.twap;
            await f.mock.configureTwap(fault !== "unavailable", value,
              fault === "revert" ? 1 : fault === "malformed ABI" ? 2 : 0);
          }
        }
        async function expectFailure(call) {
          const errors = { unavailable: "DiagnosticUnavailable", "invalid reference": "InvalidTwapReference",
            "invalid candidate": "ZeroValue" };
          if (errors[fault]) await expect(call).to.be.revertedWithCustomError(f.shepherd, errors[fault]);
          else if (fault === "revert") await expect(call).to.be.revertedWithCustomError(f.mock, "TwapUnavailable");
          else await expect(call).to.be.reverted;
        }
        await breakDiagnostic();
        await expectFailure(f.shepherd.requestChallenge());
        await expectPending(f.shepherd, false, 0);
        await f.mock.configureTwap(true, healthyTwap, 0);
        await f.mock.configureCandidate(f.end);
        await f.shepherd.requestChallenge();
        const start = await f.shepherd.challengeRequestedAt();
        await f.shepherd.pause();
        await breakDiagnostic();
        await expectFailure(f.shepherd.cancelChallenge());
        await time.increase(30);
        await expectFailure(f.shepherd.executeChallenge());
        await expectPending(f.shepherd, true, start);
        expect(await f.shepherd.paused()).to.equal(true);
        expect(await f.shepherd.mode()).to.equal(0);
      });
    }
  });

});
