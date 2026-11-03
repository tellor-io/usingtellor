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
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const args = [queryId, bank.target, admin.address, 60, 120, 300, 30000, 2000, [30, 90]];
    return { deployer, admin, queryId, bank, Shepherd, args };
  }

  it("preserves explicit configuration and starts in primary mode with an empty bank", async function () {
    const { deployer, admin, queryId, bank, Shepherd, args } = await loadFixture(deployFixture);
    expect(await bank.getAggregateValueCount(queryId)).to.equal(0);
    const shepherd = await Shepherd.deploy(...args);
    await shepherd.waitForDeployment();

    expect(await shepherd.queryId()).to.equal(queryId);
    expect(await shepherd.dataBank()).to.equal(bank.target);
    expect(await shepherd.admin()).to.equal(admin.address);
    expect(await shepherd.admin()).not.to.equal(deployer.address);
    expect(await shepherd.RELAY_READ_DELAY()).to.equal(60);
    expect(await shepherd.mode()).to.equal(0); // Mode.PRIMARY
    expect(await shepherd.MIN_PAUSE_DURATION()).to.equal(120);
    expect(await shepherd.DATA_BANK_CHANGE_DELAY()).to.equal(300);
    expect(await shepherd.TWAP_WINDOW_MS()).to.equal(30000);
    expect(await shepherd.CHALLENGE_THRESHOLD_BPS()).to.equal(2000);
    expect(await shepherd.CHALLENGE_DELAY_SECONDS()).to.equal(30);
    expect(await shepherd.RECOVERY_DELAY_SECONDS()).to.equal(90);
    expect(await shepherd.pendingDataBank()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.dataBankProposedAt()).to.equal(0);
    expect(await shepherd.paused()).to.equal(false);
    expect(await shepherd.pausedAt()).to.equal(0);
  });

  const invalidCases = [
    ["zero query ID", 0, () => ethers.ZeroHash, "InvalidQueryId"],
    ["zero bank address", 1, () => ethers.ZeroAddress, "DataBankHasNoCode"],
    ["wallet bank address", 1, ({ deployer }) => deployer.address, "DataBankHasNoCode"],
    ["zero admin", 2, () => ethers.ZeroAddress, "InvalidAdmin"],
    ["zero read delay", 3, () => 0, "InvalidRelayReadDelay"],
    ["zero pause duration", 4, () => 0, "InvalidMinPauseDuration"],
    ["zero bank change delay", 5, () => 0, "InvalidDataBankChangeDelay"],
    ["zero recovery delay", 8, () => [30, 0], "InvalidRecoveryDelay"],
    ["zero TWAP window", 6, () => 0, "InvalidTwapWindow"],
    ["zero threshold", 7, () => 0, "InvalidChallengeThreshold"],
    ["100 percent threshold", 7, () => 10000, "InvalidChallengeThreshold"],
    ["oversized threshold", 7, () => ethers.MaxUint256, "InvalidChallengeThreshold"],
    ["zero challenge delay", 8, () => [0, 90], "InvalidChallengeDelay"],
    ["challenge delay shorter than window", 8, () => [29, 90], "InvalidChallengeDelay"],
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
      args[6] = window;
      const minimumSeconds = (window + 999n) / 1000n; // JS bigint is unbounded.
      args[8] = [minimumSeconds - 1n, 90];
      await expect(Shepherd.deploy(...args)).to.be.revertedWithCustomError(Shepherd, "InvalidChallengeDelay");
      args[8] = [minimumSeconds, 90];
      const shepherd = await Shepherd.deploy(...args);
      expect(await shepherd.CHALLENGE_DELAY_SECONDS()).to.equal(minimumSeconds);
    }
    for (const threshold of [1, 9999]) {
      args[7] = threshold;
      expect(await (await Shepherd.deploy(...args)).CHALLENGE_THRESHOLD_BPS()).to.equal(threshold);
    }
  });

  it("accepts positive recovery delays independently of the TWAP window", async function () {
    const { Shepherd, args: fixtureArgs } = await loadFixture(deployFixture);
    const args = [...fixtureArgs];
    for (const delay of [1n, ethers.MaxUint256]) {
      args[8] = [30, delay];
      expect(await (await Shepherd.deploy(...args)).RECOVERY_DELAY_SECONDS()).to.equal(delay);
    }
  });

  it("accepts the minimum positive delay in seconds", async function () {
    const { Shepherd, args: fixtureArgs } = await loadFixture(deployFixture);
    const args = [...fixtureArgs];
    args[3] = 1;
    args[4] = 1;
    args[5] = 1;
    args[6] = 1;
    const shepherd = await Shepherd.deploy(...args);
    expect(await shepherd.RELAY_READ_DELAY()).to.equal(1);
    expect(await shepherd.MIN_PAUSE_DURATION()).to.equal(1);
    expect(await shepherd.DATA_BANK_CHANGE_DELAY()).to.equal(1);
    expect(await shepherd.TWAP_WINDOW_MS()).to.equal(1);
  });
});

