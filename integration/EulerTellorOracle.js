const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

// Separate from test/: normal Shepherd tests do not require the Euler checkout or Forge.
describe("Euler adaptor - Real Shepherd integration", function () {
  let adaptorArtifact, tokenArtifact;
  before(function () {
    this.timeout(120000);
    const root = path.resolve(process.env.EULER_ADAPTER_ROOT || path.join(__dirname, "../../euler-tellor-adapter"));
    // Compile with Euler's own settings; a failed build must not reuse stale bytecode.
    execFileSync("forge", ["build", "--root", root], { stdio: "inherit", timeout: 110000 });
    const artifact = (name) => JSON.parse(fs.readFileSync(path.join(root, `out/${name}.sol/${name}.json`), "utf8"));
    adaptorArtifact = artifact("TellorOracle");
    tokenArtifact = artifact("MockERC20");
  });

  const unit = 10n ** 18n;
  const primaryPrice = 3000n * unit;
  const backupPrice = 2900n * unit;
  const maxAge = 3600n;
  const usd = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(840), 20));
  const coder = ethers.AbiCoder.defaultAbiCoder();

  async function fixture(feedDecimals = 18) {
    const [admin, streamer, outsider] = await ethers.getSigners();
    const queryId = ethers.keccak256(coder.encode(
      ["string", "bytes"], ["SpotPrice", coder.encode(["string", "string"], ["eth", "usd"])]
    ));
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target);
    const Stream = await ethers.getContractFactory("StreamBackupOracle");
    const backup = await Stream.deploy(admin.address, streamer.address, 60);
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherd = await Shepherd.deploy({
      queryId, dataBank: bank.target, backupOracle: backup.target,
      admin: admin.address, relayReadDelay: 60, minPauseDuration: 120,
      dataBankChangeDelay: 300, backupChangeDelay: 600, twapWindowMs: 30000,
      challengeThresholdBps: 2000, challengeDelaySeconds: 30, recoveryDelaySeconds: 90,
      maxPriceAge: maxAge, decimals: feedDecimals
    });
    const Token = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode.object, admin);
    const base = (await Token.deploy(18)).target;
    const Adaptor = new ethers.ContractFactory(adaptorArtifact.abi, adaptorArtifact.bytecode.object, admin);
    const f = { admin, streamer, outsider, queryId, validatorSet, Bank, bank, Stream, backup,
      shepherd, Token, Adaptor, base, quote: usd };
    f.oracle = await deployAdaptor(f);
    f.startMs = (await time.latest() - 120) * 1000 + 17;
    return f;
  }

  function deployAdaptor(f, { base = f.base, quote = f.quote, decimals = 18, queryId = f.queryId } = {}) {
    return f.Adaptor.deploy(base, quote, f.shepherd.target, queryId, decimals);
  }

  async function relay(f, value, stamp, bank = f.bank) {
    const report = await h.prepareOracleData(f.queryId, coder.encode(["uint256"], [value]), f.validatorSet,
      { aggregateTimestamp: stamp, attestationTimestamp: (await time.latest()) * 1000 });
    await bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    return BigInt(await time.latest());
  }

  async function submit(f, value, backup = f.backup) {
    await backup.connect(f.streamer).submitValue(f.queryId, value);
    const index = (await backup.reportCount(f.queryId)) - 1n;
    const report = await backup.reports(f.queryId, index);
    return { index, at: report.submittedAt, pair: [value, report.submittedAt * 1000n] };
  }

  async function primaryFixture() {
    const f = await fixture();
    await relay(f, primaryPrice, f.startMs);
    const at = await relay(f, primaryPrice, f.startMs + 30000);
    await time.increaseTo(at + 61n);
    return f;
  }

  async function requestChallenge(f) {
    await relay(f, primaryPrice * 3n / 2n, f.startMs + 40000);
    await f.shepherd.connect(f.outsider).requestChallenge();
    return await f.shepherd.challengeRequestedAt();
  }

  async function backupFixture() {
    const f = await primaryFixture();
    f.report = await submit(f, backupPrice);
    const requestedAt = await requestChallenge(f);
    await relay(f, primaryPrice, f.startMs + 45000);
    await time.setNextBlockTimestamp(requestedAt + 30n);
    await f.shepherd.connect(f.outsider).resolveChallenge();
    await time.increaseTo(f.report.at + 60n);
    return f;
  }

  // Check both entry points in both directions, with independent unbounded integer arithmetic.
  async function expectQuotes(f, price, { amount = unit, decimals = [18, 18, 18] } = {}) {
    const [baseDecimals, quoteDecimals, feedDecimals] = decimals;
    const numerator = price * 10n ** BigInt(quoteDecimals);
    const denominator = 10n ** BigInt(baseDecimals + feedDecimals);
    for (const inverse of [false, true]) {
      const [base, quote] = inverse ? [f.quote, f.base] : [f.base, f.quote];
      const expected = inverse ? amount * denominator / numerator : amount * numerator / denominator;
      expect(await f.oracle.getQuote(amount, base, quote)).to.equal(expected);
      expect(await f.oracle.getQuotes(amount, base, quote)).to.deep.equal([expected, expected]);
    }
  }

  async function expectRefusal(f, contract, error, args = []) {
    for (const [base, quote] of [[f.base, f.quote], [f.quote, f.base]]) {
      for (const method of ["getQuote", "getQuotes"]) {
        const assertion = expect(f.oracle[method](unit, base, quote));
        if (error) await assertion.to.be.revertedWithCustomError(contract, error).withArgs(...args);
        else await assertion.to.be.reverted;
      }
    }
  }

  for (const mode of ["primary", "backup"]) {
    it(`quotes both directions and equal bid/ask from the real ${mode}`, async function () {
      const f = await loadFixture(mode === "primary" ? primaryFixture : backupFixture);
      const pair = mode === "primary" ? [primaryPrice, BigInt(f.startMs + 30000)] : f.report.pair;
      expect(await f.shepherd.mode()).to.equal(mode === "primary" ? 0 : 1);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal(pair);
      await expectQuotes(f, pair[0]);
      await f.shepherd.pause();
      await expectRefusal(f, f.shepherd, "ShepherdPaused");
    });
  }

  it("binds the real Shepherd query identity and rejects a different feed", async function () {
    const f = await loadFixture(primaryFixture);
    expect(await f.oracle.shepherd()).to.equal(f.shepherd.target);
    expect(await f.oracle.queryId()).to.equal(f.queryId);
    await expect(deployAdaptor(f, { queryId: ethers.id("wrong-feed") }))
      .to.be.revertedWithCustomError(f.oracle, "PriceOracle_InvalidConfiguration");
  });

  it("requires strict primary maturity and keeps older mature data visible", async function () {
    const f = await loadFixture(fixture);
    await expectRefusal(f, f.shepherd, "NoMatureData");
    const at = await relay(f, primaryPrice, f.startMs);
    await time.increaseTo(at + 60n);
    await expectRefusal(f, f.shepherd, "NoMatureData");
    await time.increase(1);
    await expectQuotes(f, primaryPrice);
    await relay(f, primaryPrice * 2n, f.startMs + 30000);
    await expectQuotes(f, primaryPrice);
  });

  it("selects backup before it is readable, accepts exact maturity, and propagates disputes", async function () {
    const f = await loadFixture(primaryFixture);
    const report = await submit(f, backupPrice);
    const requestedAt = await requestChallenge(f);
    await relay(f, primaryPrice, f.startMs + 45000);
    await time.setNextBlockTimestamp(requestedAt + 30n);
    await f.shepherd.connect(f.outsider).resolveChallenge();
    await time.increaseTo(report.at + 59n);
    await expectRefusal(f, f.backup, "NoUsableReport");
    await time.increase(1);
    await expectQuotes(f, backupPrice);
    await f.backup.disputeValue(f.queryId, report.index);
    await expectRefusal(f, f.backup, "NoUsableReport");
  });

  for (const excessMs of [-1, 0, 1]) {
    it(`checks primary age at the limit ${excessMs >= 0 ? "+" : ""}${excessMs}ms`, async function () {
      const f = await loadFixture(fixture);
      const anchor = await time.latest() - 120;
      const stamp = anchor * 1000 - excessMs;
      await relay(f, primaryPrice, stamp);
      await time.increaseTo(BigInt(anchor) + maxAge);
      if (excessMs > 0) {
        await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "StalePrice");
        await expectRefusal(f, f.shepherd, "StalePrice");
      } else {
        expect(await f.shepherd.getCurrentValue()).to.deep.equal([primaryPrice, BigInt(stamp)]);
        await expectQuotes(f, primaryPrice);
      }
    });
  }

  it("ages backup quotes across repeated reads and rejects them beyond the exact age limit", async function () {
    const f = await loadFixture(backupFixture);
    await expectQuotes(f, backupPrice);
    await time.increaseTo(f.report.at + maxAge);
    await expectQuotes(f, backupPrice);
    await time.increase(1);
    await expect(f.shepherd.getCurrentValue()).to.be.revertedWithCustomError(f.shepherd, "StalePrice");
    await expectRefusal(f, f.shepherd, "StalePrice");
  });

  for (const example of [
    { label: "mixed token/feed decimals", decimals: [8, 6, 8], price: 3000n * 10n ** 8n, amount: 123456789n },
    { label: "fractional rounding", decimals: [18, 18, 18], price: 15n * 10n ** 17n, amount: 1n },
    { label: "a 512-bit intermediate product", decimals: [18, 18, 18], price: unit, amount: 1n << 240n },
  ]) {
    it(`computes ${example.label} from a real primary report`, async function () {
      const f = await fixture(example.decimals[2]);
      const base = (await f.Token.deploy(example.decimals[0])).target;
      const quote = (await f.Token.deploy(example.decimals[1])).target;
      const oracle = await deployAdaptor(f, { base, quote, decimals: example.decimals[2] });
      await relay(f, example.price, f.startMs);
      await time.increase(61);
      await expectQuotes({ ...f, base, quote, oracle }, example.price, example);
    });
  }

  it("executes a challenge at its deadline while preserving pause and its clock", async function () {
    const f = await loadFixture(primaryFixture);
    const report = await submit(f, backupPrice);
    const requestedAt = await requestChallenge(f);
    await relay(f, primaryPrice, f.startMs + 45000);
    await f.shepherd.pause();
    const pausedAt = await f.shepherd.pausedAt();
    await time.setNextBlockTimestamp(requestedAt + 29n);
    await expect(f.shepherd.connect(f.outsider).resolveChallenge())
      .to.be.revertedWithCustomError(f.shepherd, "ChallengeDelayNotElapsed");
    await time.setNextBlockTimestamp(requestedAt + 30n);
    await f.shepherd.connect(f.outsider).resolveChallenge();
    expect(await f.shepherd.mode()).to.equal(1);
    expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
    await time.increaseTo(report.at + 60n);
    await expectRefusal(f, f.shepherd, "ShepherdPaused");
    await expect(f.shepherd.unpause()).to.be.revertedWithCustomError(f.shepherd, "PauseDurationNotElapsed");
    await time.setNextBlockTimestamp(pausedAt + 120n);
    await f.shepherd.unpause();
    await expectQuotes(f, backupPrice);
  });

  it("rechecks recovery permission, honors the deadline, and keeps recovered quotes paused", async function () {
    const f = await loadFixture(backupFixture);
    await expect(f.shepherd.connect(f.outsider).requestRecovery())
      .to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
    const recoveredPrice = 3100n * unit;
    await relay(f, recoveredPrice, f.startMs + 50000);
    await f.shepherd.pause();
    const pausedAt = await f.shepherd.pausedAt();
    await f.backup.setCanRecover(f.queryId, true);
    await f.shepherd.connect(f.outsider).requestRecovery();
    const requestedAt = await f.shepherd.recoveryRequestedAt();
    await time.setNextBlockTimestamp(requestedAt + 89n);
    await expect(f.shepherd.connect(f.outsider).executeRecovery())
      .to.be.revertedWithCustomError(f.shepherd, "RecoveryDelayNotElapsed");
    // A static call at equality verifies the deadline without consuming the pending request.
    await time.increaseTo(requestedAt + 90n);
    await f.shepherd.connect(f.outsider).executeRecovery.staticCall();
    await f.backup.setCanRecover(f.queryId, false);
    await expect(f.shepherd.connect(f.outsider).executeRecovery())
      .to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
    expect(await f.shepherd.recoveryRequestedAt()).to.equal(requestedAt);
    expect(await f.shepherd.mode()).to.equal(1);
    await expectRefusal(f, f.shepherd, "ShepherdPaused");
    await f.backup.setCanRecover(f.queryId, true);
    await f.shepherd.connect(f.outsider).executeRecovery();
    expect(await f.shepherd.mode()).to.equal(0);
    expect(await f.shepherd.recoveryPending()).to.equal(false);
    expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
    await expectRefusal(f, f.shepherd, "ShepherdPaused");
    await time.setNextBlockTimestamp(pausedAt + 120n);
    await f.shepherd.unpause();
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([recoveredPrice, BigInt(f.startMs + 50000)]);
    await expectQuotes(f, recoveredPrice);
  });

  for (const source of ["bank", "backup"]) {
    it(`keeps adaptor wiring through paused ${source} migration`, async function () {
      const f = await loadFixture(backupFixture);
      const replacementPrice = 3200n * unit;
      let expectedPair;
      if (source === "bank") {
        const bank = await f.Bank.deploy(await f.bank.dataBridge());
        await relay(f, replacementPrice, f.startMs + 50000, bank);
        expectedPair = [replacementPrice, BigInt(f.startMs + 50000)];
        await f.shepherd.proposeDataBankChange(bank.target);
      } else {
        const backup = await f.Stream.deploy(f.admin.address, f.streamer.address, 60);
        const report = await submit(f, replacementPrice, backup);
        expectedPair = report.pair;
        await time.increaseTo(report.at + 60n);
        await f.shepherd.proposeBackupChange(backup.target);
      }
      // The old source remains selected throughout the notice period.
      await expectQuotes(f, backupPrice);
      await f.shepherd.pause();
      const pausedAt = await f.shepherd.pausedAt();
      const proposedAt = source === "bank" ? await f.shepherd.dataBankProposedAt() : await f.shepherd.backupProposedAt();
      await time.setNextBlockTimestamp(proposedAt + (source === "bank" ? 300n : 600n));
      if (source === "bank") await f.shepherd.executeDataBankChange();
      else await f.shepherd.executeBackupChange();
      expect(await f.shepherd.mode()).to.equal(1);
      expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
      await expectRefusal(f, f.shepherd, "ShepherdPaused");
      if (source === "bank") {
        await f.backup.setCanRecover(f.queryId, true);
        await f.shepherd.connect(f.outsider).requestRecovery();
        await time.setNextBlockTimestamp((await f.shepherd.recoveryRequestedAt()) + 90n);
        await f.shepherd.connect(f.outsider).executeRecovery();
        await expectRefusal(f, f.shepherd, "ShepherdPaused");
      }
      await f.shepherd.unpause();
      expect(await f.oracle.shepherd()).to.equal(f.shepherd.target);
      expect(await f.oracle.queryId()).to.equal(f.queryId);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal(expectedPair);
      await expectQuotes(f, replacementPrice);
    });
  }

  it("rejects invalid timestamps, zero prices, and failed backup responses through real Shepherd", async function () {
    const f = await loadFixture(backupFixture);
    const Mock = await ethers.getContractFactory("BackupOracleMock");
    const mock = await Mock.deploy(f.queryId);
    await mock.configureRead(backupPrice, f.report.pair[1], 0);
    await f.shepherd.proposeBackupChange(mock.target);
    await f.shepherd.pause();
    await time.setNextBlockTimestamp((await f.shepherd.backupProposedAt()) + 600n);
    await f.shepherd.executeBackupChange();
    await f.shepherd.unpause();
    await expectQuotes(f, backupPrice);
    // Only the backup is a fault double; all calls still traverse the production Shepherd.
    await mock.configureRead(backupPrice, 0, 0);
    await expectRefusal(f, f.shepherd, "InvalidTimestamp");
    const nextBlock = BigInt(await time.latest()) + 1n;
    await time.setNextBlockTimestamp(nextBlock);
    await mock.configureRead(backupPrice, nextBlock * 1000n + 1n, 0);
    await expectRefusal(f, f.shepherd, "InvalidTimestamp");
    await mock.configureRead(0, f.report.pair[1], 0);
    await expectRefusal(f, f.shepherd, "ZeroValue");
    await mock.configureRead(backupPrice, f.report.pair[1], 1);
    await expectRefusal(f, mock, "ReadUnavailable");
    await mock.configureRead(backupPrice, f.report.pair[1], 2);
    await expectRefusal(f);
  });
});
