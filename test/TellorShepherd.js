const { loadFixture, setCode, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const queryId = ethers.id("generic-shepherd-feed");
async function fixture() {
  const [deployer, admin, pauser, outsider] = await ethers.getSigners();
  const Source = await ethers.getContractFactory("PriceSourceMock");
  const primary = await Source.deploy(queryId, 8);
  const backup = await Source.deploy(queryId, 8);
  const timestamp = BigInt(await time.latest() - 10) * 1000n + 17n;
  await primary.configureRead(100, timestamp, 0);
  await backup.configureRead(150, timestamp + 1000n, 0);
  const Shepherd = await ethers.getContractFactory("TellorShepherdHarness");
  const args = [queryId, 8, primary.target, backup.target, admin.address, 120, 300, 2000, [30, 90], 3600];
  const shepherd = await Shepherd.deploy(...args);
  return { deployer, admin, pauser, outsider, Source, primary, backup, timestamp, Shepherd, args, shepherd };
}

describe("TellorShepherd - Generic configuration and reads", function () {
  it("binds identity, precision, sources and controls without requiring prices", async function () {
    const f = await loadFixture(fixture);
    await f.primary.configureRead(0, 0, 1);
    await f.backup.configureRead(0, 0, 1);
    const s = await f.Shepherd.deploy(...f.args);
    for (const [getter, expected] of Object.entries({ queryId, decimals: 8,
      primarySource: f.primary.target, backupSource: f.backup.target, admin: f.admin.address,
      minPauseDuration: 120, CONFIG_CHANGE_DELAY: 300, challengeThresholdBps: 2000,
      CHALLENGE_DELAY_SECONDS: 30, RECOVERY_DELAY_SECONDS: 90, mode: 0,
      paused: false, pausedAt: 0, pendingPrimarySource: ethers.ZeroAddress,
      pendingBackupSource: ethers.ZeroAddress, sourcesProposedAt: 0 })) {
      expect(await s[getter](), getter).to.equal(expected);
    }
    await expect(s.getCurrentValue()).to.be.revertedWithCustomError(f.primary, "ReadUnavailable");
  });

  for (const [index, value, error] of [
    [0, ethers.ZeroHash, "InvalidQueryId"], [1, 78, "InvalidDecimals"],
    [2, ethers.ZeroAddress, "SourceHasNoCode"], [3, ethers.ZeroAddress, "SourceHasNoCode"],
    [4, ethers.ZeroAddress, "InvalidAdmin"],
    [6, 0, "InvalidConfigChangeDelay"], [7, 0, "InvalidChallengeThreshold"],
    [7, 10000, "InvalidChallengeThreshold"], [7, ethers.MaxUint256, "InvalidChallengeThreshold"],
    [8, [0, 90], "InvalidChallengeDelay"], [8, [30, 0], "InvalidRecoveryDelay"],
  ]) {
    it(`rejects invalid constructor argument ${index}: ${error}`, async function () {
      const f = await loadFixture(fixture);
      const args = [...f.args]; args[index] = value;
      await expect(f.Shepherd.deploy(...args)).to.be.revertedWithCustomError(f.Shepherd, error);
    });
  }

  for (const side of ["primary", "backup"]) {
    it(`checks ${side} code, query identity, precision and metadata ABI`, async function () {
      const f = await loadFixture(fixture);
      const args = [...f.args]; args[side === "primary" ? 2 : 3] = f.outsider.address;
      await expect(f.Shepherd.deploy(...args)).to.be.revertedWithCustomError(f.Shepherd, "SourceHasNoCode");
      await f[side].configureMetadata(ethers.id("other"), 8);
      await expect(f.Shepherd.deploy(...f.args)).to.be.revertedWithCustomError(f.Shepherd, "SourceQueryIdMismatch");
      await f[side].configureMetadata(queryId, 18);
      await expect(f.Shepherd.deploy(...f.args)).to.be.revertedWithCustomError(f.Shepherd, "SourceDecimalsMismatch");
      await setCode(f[side].target, "0x60016000f3");
      await expect(f.Shepherd.deploy(...f.args)).to.be.reverted;
    });
  }

  it("accepts independently configured positive delays and precision endpoints", async function () {
    const f = await loadFixture(fixture);
    for (const precision of [0, 77]) {
      await f.primary.configureMetadata(queryId, precision);
      await f.backup.configureMetadata(queryId, precision);
      for (const delay of [1n, ethers.MaxUint256]) {
        const args = [...f.args]; args[1] = precision; args[5] = 1; args[6] = 1; args[8] = [delay, delay];
        const s = await f.Shepherd.deploy(...args);
        expect(await s.CHALLENGE_DELAY_SECONDS()).to.equal(delay);
        expect(await s.RECOVERY_DELAY_SECONDS()).to.equal(delay);
        expect(await s.decimals()).to.equal(precision);
        expect(await s.getCurrentValue()).to.deep.equal([100n, f.timestamp]);
      }
    }
  });

  for (const mode of [0, 1]) {
    it(`reads only selected source in mode ${mode}, preserves time, and never falls back`, async function () {
      const f = await loadFixture(fixture);
      await f.shepherd.setModeForTest(mode);
      const selected = mode ? f.backup : f.primary;
      const other = mode ? f.primary : f.backup;
      const pair = await selected.getCurrentValue();
      await other.configureRead(0, 0, 1);
      await time.increase(60);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal(pair);
      await other.configureRead(999, f.timestamp, 0);
      await selected.configureRead(0, 0, 1);
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(selected, "ReadUnavailable");
      expect(await f.shepherd.mode()).to.equal(mode);
      await selected.configureRead(1, f.timestamp, 2);
      await expect(f.shepherd.getCurrentValue()).to.be.reverted;
    });
    it(`rejects invalid selected output at full millisecond precision in mode ${mode}`, async function () {
      const f = await loadFixture(fixture);
      await f.shepherd.setModeForTest(mode);
      const source = mode ? f.backup : f.primary;
      await source.configureRead(0, f.timestamp, 0);
      await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "ZeroValue");
      for (const offset of [null, 1, 1000]) {
        const readTime = await time.latest() + 10;
        await source.configureRead(100, offset === null ? 0 : readTime * 1000 + offset, 0);
        await time.increaseTo(readTime);
        await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "InvalidTimestamp");
      }
      const readTime = await time.latest() + 10;
      await source.configureRead(100, readTime * 1000, 0);
      await time.increaseTo(readTime);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([100n, BigInt(readTime) * 1000n]);
    });
  }
});

