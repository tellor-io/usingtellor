const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { loadFixture, time, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
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
  const backupPrice = 4500n * unit;
  const maxAge = 3600n;
  const usd = ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(840), 20));
  const coder = ethers.AbiCoder.defaultAbiCoder();

  async function sources(bank, queryId, decimals = 18) {
    const primary = await (await ethers.getContractFactory("TellorTwapSource")).deploy(bank, queryId, decimals, 60, 30000);
    const backup = await (await ethers.getContractFactory("TellorSpotSource")).deploy(bank, queryId, decimals, 60);
    return { primary, backup };
  }

  async function fixture(feedDecimals = 18) {
    const [admin, outsider] = await ethers.getSigners();
    const queryId = ethers.keccak256(coder.encode(
      ["string", "bytes"], ["SpotPrice", coder.encode(["string", "string"], ["eth", "usd"])]
    ));
    const validatorSet = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const Bridge = await ethers.getContractFactory("TellorDataBridge");
    const bridge = await Bridge.deploy(admin.address, validatorSet.domainSeparator);
    await bridge.init(validatorSet.powerThreshold, validatorSet.timestamp, 21 * 86400, validatorSet.checkpoint);
    const Bank = await ethers.getContractFactory("TellorDataBank");
    const bank = await Bank.deploy(bridge.target, 43200, 600, 86400);
    const shepherdFactory = await (await ethers.getContractFactory("TellorShepherdFactory")).deploy();
    const { primary, backup } = await sources(bank.target, queryId, feedDecimals);
    const config = [queryId, feedDecimals, primary.target, backup.target, admin.address,
      120, 300, 2000, 30, 90, 3600];
    const address = await shepherdFactory.createShepherd.staticCall(config, ethers.ZeroHash);
    await shepherdFactory.createShepherd(config, ethers.ZeroHash);
    const shepherd = await ethers.getContractAt("TellorShepherd", address);
    const Token = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode.object, admin);
    const base = (await Token.deploy(18)).target;
    const Adaptor = new ethers.ContractFactory(adaptorArtifact.abi, adaptorArtifact.bytecode.object, admin);
    const f = { admin, outsider, queryId, validatorSet, Bank, bank,
      shepherdFactory, shepherd, primary, backup, Token, Adaptor, base, quote: usd };
    f.oracle = await deployAdaptor(f, { decimals: feedDecimals });
    f.startMs = (await time.latest() - 120) * 1000 + 17;
    return f;
  }

  function deployAdaptor(f, { base = f.base, quote = f.quote, decimals = 18, queryId = f.queryId } = {}) {
    return f.Adaptor.deploy(f.shepherdFactory.target, base, quote, f.shepherd.target, queryId, decimals);
  }

  async function relay(f, value, stamp, bank = f.bank) {
    const report = await h.prepareOracleData(f.queryId, coder.encode(["uint256"], [value]), f.validatorSet,
      { aggregateTimestamp: stamp, attestationTimestamp: (await time.latest()) * 1000 });
    await bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
    return BigInt(await time.latest());
  }

  async function relayWindow(f, value, stamp, bank = f.bank) {
    await relay(f, value, stamp - 30000, bank);
    return relay(f, value, stamp, bank);
  }

  async function primaryFixture() {
    const f = await fixture();
    await relay(f, primaryPrice, f.startMs);
    const at = await relay(f, primaryPrice, f.startMs + 30000);
    await time.increaseTo(at + 61n);
    return f;
  }

  async function requestChallenge(f) {
    const relayAt = await relay(f, backupPrice, f.startMs + 40000);
    f.report = { relayAt, pair: [backupPrice, BigInt(f.startMs + 40000)] };
    await time.increaseTo(relayAt + 61n);
    await f.shepherd.connect(f.outsider).requestChallenge();
    return await f.shepherd.challengeRequestedAt();
  }

  async function backupFixture() {
    const f = await primaryFixture();
    const requestedAt = await requestChallenge(f);
    await time.setNextBlockTimestamp(requestedAt + 30n);
    await f.shepherd.connect(f.outsider).executeChallenge();
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

  it("rejects a genuine Shepherd registered only in a different factory", async function () {
    const f = await loadFixture(primaryFixture);
    expect(await f.shepherdFactory.isShepherd(f.shepherd.target)).to.equal(true);
    const otherFactory = await (await ethers.getContractFactory("TellorShepherdFactory")).deploy();
    await expect(deployAdaptor({ ...f, shepherdFactory: otherFactory }))
      .to.be.revertedWithCustomError(f.oracle, "PriceOracle_InvalidConfiguration");
  });

  it("requires mature TWAP coverage and excludes the endpoint price", async function () {
    const f = await loadFixture(fixture);
    await expectRefusal(f, f.primary, "NoTwapData");
    const first = await relay(f, primaryPrice, f.startMs);
    await time.increaseTo(first + 61n);
    await expectRefusal(f, f.primary, "NoTwapData");
    const end = await relay(f, primaryPrice * 2n, f.startMs + 30000);
    await time.increaseTo(end + 60n);
    await expectRefusal(f, f.primary, "NoTwapData");
    await time.increase(1);
    await expectQuotes(f, primaryPrice);
    await relay(f, primaryPrice * 3n, f.startMs + 40000);
    await expectQuotes(f, primaryPrice);
  });

  it("waits for backup relay maturity before challenge, including strict equality", async function () {
    const f = await loadFixture(primaryFixture);
    const relayAt = await relay(f, backupPrice, f.startMs + 40000);
    await time.setNextBlockTimestamp(relayAt + 60n);
    await expect(f.shepherd.requestChallenge()).to.be.revertedWithCustomError(f.shepherd, "NotDeviating");
    await time.setNextBlockTimestamp(relayAt + 61n);
    await f.shepherd.requestChallenge();
    const requestedAt = await f.shepherd.challengeRequestedAt();
    await time.setNextBlockTimestamp(requestedAt + 30n);
    await f.shepherd.executeChallenge();
    await expectQuotes(f, backupPrice);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([backupPrice, BigInt(f.startMs + 40000)]);
  });

  for (const excessMs of [-1, 0, 1]) {
    it(`enforces primary age at 3600s ${excessMs >= 0 ? "+" : ""}${excessMs}ms`, async function () {
      const f = await loadFixture(fixture);
      const anchor = await time.latest() - 120;
      const stamp = anchor * 1000 - excessMs;
      await relayWindow(f, primaryPrice, stamp);
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

  it("preserves backup age across repeated reads and refuses once stale", async function () {
    const f = await loadFixture(backupFixture);
    await expectQuotes(f, backupPrice);
    await time.increaseTo(f.report.pair[1] / 1000n + maxAge);
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
      await relayWindow(f, example.price, f.startMs);
      await time.increase(61);
      await expectQuotes({ ...f, base, quote, oracle }, example.price, example);
    });
  }

  it("executes a challenge at its deadline while preserving pause and its clock", async function () {
    const f = await loadFixture(primaryFixture);
    const requestedAt = await requestChallenge(f);
    await f.shepherd.pause();
    const pausedAt = await f.shepherd.pausedAt();
    await time.setNextBlockTimestamp(requestedAt + 29n);
    await expect(f.shepherd.connect(f.outsider).executeChallenge())
      .to.be.revertedWithCustomError(f.shepherd, "ChallengeDelayNotElapsed");
    await time.setNextBlockTimestamp(requestedAt + 30n);
    await f.shepherd.connect(f.outsider).executeChallenge();
    expect(await f.shepherd.mode()).to.equal(1);
    expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
    await expectRefusal(f, f.shepherd, "ShepherdPaused");
    await expect(f.shepherd.unpause()).to.be.revertedWithCustomError(f.shepherd, "PauseDurationNotElapsed");
    if (BigInt(await time.latest()) < pausedAt + 120n) await time.setNextBlockTimestamp(pausedAt + 120n);
    await f.shepherd.unpause();
    await expectQuotes(f, backupPrice);
  });

  it("rechecks recovery agreement, honors the deadline, and preserves pause", async function () {
    const f = await loadFixture(backupFixture);
    await expect(f.shepherd.connect(f.outsider).requestRecovery())
      .to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
    const settled = await relay(f, backupPrice, f.startMs + 70000);
    await time.increaseTo(settled + 61n);
    await f.shepherd.pause();
    const pausedAt = await f.shepherd.pausedAt();
    await f.shepherd.connect(f.outsider).requestRecovery();
    const requestedAt = await f.shepherd.recoveryRequestedAt();
    await time.setNextBlockTimestamp(requestedAt + 89n);
    await expect(f.shepherd.executeRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryDelayNotElapsed");
    await time.increaseTo(requestedAt + 90n);
    await f.shepherd.executeRecovery.staticCall();
    await relay(f, backupPrice * 2n, f.startMs + 80000);
    await time.increase(61);
    await expect(f.shepherd.executeRecovery()).to.be.revertedWithCustomError(f.shepherd, "RecoveryNotAllowed");
    expect(await f.shepherd.recoveryRequestedAt()).to.equal(requestedAt);
    expect(await f.shepherd.mode()).to.equal(1);
    await relay(f, backupPrice, f.startMs + 90000);
    await time.increase(61);
    await f.shepherd.connect(f.outsider).executeRecovery();
    expect(await f.shepherd.mode()).to.equal(0);
    expect(await f.shepherd.recoveryPending()).to.equal(false);
    expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
    await expectRefusal(f, f.shepherd, "ShepherdPaused");
    if (BigInt(await time.latest()) < pausedAt + 120n) await time.setNextBlockTimestamp(pausedAt + 120n);
    await f.shepherd.unpause();
    // 4500 held for 40000ms plus 9000 for 10000ms over 50000ms gives 5400.
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([backupPrice * 6n / 5n, BigInt(f.startMs + 90000)]);
    await expectQuotes(f, backupPrice * 6n / 5n);
  });

  it("keeps adaptor wiring through paused source-pair migration and recovery", async function () {
    const f = await loadFixture(backupFixture);
    const replacementPrice = 3200n * unit;
    const bank = await f.Bank.deploy(await f.bank.dataBridge(), 43200, 600, 86400);
    await relayWindow(f, replacementPrice, f.startMs + 50000, bank);
    const next = await sources(bank.target, f.queryId);
    await f.shepherd.proposeSourcesChange(next.primary.target, next.backup.target);
    await expectQuotes(f, backupPrice);
    await f.shepherd.pause();
    const pausedAt = await f.shepherd.pausedAt();
    await time.setNextBlockTimestamp((await f.shepherd.sourcesProposedAt()) + 300n);
    await f.shepherd.executeSourcesChange();
    expect(await f.shepherd.mode()).to.equal(1);
    expect(await f.shepherd.pausedAt()).to.equal(pausedAt);
    await expectRefusal(f, f.shepherd, "ShepherdPaused");
    await f.shepherd.connect(f.outsider).requestRecovery();
    await time.setNextBlockTimestamp((await f.shepherd.recoveryRequestedAt()) + 90n);
    await f.shepherd.connect(f.outsider).executeRecovery();
    await expectRefusal(f, f.shepherd, "ShepherdPaused");
    await f.shepherd.unpause();
    expect(await f.oracle.shepherd()).to.equal(f.shepherd.target);
    expect(await f.oracle.queryId()).to.equal(f.queryId);
    expect(await f.shepherd.getCurrentValue()).to.deep.equal([replacementPrice, BigInt(f.startMs + 50000)]);
    await expectQuotes(f, replacementPrice);
  });

  it("rejects invalid source timestamps, prices and source failures", async function () {
    const f = await loadFixture(backupFixture);
    const mock = await (await ethers.getContractFactory("PriceSourceMock")).deploy(f.queryId, 18);
    await mock.configureRead(backupPrice, f.report.pair[1], 0);
    await f.shepherd.proposeSourcesChange(f.primary.target, mock.target);
    await f.shepherd.pause();
    await time.setNextBlockTimestamp((await f.shepherd.sourcesProposedAt()) + 300n);
    await f.shepherd.executeSourcesChange();
    await f.shepherd.unpause();
    await expectQuotes(f, backupPrice);
    // Only the source is a fault double; all reads traverse the production Shepherd.
    await mock.configureRead(backupPrice, 0, 0);
    await expectRefusal(f, f.shepherd, "InvalidTimestamp");
    await mock.configureRead(backupPrice, (BigInt(await time.latest()) + 10n) * 1000n, 0);
    await expectRefusal(f, f.shepherd, "InvalidTimestamp");
    await mock.configureRead(0, f.report.pair[1], 0);
    await expectRefusal(f, f.shepherd, "ZeroValue");
    await mock.configureRead(backupPrice, f.report.pair[1], 1);
    await expectRefusal(f, mock, "ReadUnavailable");
    for (const code of ["0x60006000fd", "0x60016000f3"]) {
      await setCode(mock.target, code);
      await expectRefusal(f);
    }
  });
});
