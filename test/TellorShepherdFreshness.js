const { loadFixture, time, setCode } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TellorShepherd - Shared freshness and latest-price interface", function () {
  const methods = ["getCurrentValue", "latestRoundData"];
  const price = 123456789n;

  async function fixture() {
    const [admin] = await ethers.getSigners();
    const queryId = ethers.id("freshness-feed");
    const bank = await (await ethers.getContractFactory("TwapDataBankMock")).deploy();
    const backup = await (await ethers.getContractFactory("BackupOracleMock")).deploy(queryId);
    const Shepherd = await ethers.getContractFactory("TellorShepherdHarness");
    const configuration = {
      queryId, dataBank: bank.target, backupOracle: backup.target, admin: admin.address,
      relayReadDelay: 120, dataBankChangeDelay: 300, backupChangeDelay: 600,
      twapWindowMs: 30000, challengeThresholdBps: 2000, challengeDelaySeconds: 30,
      recoveryDelaySeconds: 90, maxPriceAge: 3600, decimals: 8,
    };
    const shepherd = await Shepherd.deploy(configuration);
    const stamp = BigInt(await time.latest()) * 1000n;
    await bank.configureEnd(true, record(999n, stamp));
    await backup.configureRead(888n, stamp, 0);
    return { bank, backup, Shepherd, configuration, shepherd };
  }

  function record(value, stamp) {
    return [ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [value]), 1, stamp, stamp, 1];
  }

  // The doubles isolate timestamp faults; real admission/maturity is tested in the integration suite.
  async function configure(f, mode, value, stamp, at) {
    await time.setNextBlockTimestamp(at);
    if (mode === 0) await f.bank.configureEnd(true, record(value, stamp));
    else await f.backup.configureRead(value, stamp, 0);
  }

  async function expectRefusal(f, error) {
    for (const method of methods) {
      await expect(f.shepherd[method]()).to.be.revertedWithCustomError(f.shepherd, error);
    }
  }

  it("validates deployment age and exposes configured decimals without rescaling", async function () {
    const f = await loadFixture(fixture);
    for (const maxPriceAge of [0n, ethers.MaxUint256 / 1000n + 1n]) {
      await expect(f.Shepherd.deploy({ ...f.configuration, maxPriceAge }))
        .to.be.revertedWithCustomError(f.Shepherd, "InvalidMaxPriceAge");
    }
    for (const [maxPriceAge, decimals] of [[1n, 0], [ethers.MaxUint256 / 1000n, 255]]) {
      const shepherd = await f.Shepherd.deploy({ ...f.configuration, maxPriceAge, decimals });
      expect(await shepherd.MAX_PRICE_AGE()).to.equal(maxPriceAge);
      expect(await shepherd.decimals()).to.equal(decimals);
    }
    expect(await f.shepherd.MAX_PRICE_AGE()).to.equal(3600);
    expect(await f.shepherd.decimals()).to.equal(8);
  });

  for (const mode of [0, 1]) {
    for (const offset of [-1n, 0n, 1n]) {
      it(`checks exact millisecond age at limit ${offset}ms in source mode ${mode}`, async function () {
        const f = await loadFixture(fixture);
        await f.shepherd.setModeForTest(mode);
        const at = BigInt(await time.latest()) + 1n;
        const stamp = (at - 3600n) * 1000n - offset;
        await configure(f, mode, price, stamp, at);
        if (offset > 0) await expectRefusal(f, "StalePrice");
        else {
          expect(await f.shepherd.getCurrentValue()).to.deep.equal([price, stamp]);
          expect(await f.shepherd.latestRoundData()).to.deep.equal([0n, price, stamp / 1000n, stamp / 1000n, 0n]);
          await time.increase(1);
          await expectRefusal(f, "StalePrice");
        }
        expect(await f.shepherd.mode()).to.equal(mode);
      });
    }

    for (const fault of ["zero", "future by 1ms", "maximum uint256"]) {
      it(`rejects ${fault} timestamps in both APIs in source mode ${mode}`, async function () {
        const f = await loadFixture(fixture);
        await f.shepherd.setModeForTest(mode);
        const at = BigInt(await time.latest()) + 1n;
        const stamp = fault === "zero" ? 0n : fault === "maximum uint256" ? ethers.MaxUint256 : at * 1000n + 1n;
        await configure(f, mode, price, stamp, at);
        await expectRefusal(f, "InvalidTimestamp");
      });
    }

    it(`accepts the current timestamp, preserves precision, and does not replace it with read time in mode ${mode}`, async function () {
      const f = await loadFixture(fixture);
      await f.shepherd.setModeForTest(mode);
      const at = BigInt(await time.latest()) + 1n;
      const stamp = at * 1000n;
      await configure(f, mode, price, stamp, at);
      await time.increase(17);
      expect(await f.shepherd.getCurrentValue()).to.deep.equal([price, stamp]);
      expect(await f.shepherd.latestRoundData()).to.deep.equal([0n, price, at, at, 0n]);
    });

    it(`applies pause before source failures and keeps metadata readable in mode ${mode}`, async function () {
      const f = await loadFixture(fixture);
      await f.shepherd.setModeForTest(mode);
      await f.shepherd.pause();
      await setCode(mode === 0 ? f.bank.target : f.backup.target, "0x60006000fd");
      await expectRefusal(f, "ShepherdPaused");
      expect(await f.shepherd.decimals()).to.equal(8);
    });

    it(`propagates selected-source failure through both APIs without fallback in mode ${mode}`, async function () {
      const f = await loadFixture(fixture);
      await f.shepherd.setModeForTest(mode);
      await setCode(mode === 0 ? f.bank.target : f.backup.target, "0x60006000fd");
      for (const method of methods) await expect(f.shepherd[method]()).to.be.reverted;
    });

    it(`rejects zero prices and checks the signed-price boundary in mode ${mode}`, async function () {
      const f = await loadFixture(fixture);
      await f.shepherd.setModeForTest(mode);
      for (const value of [0n, (1n << 255n) - 1n, 1n << 255n, ethers.MaxUint256]) {
        const at = BigInt(await time.latest()) + 1n;
        const stamp = at * 1000n - 123n;
        await configure(f, mode, value, stamp, at);
        if (value === 0n) await expectRefusal(f, "ZeroValue");
        else {
          expect(await f.shepherd.getCurrentValue()).to.deep.equal([value, stamp]);
          if (value < (1n << 255n)) expect((await f.shepherd.latestRoundData()).answer).to.equal(value);
          else await expect(f.shepherd.latestRoundData()).to.be.revertedWithCustomError(f.shepherd, "PriceOutOfRange");
        }
      }
    });
  }
});