describe("TellorShepherd - Pauser membership", function () {
  async function deployPauserFixture() {
    const [deployer, admin, pauser, other] = await ethers.getSigners();
    const { shepherd } = await fixture();
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
    const { primary: source, Shepherd, shepherd } = await fixture();
    await source.configureRead(100, 1, 1);
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

  it("reports pause before dependency failure", async function () {
    const { admin, source, Shepherd, shepherd } = await loadFixture(deployPauseFixture);
    await expect(shepherd.getCurrentValue()).to.be.reverted;
    await shepherd.connect(admin).pause();
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(shepherd, "ShepherdPaused");

  });
});


describe("TellorShepherd - Two-source transitions", function () {
  it("matches independent rational comparisons at equality, fractional boundaries and uint256 extremes", async function () {
    const f = await loadFixture(fixture);
    for (const threshold of [1n, 2000n, 9999n]) {
      const args = [...f.args]; args[7] = threshold;
      const s = await f.Shepherd.deploy(...args);
      for (const reference of [1n, 100n, 10001n, (1n << 192n) - 1n, ethers.MaxUint256]) {
        await f.primary.configureRead(reference, f.timestamp, 0);
        const boundary = reference * threshold / 10000n;
        for (const value of new Set([1n, ethers.MaxUint256, reference,
          reference - boundary, reference - boundary - 1n, reference + boundary, reference + boundary + 1n])) {
          if (value <= 0n || value > ethers.MaxUint256) continue;
          await f.backup.configureRead(value, f.timestamp, 0);
          const difference = value > reference ? value - reference : reference - value;
          expect(await s.readDeviation()).to.equal(difference * 10000n > reference * threshold);
        }
      }
    }
  });

  for (const kind of ["Challenge", "Recovery"]) {
    const mode = kind === "Challenge" ? 0 : 1;
    const delay = mode ? 90n : 30n;
    const field = kind.toLowerCase();
    const pending = `${field}Pending`, clock = `${field}RequestedAt`;
    const request = `request${kind}`, execute = `execute${kind}`, cancel = `cancel${kind}`;
    const eligible = mode ? 100 : 150;
    const ineligible = mode ? 150 : 100;
    const conditionError = mode ? "RecoveryNotAllowed" : "NotDeviating";
    const cancelError = mode ? "RecoveryStillAllowed" : "StillDeviating";
    async function ready() {
      const f = await fixture();
      await f.shepherd.setModeForTest(mode);
      await f.backup.configureRead(eligible, f.timestamp, 0);
      return f;
    }
    async function set(f, value) { await f.backup.configureRead(value, f.timestamp, 0); }

    for (const paused of [false, true]) {
      it(`${kind}: endpoint rechecks, duplicate protection, delay equality and pause preservation; paused=${paused}`, async function () {
        const f = await loadFixture(ready), s = f.shepherd.connect(f.admin);
        if (paused) await s.pause();
        const pauseClock = await s.pausedAt();
        await expect(s[execute]()).to.be.revertedWithCustomError(s, `NoPending${kind}`);
        await expect(s[cancel]()).to.be.revertedWithCustomError(s, `NoPending${kind}`);
        await set(f, ineligible);
        await expect(s[request]()).to.be.revertedWithCustomError(s, conditionError);
        await set(f, eligible);
        const requestAt = BigInt(await time.latest() + 1);
        await expect(s.connect(f.outsider)[request]()).to.emit(s, `${kind}Requested`).withArgs(f.outsider.address, requestAt);
        if (!paused) expect(await s.getCurrentValue()).to.deep.equal([100n, f.timestamp]);
        await expect(s[request]()).to.be.revertedWithCustomError(s, `${kind}AlreadyPending`);
        await expect(s[cancel]()).to.be.revertedWithCustomError(s, cancelError);
        await time.setNextBlockTimestamp(requestAt + delay - 1n);
        await expect(s[execute]()).to.be.revertedWithCustomError(s, `${kind}DelayNotElapsed`);
        await time.setNextBlockTimestamp(requestAt + delay);
        await expect(s.connect(f.pauser)[execute]()).to.emit(s, `${kind}Executed`).withArgs(f.pauser.address);
        expect(await s.mode()).to.equal(1 - mode);
        expect(await s[pending]()).to.equal(false); expect(await s[clock]()).to.equal(0);
        expect(await s.paused()).to.equal(paused); expect(await s.pausedAt()).to.equal(pauseClock);
        for (const method of [request, execute, cancel]) {
          await expect(s[method]()).to.be.revertedWithCustomError(s, mode ? "NotBackupMode" : "NotPrimaryMode");
        }
        if (paused) {
          await expect(s.getCurrentValue()).to.be.revertedWithCustomError(s, "ShepherdPaused");
          await expect(s.unpause()).to.be.revertedWithCustomError(s, "PauseDurationNotElapsed");
          await time.setNextBlockTimestamp(pauseClock + 120n); await s.unpause();
        }
        expect((await s.getCurrentValue())[0]).to.equal(mode ? 100 : 150);
      });

      it(`${kind}: oscillation preserves an uncancelled clock; cancellation starts a new clock; paused=${paused}`, async function () {
        const f = await loadFixture(ready), s = f.shepherd.connect(f.admin);
        if (paused) await s.pause();
        await s[request](); const original = await s[clock]();
        await set(f, ineligible); await time.increase(delay);
        await expect(s[execute]()).to.be.revertedWithCustomError(s, conditionError);
        expect(await s[clock]()).to.equal(original); expect(await s[pending]()).to.equal(true);
        await expect(s[request]()).to.be.revertedWithCustomError(s, `${kind}AlreadyPending`);
        await set(f, eligible);
        await expect(s[cancel]()).to.be.revertedWithCustomError(s, cancelError);
        await set(f, ineligible);
        await expect(s.connect(f.outsider)[cancel]()).to.emit(s, `${kind}Cancelled`).withArgs(f.outsider.address);
        expect(await s[clock]()).to.equal(0); expect(await s[pending]()).to.equal(false);
        await set(f, eligible); await s[request](); const next = await s[clock]();
        expect(next).to.be.greaterThan(original);
        await expect(s[execute]()).to.be.revertedWithCustomError(s, `${kind}DelayNotElapsed`);
        await set(f, ineligible); await time.increase(delay);
        await set(f, eligible); await s[execute]();
        expect(await s.mode()).to.equal(1 - mode);
      });
    }

    for (const value of [80, 120]) {
      it(`${kind}: exact deviation threshold ${value} is in-band`, async function () {
        const f = await loadFixture(ready), s = f.shepherd;
        await set(f, value);
        if (mode) {
          await s[request](); await time.increase(delay); await s[execute]();
        } else {
          await expect(s[request]()).to.be.revertedWithCustomError(s, "NotDeviating");
          await set(f, 121); await s[request](); await set(f, value); await s[cancel]();
        }
      });
    }

    for (const side of ["primary", "backup"]) {
      for (const fault of ["revert", "malformed", "zero price", "zero timestamp", "future timestamp"]) {
        it(`${kind}: ${side} ${fault} refuses requests/cancellation/execution without changing timers`, async function () {
          const f = await loadFixture(ready), s = f.shepherd.connect(f.admin);
          const pair = await f[side].getCurrentValue();
          async function breakSource() {
            await f[side].configureRead(fault === "zero price" ? 0 : pair[0],
              fault === "zero timestamp" ? 0 : fault === "future timestamp" ? ethers.MaxUint256 : pair[1],
              fault === "revert" ? 1 : fault === "malformed" ? 2 : 0);
          }
          async function refusal(call) {
            if (fault === "revert") await expect(call).to.be.revertedWithCustomError(f[side], "ReadUnavailable");
            else if (fault === "malformed") await expect(call).to.be.reverted;
            else await expect(call).to.be.revertedWithCustomError(s, fault === "zero price" ? "ZeroValue" : "InvalidTimestamp");
          }
          await breakSource(); await refusal(s[request]());
          expect(await s[pending]()).to.equal(false); expect(await s[clock]()).to.equal(0);
          await f[side].configureRead(...pair, 0); await s[request]();
          const start = await s[clock](); await s.pause(); const pauseClock = await s.pausedAt();
          await breakSource(); await refusal(s[cancel]()); await time.increase(delay); await refusal(s[execute]());
          expect(await s[pending]()).to.equal(true); expect(await s[clock]()).to.equal(start);
          expect(await s.mode()).to.equal(mode); expect(await s.pausedAt()).to.equal(pauseClock);
        });
      }
    }
  }
});

describe("TellorShepherd - Source pair migration", function () {
  const { time, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
  const changeDelay = 300;

  async function deployMigrationFixture() {
    const f = await fixture();
    const replacement = await f.Source.deploy(queryId, 8);
    const alternate = await f.Source.deploy(queryId, 8);
    const incompatible = await (await ethers.getContractFactory("TellorLab")).deploy();
    await f.shepherd.connect(f.admin).addPauser(f.pauser.address);
    return { ...f, bank: f.primary, replacement, alternate, incompatible };
  }

  it("requires admin for every migration action, including while paused", async function () {
    const { backup, deployer, admin, pauser, outsider, replacement, shepherd } = await loadFixture(deployMigrationFixture);
    await shepherd.connect(admin).proposeSourcesChange(replacement.target, backup.target);
    await shepherd.connect(pauser).pause();
    await time.increase(changeDelay);
    for (const caller of [deployer, pauser, outsider]) {
      await expect(shepherd.connect(caller).proposeSourcesChange(replacement.target, backup.target))
        .to.be.revertedWithCustomError(shepherd, "NotAdmin");
      for (const method of ["cancelSourcesChange", "executeSourcesChange"]) {
        await expect(shepherd.connect(caller)[method]()).to.be.revertedWithCustomError(shepherd, "NotAdmin");
      }
    }
  });

  it("rejects absent proposals and invalid targets without starting a clock", async function () {
    const { backup, admin, outsider, bank, incompatible, shepherd } = await loadFixture(deployMigrationFixture);
    for (const method of ["cancelSourcesChange", "executeSourcesChange"]) {
      await expect(shepherd.connect(admin)[method]()).to.be.revertedWithCustomError(shepherd, "NoPendingSourcesChange");
    }
    for (const target of [ethers.ZeroAddress, outsider.address]) {
      await expect(shepherd.connect(admin).proposeSourcesChange(target, backup.target))
        .to.be.revertedWithCustomError(shepherd, "SourceHasNoCode");
    }
    await expect(shepherd.connect(admin).proposeSourcesChange(bank.target, backup.target))
      .to.be.revertedWithCustomError(shepherd, "SourcesUnchanged");
    await expect(shepherd.connect(admin).proposeSourcesChange(incompatible.target, backup.target)).to.be.reverted;
    expect(await shepherd.pendingPrimarySource()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.sourcesProposedAt()).to.equal(0);
  });

  it("requires cancellation before replacement and gives a new proposal its own full delay", async function () {
    const { backup, admin, replacement, alternate, shepherd } = await loadFixture(deployMigrationFixture);
    const proposedAt = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(proposedAt);
    await expect(shepherd.connect(admin).proposeSourcesChange(replacement.target, backup.target))
      .to.emit(shepherd, "SourcesChangeProposed").withArgs(replacement.target, backup.target, proposedAt);
    await time.increase(changeDelay);
    for (const target of [replacement.target, alternate.target]) {
      await expect(shepherd.connect(admin).proposeSourcesChange(target, backup.target))
        .to.be.revertedWithCustomError(shepherd, "SourcesChangePending");
    }
    expect(await shepherd.pendingPrimarySource()).to.equal(replacement.target);
    expect(await shepherd.sourcesProposedAt()).to.equal(proposedAt);
    await expect(shepherd.connect(admin).cancelSourcesChange())
      .to.emit(shepherd, "SourcesChangeCancelled").withArgs(replacement.target, backup.target);
    expect(await shepherd.pendingPrimarySource()).to.equal(ethers.ZeroAddress);
    expect(await shepherd.sourcesProposedAt()).to.equal(0);
    await expect(shepherd.connect(admin).executeSourcesChange())
      .to.be.revertedWithCustomError(shepherd, "NoPendingSourcesChange");
    await shepherd.connect(admin).pause();
    await shepherd.connect(admin).proposeSourcesChange(alternate.target, backup.target);
    expect(await shepherd.sourcesProposedAt()).to.be.greaterThan(proposedAt);
    await expect(shepherd.connect(admin).executeSourcesChange())
      .to.be.revertedWithCustomError(shepherd, "ConfigChangeDelayNotElapsed");
  });

  it("rejects one second early, allows equality with empty history, and preserves the pause minimum", async function () {
    const { backup, admin, bank, replacement, shepherd } = await loadFixture(deployMigrationFixture);
    await shepherd.connect(admin).proposeSourcesChange(replacement.target, backup.target);
    const start = Number(await shepherd.sourcesProposedAt());
    await time.setNextBlockTimestamp(start + changeDelay - 2);
    await shepherd.connect(admin).pause();
    const pausedAt = await shepherd.pausedAt();
    await time.setNextBlockTimestamp(start + changeDelay - 1);
    await expect(shepherd.connect(admin).executeSourcesChange())
      .to.be.revertedWithCustomError(shepherd, "ConfigChangeDelayNotElapsed");
    expect(await shepherd.primarySource()).to.equal(bank.target);
    await time.setNextBlockTimestamp(start + changeDelay);
    await shepherd.connect(admin).executeSourcesChange();
    expect(await shepherd.primarySource()).to.equal(replacement.target);
    expect(await shepherd.paused()).to.equal(true);
    expect(await shepherd.pausedAt()).to.equal(pausedAt);
    await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "PauseDurationNotElapsed");
    await time.setNextBlockTimestamp(Number(pausedAt) + 120);
    await shepherd.connect(admin).unpause();
    await expect(shepherd.getCurrentValue()).to.be.revertedWithCustomError(replacement, "ReadUnavailable");
  });

  it("requires pause for execution and blocks unpause until cancellation or execution", async function () {
    const { backup, admin, bank, replacement, shepherd } = await loadFixture(deployMigrationFixture);
    await shepherd.connect(admin).proposeSourcesChange(replacement.target, backup.target);
    await time.increase(changeDelay);
    await expect(shepherd.connect(admin).executeSourcesChange()).to.be.revertedWithCustomError(shepherd, "NotPaused");
    await shepherd.connect(admin).pause();
    await time.increase(120);
    await expect(shepherd.connect(admin).unpause()).to.be.revertedWithCustomError(shepherd, "SourcesChangePending");
    await shepherd.connect(admin).cancelSourcesChange();
    await shepherd.connect(admin).unpause();
    expect(await shepherd.primarySource()).to.equal(bank.target);
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
      const { backup, admin, bank, replacement, alternate, shepherd } = await loadFixture(deployMigrationFixture);
      await setCode(alternate.target, code);
      await expect(shepherd.connect(admin).proposeSourcesChange(alternate.target, backup.target)).to.be.reverted;
      await shepherd.connect(admin).proposeSourcesChange(replacement.target, backup.target);
      const start = await shepherd.sourcesProposedAt();
      await shepherd.connect(admin).pause();
      const pausedAt = await shepherd.pausedAt();
      await time.increase(changeDelay);
      await setCode(replacement.target, code);
      await expect(shepherd.connect(admin).executeSourcesChange()).to.be.reverted;
      expect(await shepherd.primarySource()).to.equal(bank.target);
      expect(await shepherd.pendingPrimarySource()).to.equal(replacement.target);
      expect(await shepherd.sourcesProposedAt()).to.equal(start);
      expect(await shepherd.pausedAt()).to.equal(pausedAt);
      await shepherd.connect(admin).cancelSourcesChange();
      await shepherd.connect(admin).unpause();
    });
  }
});

