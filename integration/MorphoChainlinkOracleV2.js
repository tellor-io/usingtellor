const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

// Uses unmodified upstream contracts with their own compiler configuration, outside the normal suite.
describe("MorphoChainlinkOracleV2 - Direct Shepherd feeds", function () {
  let oracleArtifact;
  before(function () {
    this.timeout(120000);
    const root = path.resolve(process.env.MORPHO_CHAINLINK_ROOT || path.join(__dirname, "../../morpho-blue-oracles"));
    execFileSync("forge", ["build", "--root", root, "src/morpho-chainlink/MorphoChainlinkOracleV2.sol"],
      { stdio: "inherit", timeout: 110000 });
    oracleArtifact = JSON.parse(fs.readFileSync(path.join(root,
      "out/MorphoChainlinkOracleV2.sol/MorphoChainlinkOracleV2.json"), "utf8"));
  });

  const prices = [3000n * 10n ** 8n, 10n ** 18n];
  const backupPrices = [2900n * 10n ** 8n, 2n * 10n ** 18n];

  async function relay(f, leg, price, offset) {
    const report = await h.prepareOracleData(f.ids[leg],
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [price]), f.validators,
      { aggregateTimestamp: f.startMs + offset, attestationTimestamp: (await time.latest()) * 1000 });
    await f.bank.updateOracleData(report.attestData, report.currentValidatorSet, report.sigs);
  }

  async function fixture() {
    const [admin, streamer, outsider] = await ethers.getSigners();
    const ids = [ethers.id("eth-usd-chainlink-interface"), ethers.id("usdc-usd-chainlink-interface")];
    const validators = await h.createTellorValset({ tellorChainId: "tellor-1" });
    const bridge = await (await ethers.getContractFactory("TellorDataBridge")).deploy(admin.address, validators.domainSeparator);
    await bridge.init(validators.powerThreshold, validators.timestamp, 21 * 86400, validators.checkpoint);
    const bank = await (await ethers.getContractFactory("TellorDataBank")).deploy(bridge.target);
    const backup = await (await ethers.getContractFactory("StreamBackupOracle")).deploy(admin.address, streamer.address, 60);
    const Shepherd = await ethers.getContractFactory("TellorShepherd");
    const shepherds = [];
    for (const leg of [0, 1]) shepherds.push(await Shepherd.deploy({
      queryId: ids[leg], dataBank: bank.target, backupOracle: backup.target, admin: admin.address,
      relayReadDelay: 120, dataBankChangeDelay: 300, backupChangeDelay: 600,
      twapWindowMs: 30000, challengeThresholdBps: 2000, challengeDelaySeconds: 30,
      recoveryDelaySeconds: 90, maxPriceAge: 3600, decimals: leg === 0 ? 8 : 18,
    }));
    const Oracle = new ethers.ContractFactory(oracleArtifact.abi, oracleArtifact.bytecode.object, admin);
    const zero = ethers.ZeroAddress;
    const oracle = await Oracle.deploy(zero, 1, shepherds[0].target, zero, 18,
      zero, 1, shepherds[1].target, zero, 6);
    const f = { admin, streamer, outsider, ids, validators, bank, backup, shepherds, oracle,
      startMs: (await time.latest() - 120) * 1000 + 17 };
    for (const leg of [0, 1]) {
      await relay(f, leg, prices[leg], 0);
      await relay(f, leg, prices[leg], 30000);
    }
    await time.increase(121);
    return f;
  }

  async function switchToBackup(f, leg) {
    await relay(f, leg, prices[leg] * 3n / 2n, 40000);
    await f.backup.connect(f.streamer).submitValue(f.ids[leg], backupPrices[leg]);
    const submittedAt = BigInt(await time.latest());
    await f.shepherds[leg].connect(f.outsider).requestChallenge();
    await relay(f, leg, prices[leg], 45000);
    await time.increase(30);
    await f.shepherds[leg].connect(f.outsider).resolveChallenge();
    await time.increaseTo(submittedAt + 60n);
  }

  for (const modes of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    it(`prices mixed feed/token decimals with real source modes ${modes.join("/")}`, async function () {
      const f = await loadFixture(fixture);
      for (const leg of [0, 1]) if (modes[leg]) await switchToBackup(f, leg);
      const values = modes.map((mode, leg) => mode ? backupPrices[leg] : prices[leg]);
      expect(await f.oracle.price()).to.equal(values[0] * 10n ** 34n / values[1]);
      await time.increase(3601);
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[0], "StalePrice");
    });
  }

  for (const leg of [0, 1]) {
    it(`propagates pause on feed ${leg} and accepts the same data after unpause`, async function () {
      const f = await loadFixture(fixture);
      await f.shepherds[leg].pause();
      await expect(f.oracle.price()).to.be.revertedWithCustomError(f.shepherds[leg], "ShepherdPaused");
      await time.increase(120);
      await f.shepherds[leg].unpause();
      expect(await f.oracle.price()).to.equal(3000n * 10n ** 24n);
    });
  }
});