describe("TellorShepherd - Pauser membership", function () {
  async function deployPauserFixture() {
    const [deployer, admin, pauser, other] = await ethers.getSigners();
    const Lab = await ethers.getContractFactory("TellorLab");
    const source = await Lab.deploy();
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    // Membership operations do not read either source.
    const shepherd = await Shepherd.deploy(ethers.id("pauser-test-feed"), source.target, admin.address, 60, 120, 300, 30000, 2000, [30, 90]);
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
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    // This dependency cannot answer primary reads, allowing pause precedence tests.
    const shepherd = await Shepherd.deploy(ethers.id("pause-test-feed"), source.target,
      admin.address, 60, duration, 300, 30000, 2000, [30, 90]);
    await shepherd.connect(admin).addPauser(pauser.address);
    return { deployer, admin, pauser, outsider, source, Shepherd, shepherd };
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
    const { admin, source, Shepherd, shepherd } = await loadFixture(deployPauseFixture);
    await expect(shepherd.getCurrentValue()).to.be.reverted;
    await shepherd.connect(admin).pause();
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "ShepherdPaused");
    const underflow = await Shepherd.deploy(ethers.id("pause-test-feed"), source.target,
      admin.address, ethers.MaxUint256, duration, 300, 30000, 2000, [30, 90]);
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
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherd = await Shepherd.deploy(ethers.id("migration-feed"), bank.target,
      admin.address, 60, 120, changeDelay, 30000, 2000, [30, 90]);
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
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "NoTwapData");
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
    const Harness = await ethers.getContractFactory("TellorShepherdHarness");
    const args = [queryId, bank.target, admin.address, 60, 120, 300, 30000, 2000, [30, 90]];
    const shepherd = await Harness.deploy(...args);
    return { admin, queryId, validatorSet, bank, Harness, args, shepherd, startTime: (await time.latest() - 10800) * 1000 + 17 };
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

  it("requires TWAP coverage and preserves strict relay maturity", async function () {
    const f = await loadFixture(fixture);
    expect(await f.shepherd.readTwapReference()).to.deep.equal(empty);
    const firstRelay = await append(f, 0, 100);
    await time.increaseTo(firstRelay + 61n);
    expect(await f.shepherd.readTwapReference()).to.deep.equal(empty);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoTwapData");
    const lastRelay = await append(f, 30000, 900);
    await time.increaseTo(lastRelay + 60n);
    expect(await f.shepherd.readTwapReference()).to.deep.equal(empty);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoTwapData");
    await time.increase(1);
    expect(await f.shepherd.readTwapReference())
      .to.deep.equal([true, [100n, 0n, 1n, BigInt(f.startTime), BigInt(f.startTime + 30000), 1n]]);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, BigInt(f.startTime + 30000)]);
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
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([113n, BigInt(f.startTime + 30003)]);
    const args = [...f.args];
    args[6] = ethers.MaxUint256;
    args[8] = [ethers.MaxUint256, 90];
    const longerWindow = await f.Harness.deploy(...args);
    expect(await longerWindow.readTwapReference()).to.deep.equal(empty);
    await expect(longerWindow.getCurrentValue()).to.be.revertedWithCustomError(longerWindow, "NoTwapData");
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
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoTwapData");
    expect((await f.shepherd.readBackup())[0]).to.equal(500);
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
    it(`rejects a TWAP with ${label} and refuses primary reads`, async function () {
      const f = await loadFixture(faultyFixture);
      const malformed = [...f.twap];
      mutate(malformed);
      await f.mock.configureTwap(true, malformed, 0);
      await expect(f.shepherd.readTwapReference()).to.be.revertedWithCustomError(f.shepherd, "InvalidTwapReference");
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "InvalidTwapReference");
      expect((await f.shepherd.readBackup())[0]).to.equal(500);
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

  it("propagates TWAP reverts and malformed ABI responses without blocking spot reads", async function () {
    const f = await loadFixture(faultyFixture);
    await f.mock.configureTwap(true, f.twap, 1);
    await expect(f.shepherd.readTwapReference()).to.be.revertedWithCustomError(f.mock, "TwapUnavailable");
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.mock, "TwapUnavailable");
    expect((await f.shepherd.readBackup())[0]).to.equal(500);
    await f.mock.configureTwap(true, f.twap, 2);
    await expect(f.shepherd.readTwapReference()).to.be.reverted;
    await expect(f.shepherd.getCurrentValue()).to.be.reverted;
    expect((await f.shepherd.readBackup())[0]).to.equal(500);
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
    expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
    await f.shepherd.pause();
    expect(await f.shepherd.readDeviation()).to.deep.equal([true, true]);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
  });

  it("keeps unavailable history distinct from in-band data while only backup can serve a mature spot", async function () {
    const f = await loadFixture(fixture);
    const first = await append(f, 0, 100);
    await time.increaseTo(first + 61n);
    expect(await f.shepherd.readDeviation()).to.deep.equal([false, false]);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "NoTwapData");
    expect((await f.shepherd.readBackup())[0]).to.equal(100);
    await f.shepherd.pause();
    expect(await f.shepherd.readDeviation()).to.deep.equal([false, false]);
  });

  it("matches exact rational comparisons at equality, fractional boundaries, and uint256 extremes", async function () {
    const f = await loadFixture(faultyFixture);
    for (const threshold of [1n, 2000n, 9999n]) {
      const args = [...f.args];
      args[1] = f.mock.target;
      args[7] = threshold;
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
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, f.twap[4]]);
      expect((await f.shepherd.readBackup())[0]).to.equal(500);
    }
    await f.mock.configureCandidate([encode(120) + "aabb", ...f.end.slice(1)]);
    expect(await f.shepherd.readDeviation()).to.deep.equal([true, false]);
  });

  it("propagates failed diagnostics without interpreting them as resolution or blocking spot reads", async function () {
    const f = await loadFixture(faultyFixture);
    await f.mock.configureTwap(false, f.twap, 0);
    expect(await f.shepherd.readDeviation()).to.deep.equal([false, false]);
    await f.mock.configureTwap(true, [0n, ...f.twap.slice(1)], 0);
    await expect(f.shepherd.readDeviation()).to.be.revertedWithCustomError(f.shepherd, "InvalidTwapReference");
    for (const failure of [1, 2]) {
      await f.mock.configureTwap(true, f.twap, failure);
      await expect(f.shepherd.readDeviation()).to.be.reverted;
      expect((await f.shepherd.readBackup())[0]).to.equal(500);
    }
  });

  describe("Recovery from spot to TWAP", function () {
    async function recoveryFixture() {
      const f = await faultyFixture();
      const [, requester, executor] = await ethers.getSigners();
      await f.shepherd.requestChallenge();
      await time.increase(30);
      await f.shepherd.executeChallenge();
      return { ...f, requester, executor };
    }

    async function candidate(f, value) {
      await f.mock.configureCandidate([encode(value), ...f.end.slice(1)]);
    }

    async function expectPending(f, pending, start) {
      expect(await f.shepherd.mode()).to.equal(1);
      expect(await f.shepherd.recoveryPending()).to.equal(pending);
      expect(await f.shepherd.recoveryRequestedAt()).to.equal(start);
    }

    it("keeps selected spot readable when TWAP becomes unavailable or broken", async function () {
      const f = await loadFixture(recoveryFixture);
      for (const [available, failure] of [[false, 0], [true, 1], [true, 2]]) {
        await f.mock.configureTwap(available, f.twap, failure);
        expect(await f.shepherd.getCurrentValue()).to.deep.equal([500n, f.end[2]]);
        expect(await f.shepherd.mode()).to.equal(1);
        await expect(f.shepherd.requestRecovery()).to.be.reverted;
      }
    });

    for (const boundary of [80, 120]) {
      it(`requires agreement at request and execution, including threshold equality ${boundary}`, async function () {
        const f = await loadFixture(recoveryFixture);
        await expect(f.shepherd.requestRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
        await expect(f.shepherd.executeRecovery()).to.be.revertedWithCustomError(f.shepherd, "NoPendingRecovery");
        await candidate(f, boundary);
        const requestTime = (await time.latest()) + 1;
        await expect(f.shepherd.connect(f.requester).requestRecovery())
          .to.emit(f.shepherd, "RecoveryRequested").withArgs(f.requester.address, requestTime);
        const start = await f.shepherd.recoveryRequestedAt();
        await time.setNextBlockTimestamp(start + 89n);
        await expect(f.shepherd.executeRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryDelayNotElapsed");
        await time.setNextBlockTimestamp(start + 90n);
        await expect(f.shepherd.connect(f.executor).executeRecovery())
          .to.emit(f.shepherd, "RecoveryExecuted").withArgs(f.executor.address);
        expect(await f.shepherd.mode()).to.equal(0);
        expect(await f.shepherd.recoveryPending()).to.equal(false);
        expect(await f.shepherd.recoveryRequestedAt()).to.equal(0);
        expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, f.twap[4]]);
        for (const action of ["requestRecovery", "executeRecovery", "cancelRecovery"]) {
          await expect(f.shepherd[action]()).to.be.revertedWithCustomError(f.shepherd, "NotBackupMode");
        }
      });
    }

    for (const paused of [false, true]) {
      it(`rechecks deviation at execution without resetting the timer; paused=${paused}`, async function () {
        const f = await loadFixture(recoveryFixture);
        if (paused) await f.shepherd.pause();
        const pauseClock = await f.shepherd.pausedAt();
        await candidate(f, 100);
        await f.shepherd.requestRecovery();
        const start = await f.shepherd.recoveryRequestedAt();
        await candidate(f, 121);
        await time.increase(90);
        await expect(f.shepherd.executeRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
        await expectPending(f, true, start);
        await expect(f.shepherd.requestRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryAlreadyPending");
        await candidate(f, 100);
        // No continuous-agreement requirement: an uncancelled elapsed timer remains usable.
        await f.shepherd.connect(f.executor).executeRecovery();
        expect(await f.shepherd.mode()).to.equal(0);
        expect(await f.shepherd.paused()).to.equal(paused);
        expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
        if (paused) {
          await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
          await expect(f.shepherd.unpause()).to.be.revertedWithCustomError(f.shepherd, "PauseDurationNotElapsed");
          await time.setNextBlockTimestamp(pauseClock + 120n);
          await f.shepherd.unpause();
        }
        expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, f.twap[4]]);
      });

      it(`cancels only on renewed deviation and starts a fresh recovery timer; paused=${paused}`, async function () {
        const f = await loadFixture(recoveryFixture);
        if (paused) await f.shepherd.pause();
        const pauseClock = await f.shepherd.pausedAt();
        await expect(f.shepherd.cancelRecovery()).to.be.revertedWithCustomError(f.shepherd, "NoPendingRecovery");
        await candidate(f, 100);
        await f.shepherd.requestRecovery();
        const start = await f.shepherd.recoveryRequestedAt();
        await expect(f.shepherd.cancelRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryStillAllowed");
        await candidate(f, 79);
        await expect(f.shepherd.connect(f.executor).cancelRecovery())
          .to.emit(f.shepherd, "RecoveryCancelled").withArgs(f.executor.address);
        await expectPending(f, false, 0);
        await candidate(f, 80);
        await f.shepherd.connect(f.requester).requestRecovery();
        expect(await f.shepherd.recoveryRequestedAt()).to.be.greaterThan(start);
        await expect(f.shepherd.executeRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryDelayNotElapsed");
        expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
      });
    }

    for (const fault of ["unavailable", "revert", "malformed ABI", "invalid reference", "invalid candidate"]) {
      it(`cannot request, cancel, or execute recovery using ${fault} diagnostics`, async function () {
        const f = await loadFixture(recoveryFixture);
        async function breakDiagnostic() {
          if (fault === "invalid candidate") await candidate(f, 0);
          else await f.mock.configureTwap(fault !== "unavailable",
            fault === "invalid reference" ? [0n, ...f.twap.slice(1)] : f.twap,
            fault === "revert" ? 1 : fault === "malformed ABI" ? 2 : 0);
        }
        async function expectFailure(call) {
          const errors = { unavailable: "DiagnosticUnavailable", "invalid reference": "InvalidTwapReference", "invalid candidate": "ZeroValue" };
          if (errors[fault]) await expect(call).to.be.revertedWithCustomError(f.shepherd, errors[fault]);
          else if (fault === "revert") await expect(call).to.be.revertedWithCustomError(f.mock, "TwapUnavailable");
          else await expect(call).to.be.reverted;
        }
        await candidate(f, 100);
        await breakDiagnostic();
        await expectFailure(f.shepherd.requestRecovery());
        await expectPending(f, false, 0);
        await f.mock.configureTwap(true, f.twap, 0);
        await candidate(f, 100);
        await f.shepherd.requestRecovery();
        const start = await f.shepherd.recoveryRequestedAt();
        await f.shepherd.pause();
        const pauseClock = await f.shepherd.pausedAt();
        await breakDiagnostic();
        await expectFailure(f.shepherd.cancelRecovery());
        await time.increase(90);
        await expectFailure(f.shepherd.executeRecovery());
        await expectPending(f, true, start);
        expect(await f.shepherd.pausedAt()).to.equal(pauseClock);
      });
    }

    it("checks TWAP compatibility at bank proposal and again at execution", async function () {
      const f = await loadFixture(recoveryFixture);
      const replacement = await (await ethers.getContractFactory("TwapDataBankMock")).deploy();
      for (const failure of [1, 2]) {
        await replacement.configureTwap(false, f.twap, failure);
        await expect(f.shepherd.proposeDataBankChange(replacement.target)).to.be.reverted;
        expect(await f.shepherd.pendingDataBank()).to.equal(ethers.ZeroAddress);
      }
      await replacement.configureTwap(false, f.twap, 0); // Empty but compatible is allowed.
      await f.shepherd.proposeDataBankChange(replacement.target);
      const start = await f.shepherd.dataBankProposedAt();
      await f.shepherd.pause();
      await time.increase(300);
      await replacement.configureTwap(false, f.twap, 1);
      await expect(f.shepherd.executeDataBankChange()).to.be.revertedWithCustomError(replacement, "TwapUnavailable");
      expect(await f.shepherd.dataBank()).to.equal(f.mock.target);
      expect(await f.shepherd.dataBankProposedAt()).to.equal(start);
      await f.shepherd.cancelDataBankChange();
    });
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
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, BigInt(f.startTime + 30000)]);
      const latest = await f.bank.getCurrentAggregateData(f.queryId);
      await time.increaseTo(latest.relayTimestamp + 60n);
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
      await time.increase(1);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([121n, latest.aggregateTimestamp]);
      for (const action of ["executeChallenge", "requestChallenge", "cancelChallenge"]) {
        await expect(f.shepherd[action]()).to.be.revertedWithCustomError(f.shepherd, "NotPrimaryMode");
      }
      await setCode(f.bank.target, "0x60006000fd");
      await expect(f.shepherd.getCurrentValue()).to.be.reverted;
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
      // Switching never bypasses the global pause guard.
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ShepherdPaused");
      await expect(f.shepherd.unpause()).to.be.revertedWithCustomError(f.shepherd, "PauseDurationNotElapsed");
      await time.setNextBlockTimestamp(pauseClock + await f.shepherd.MIN_PAUSE_DURATION());
      await f.shepherd.unpause();
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([121n, BigInt(f.startTime + 40000)]);
    });

    for (const [label, payload, error] of [["zero", encode(0), "ZeroValue"], ["short", "0xab", "InvalidValueLength"]]) {
      it(`refuses a ${label} spot payload without falling back to a usable TWAP`, async function () {
        const f = await loadFixture(faultyFixture);
        await f.shepherd.requestChallenge();
        await time.increase(30);
        await f.shepherd.executeChallenge();
        await f.mock.configureEnd(true, [payload, ...f.end.slice(1)]);
        expect((await f.shepherd.readTwapReference())[0]).to.equal(true);
        await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, error);
        expect(await f.shepherd.mode()).to.equal(1);
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
      expect((await f.shepherd.getCurrentValue())[0]).to.equal(100);
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