describe("TellorShepherd - Atomic source metadata checks", function () {
  for (const side of ["primary", "backup"]) {
    for (const fault of ["query", "decimals", "no code"]) {
      it(`rechecks ${side} ${fault} at proposal and execution without partially replacing the pair`, async function () {
        const f = await loadFixture(fixture), s = f.shepherd.connect(f.admin);
        const a = await f.Source.deploy(queryId, 8), b = await f.Source.deploy(queryId, 8);
        const bad = side === "primary" ? a : b;
        const code = await ethers.provider.getCode(bad.target);
        async function breakMetadata() {
          if (fault === "no code") await setCode(bad.target, "0x");
          else await bad.configureMetadata(fault === "query" ? ethers.id("wrong") : queryId, fault === "decimals" ? 9 : 8);
        }
        const error = fault === "no code" ? "SourceHasNoCode" : fault === "query" ? "SourceQueryIdMismatch" : "SourceDecimalsMismatch";
        await breakMetadata();
        await expect(s.proposeSourcesChange(a.target, b.target)).to.be.revertedWithCustomError(s, error);
        expect(await s.pendingPrimarySource()).to.equal(ethers.ZeroAddress);
        expect(await s.pendingBackupSource()).to.equal(ethers.ZeroAddress);
        await setCode(bad.target, code); await bad.configureMetadata(queryId, 8);
        await s.proposeSourcesChange(a.target, b.target); const start = await s.sourcesProposedAt();
        await s.pause(); await time.increase(300); await breakMetadata();
        await expect(s.executeSourcesChange()).to.be.revertedWithCustomError(s, error);
        expect(await s.primarySource()).to.equal(f.primary.target);
        expect(await s.backupSource()).to.equal(f.backup.target);
        expect(await s.pendingPrimarySource()).to.equal(a.target);
        expect(await s.pendingBackupSource()).to.equal(b.target);
        expect(await s.sourcesProposedAt()).to.equal(start);
        await s.cancelSourcesChange(); // Cancellation cannot depend on either proposal's health.
      });
    }
  }

  it("can replace only backup, then primary without reading prices, retaining immutable delays/identity and mode", async function () {
    const f = await loadFixture(fixture), s = f.shepherd.connect(f.admin);
    const nextBackup = await f.Source.deploy(queryId, 8);
    await s.proposeSourcesChange(f.primary.target, nextBackup.target);
    await s.pause(); const pauseClock = await s.pausedAt(); await time.increase(300);
    await expect(s.executeSourcesChange()).to.emit(s, "SourcesChanged")
      .withArgs(f.primary.target, f.backup.target, f.primary.target, nextBackup.target);
    const nextPrimary = await f.Source.deploy(queryId, 8);
    await s.proposeSourcesChange(nextPrimary.target, f.backup.target);
    await time.increase(300);
    // Migration metadata checks must not read old or proposed prices.
    await setCode(f.primary.target, "0x60006000fd");
    await s.executeSourcesChange();
    expect(await s.primarySource()).to.equal(nextPrimary.target);
    expect(await s.backupSource()).to.equal(f.backup.target);
    expect(await s.queryId()).to.equal(queryId); expect(await s.decimals()).to.equal(8);
    expect(await s.CHALLENGE_DELAY_SECONDS()).to.equal(30); expect(await s.RECOVERY_DELAY_SECONDS()).to.equal(90);
    expect(await s.mode()).to.equal(0); expect(await s.pausedAt()).to.equal(pauseClock);
    expect(await s.pendingPrimarySource()).to.equal(ethers.ZeroAddress);
    expect(await s.pendingBackupSource()).to.equal(ethers.ZeroAddress);
    await s.unpause();
    await expect(s.getCurrentValue()).to.be.revertedWithCustomError(nextPrimary, "ReadUnavailable");
  });
});
