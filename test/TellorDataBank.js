const {
  time,
  loadFixture,
} = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("../src/helpers/evmHelpers");

describe("TellorDataBank - Function Tests", function () {
  // Test data for ETH/USD price queries
  const abiCoder = new ethers.AbiCoder();
  const ETH_USD_QUERY_DATA_ARGS = abiCoder.encode(["string", "string"], ["eth", "usd"]);
  const ETH_USD_QUERY_DATA = abiCoder.encode(["string", "bytes"], ["SpotPrice", ETH_USD_QUERY_DATA_ARGS]);
  const ETH_USD_QUERY_ID = h.hash(ETH_USD_QUERY_DATA);

  // constants for testing
  const TELLOR_CHAIN_ID = "tellor-1";
  const UNBONDING_PERIOD = 86400 * 7 * 3; // 3 weeks
  const MAX_DATA_AGE = 24 * 60 * 60; // 24 hours
  const MAX_ATTESTATION_AGE = 10 * 60; // 10 minutes
  const OPTIMISTIC_DELAY = 12 * 60 * 60; // 12 hours
  const MS_PER_SECOND = 1000;

  // Fixture to deploy contracts for testing
  async function deployTellorDataBankFixture() {
    const [deployer, admin] = await ethers.getSigners();
    
    // Create tellor validator set
    const validatorSet = await h.createTellorValset({tellorChainId: TELLOR_CHAIN_ID});
    
    // Deploy TellorDataBridge
    const TellorDataBridge = await ethers.getContractFactory("TellorDataBridge");
    const dataBridge = await TellorDataBridge.deploy(admin.address, validatorSet.domainSeparator);
    await dataBridge.init(validatorSet.powerThreshold, validatorSet.timestamp, UNBONDING_PERIOD, validatorSet.checkpoint);

    // Deploy TellorDataBank
    const TellorDataBank = await ethers.getContractFactory("TellorDataBank");
    const tellorDataBank = await TellorDataBank.deploy(dataBridge.target, MAX_DATA_AGE, MAX_ATTESTATION_AGE, OPTIMISTIC_DELAY);
    await tellorDataBank.waitForDeployment();

    return {
      dataBridge,
      tellorDataBank,
      deployer,
      admin,
      validatorSet,
      threshold: validatorSet.powerThreshold,
    };
  }

  describe("Deployment", function () {
    it("Should set deployment variables correctly", async function () {
      const { tellorDataBank, dataBridge } = await loadFixture(deployTellorDataBankFixture);
      // tellorDataBank
      expect(await tellorDataBank.dataBridge()).to.equal(dataBridge.target);
      expect(await tellorDataBank.MAX_DATA_AGE()).to.equal(MAX_DATA_AGE);
      expect(await tellorDataBank.MAX_ATTESTATION_AGE()).to.equal(MAX_ATTESTATION_AGE);
      expect(await tellorDataBank.OPTIMISTIC_DELAY()).to.equal(OPTIMISTIC_DELAY);
      expect(await tellorDataBank.MS_PER_SECOND()).to.equal(MS_PER_SECOND);
    });
  });

  describe("Oracle Data Updates", function () {
    describe("updateOracleData", function () {
      it("Should successfully update oracle data with valid consensus data", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        // Mock ETH/USD price value
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);
        
        // Prepare oracle data
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet
        );
        
        // Update oracle data
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(ETH_USD_QUERY_ID, h.attestDataStructToArray(attestData));
        
        // Check that data was stored correctly
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        
        const aggData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 0);
        expect(aggData.aggregateTimestamp).to.equal(attestData.report.timestamp);
        
        expect(abiCoder.decode(["uint256"], aggData.value)[0]).to.equal(mockPrice);
        expect(aggData.power).to.equal(attestData.report.aggregatePower);
      });

      it("Should handle multiple oracle data updates with increasing timestamps", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice1 = h.toWei("2000");
        const mockPrice2 = h.toWei("2100");
        const mockValue1 = abiCoder.encode(["uint256"], [mockPrice1]);
        const mockValue2 = abiCoder.encode(["uint256"], [mockPrice2]);
        
        // First update
        let { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue1,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        
        // Wait some time before second update
        await time.increase(60);
        
        // Second update with newer timestamp
        ({ attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue2,
          validatorSet
        ));
        
        await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(2);
        
        // Check latest data
        const aggData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 1);
        expect(aggData.aggregateTimestamp).to.equal(attestData.report.timestamp);
        expect(abiCoder.decode(["uint256"], aggData.value)[0]).to.equal(mockPrice2);
        expect(aggData.power).to.equal(attestData.report.aggregatePower);
      });

      it("Should revert when data is too old", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        const mockValue = abiCoder.encode(["uint256"], [h.toWei("2000")]);
        
        // Create oracle data that's 25 hours old (past MAX_DATA_AGE of 24 hours)
        const blocky = await h.getBlock();
        const oldAggregateTimestamp = (blocky.timestamp - (25 * 3600)) * 1000; // 25 hours old in milliseconds
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: oldAggregateTimestamp,
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Data too old");
      });

      it("Should revert when attestation is too old", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);
        
        // Create oracle data with attestation that's 15 minutes old (past MAX_ATTESTATION_AGE of 10 minutes)
        const blocky = await h.getBlock();
        const oldAttestationTimestamp = (blocky.timestamp - (15 * 60)) * 1000; // 15 minutes old in milliseconds
        // Since attestationTimestamp must be >= aggregateTimestamp, we will set the aggregate timestamp to the attestation timestamp
        const oldAggregateTimestamp = oldAttestationTimestamp;
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: oldAggregateTimestamp,
            attestationTimestamp: oldAttestationTimestamp,
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Attestation too old");
      });

      it("Should revert when timestamp is not monotonically increasing", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice1 = h.toWei("2000");
        const mockPrice2 = h.toWei("2100");
        const mockValue1 = abiCoder.encode(["uint256"], [mockPrice1]);
        const mockValue2 = abiCoder.encode(["uint256"], [mockPrice2]);
        
        // First update with current timestamp
        let { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue1,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
        const firstTimestamp = attestData.report.timestamp;
        
        // Try to update with older timestamp
        const olderTimestamp = firstTimestamp - 10000; // 10 seconds earlier
        const { attestData: olderAttestData, currentValidatorSet: currentValidatorSet2, sigs: sigs2 } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue2,
          validatorSet,
          {
            aggregateTimestamp: olderTimestamp,
            lastConsensusTimestamp: olderTimestamp, // Consensus data
            attestationTimestamp: olderTimestamp + 1000
          }
        );
        
        // This should fail timestamp validation
        await expect(tellorDataBank.updateOracleData(olderAttestData, currentValidatorSet2, sigs2))
          .to.be.revertedWith("TellorDataBank: Report timestamp must increase");
      });

      it("Should successfully handle optimistic oracle data", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);
        
        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is 1 second ago
        const nextTimestamp = blocky.timestamp - 1;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1;


        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );
        
        // This should succeed if all optimistic data validation passes
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(ETH_USD_QUERY_ID, h.attestDataStructToArray(attestData));
        
        // Verify data was stored
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);

        const aggData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 0);
        expect(aggData.aggregateTimestamp).to.equal(attestData.report.timestamp);
        expect(abiCoder.decode(["uint256"], aggData.value)[0]).to.equal(mockPrice);
        expect(aggData.power).to.equal(attestData.report.aggregatePower);
      });

      it("Should revert with insufficient power for optimistic data", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);
        
        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is 1 second ago
        const nextTimestamp = blocky.timestamp - 1;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2
        const insufficientPower = threshold / 2; 

        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: insufficientPower
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Insufficient optimistic report power");
      });

      it("Should revert optimistic data when dispute period hasn't passed", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);

        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay - 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY + 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is 1 second ago
        const nextTimestamp = blocky.timestamp - 1;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1; 
        
        // Create optimistic data with insufficient delay (6 hours < 12 hour requirement)
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Dispute period not passed");
      });

      it("Should revert when more recent optimistic report is available", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice = h.toWei("2000");
        const mockValue = abiCoder.encode(["uint256"], [mockPrice]);

        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is optimistic but later than aggregate timestamp
        const nextTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 1000;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1; 
        // Create data with nextTimestamp optimistic
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: More recent optimistic report available");
      });

      it("Should successfully handle consensus data vs optimistic data", async function () {
        const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockPrice1 = h.toWei("2000");
        const mockPrice2 = h.toWei("2100");
        const mockValue1 = abiCoder.encode(["uint256"], [mockPrice1]);
        const mockValue2 = abiCoder.encode(["uint256"], [mockPrice2]);
        
        // First, add consensus data
        const { attestData: consensusData, currentValidatorSet, sigs: consensusSigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue1,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(consensusData, currentValidatorSet, consensusSigs);
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
// Wait some time, then add optimistic data
        await time.increase(24 * 3600); // 24 hours

        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp hasn't passed optimistic delay
        const nextTimestamp = blocky.timestamp - OPTIMISTIC_DELAY + 3600;
        // last consensus timestamp is before the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp - 3600;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1; 

        const { attestData: optimisticData, currentValidatorSet: optimisticCurrentValidatorSet, sigs: optimisticSigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue2,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );

        await tellorDataBank.updateOracleData(optimisticData, optimisticCurrentValidatorSet, optimisticSigs);
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(2);
        
        // Verify the latest data is the optimistic data
        const aggData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 1);
        expect(aggData.aggregateTimestamp).to.equal(optimisticData.report.timestamp);
        expect(abiCoder.decode(["uint256"], aggData.value)[0]).to.equal(mockPrice2);
        expect(aggData.power).to.equal(optimisticData.report.aggregatePower);
});

      it("Should revert optimistic data when newer consensus data is available", async function () {
         const { tellorDataBank, validatorSet, threshold } = await loadFixture(deployTellorDataBankFixture);
        
        const mockValue = abiCoder.encode(["uint256"], [h.toWei("2000")]);

        // Set custom values for optimistic data
        const blocky = await h.getBlock();
        // optimistic delay + 1 hours ago
        const aggregateTimestamp = blocky.timestamp - OPTIMISTIC_DELAY - 3600;
        // 1 second ago
        const attestationTimestamp = blocky.timestamp - 1;
        // previous timestamp is 0
        const previousTimestamp = 0;
        // next timestamp is 1 second ago
        const nextTimestamp = blocky.timestamp - 1;
        // last consensus timestamp is after the aggregate timestamp
        const lastConsensusTimestamp = aggregateTimestamp + 1;
        // aggregate power is threshold / 2 + 1
        const aggregatePower = threshold / 2 + 1; 
        
        const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          mockValue,
          validatorSet,
          {
            aggregateTimestamp: aggregateTimestamp * 1000,
            attestationTimestamp: attestationTimestamp * 1000,
            previousTimestamp: previousTimestamp * 1000,
            nextTimestamp: nextTimestamp * 1000,
            lastConsensusTimestamp: lastConsensusTimestamp * 1000,
            aggregatePower: aggregatePower
          }
        );
        
        await expect(tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs))
          .to.be.revertedWith("TellorDataBank: Newer consensus data available");
      });
    });
  });

  describe("Multi-Query ID Tests for TellorDataBank", function () {
    // Define additional query IDs for testing
    const BTC_USD_QUERY_DATA_ARGS = abiCoder.encode(["string", "string"], ["btc", "usd"]);
    const BTC_USD_QUERY_DATA = abiCoder.encode(["string", "bytes"], ["SpotPrice", BTC_USD_QUERY_DATA_ARGS]);
    const BTC_USD_QUERY_ID = h.hash(BTC_USD_QUERY_DATA);

    const ETH_EUR_QUERY_DATA_ARGS = abiCoder.encode(["string", "string"], ["eth", "eur"]);
    const ETH_EUR_QUERY_DATA = abiCoder.encode(["string", "bytes"], ["SpotPrice", ETH_EUR_QUERY_DATA_ARGS]);
    const ETH_EUR_QUERY_ID = h.hash(ETH_EUR_QUERY_DATA);

    describe("Storing data for multiple query IDs", function () {
      it("Should store data for different query IDs simultaneously", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        // Mock price values for different assets
        const ethPrice = h.toWei("2000");
        const btcPrice = h.toWei("45000");
        const ethEurPrice = h.toWei("1800");
        
        const ethValue = abiCoder.encode(["uint256"], [ethPrice]);
        const btcValue = abiCoder.encode(["uint256"], [btcPrice]);
        const ethEurValue = abiCoder.encode(["uint256"], [ethEurPrice]);
        
        // Prepare oracle data for ETH/USD
        const { attestData: ethAttestData, currentValidatorSet: ethValidatorSet, sigs: ethSigs } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          ethValue,
          validatorSet
        );
        
        // Wait a bit for different timestamps
        await time.increase(1);
        
        // Prepare oracle data for BTC/USD
        const { attestData: btcAttestData, currentValidatorSet: btcValidatorSet, sigs: btcSigs } = await h.prepareOracleData(
          BTC_USD_QUERY_ID,
          btcValue,
          validatorSet
        );
        
        // Wait a bit for different timestamps
        await time.increase(1);
        
        // Prepare oracle data for ETH/EUR
        const { attestData: ethEurAttestData, currentValidatorSet: ethEurValidatorSet, sigs: ethEurSigs } = await h.prepareOracleData(
          ETH_EUR_QUERY_ID,
          ethEurValue,
          validatorSet
        );
        
        // Update oracle data for all three query IDs
        await expect(tellorDataBank.updateOracleData(ethAttestData, ethValidatorSet, ethSigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(ETH_USD_QUERY_ID, h.attestDataStructToArray(ethAttestData));
        
        await expect(tellorDataBank.updateOracleData(btcAttestData, btcValidatorSet, btcSigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(BTC_USD_QUERY_ID, h.attestDataStructToArray(btcAttestData));
        
        await expect(tellorDataBank.updateOracleData(ethEurAttestData, ethEurValidatorSet, ethEurSigs))
          .to.emit(tellorDataBank, "OracleUpdated")
          .withArgs(ETH_EUR_QUERY_ID, h.attestDataStructToArray(ethEurAttestData));
        
        // Verify all data was stored correctly
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(1);
        expect(await tellorDataBank.getAggregateValueCount(ETH_EUR_QUERY_ID)).to.equal(1);
        
        // Verify data integrity for each query ID
        const ethData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 0);
        const btcData = await tellorDataBank.getAggregateByIndex(BTC_USD_QUERY_ID, 0);
        const ethEurData = await tellorDataBank.getAggregateByIndex(ETH_EUR_QUERY_ID, 0);
        
        expect(abiCoder.decode(["uint256"], ethData.value)[0]).to.equal(ethPrice);
        expect(abiCoder.decode(["uint256"], btcData.value)[0]).to.equal(btcPrice);
        expect(abiCoder.decode(["uint256"], ethEurData.value)[0]).to.equal(ethEurPrice);
        
        expect(ethData.aggregateTimestamp).to.equal(ethAttestData.report.timestamp);
        expect(btcData.aggregateTimestamp).to.equal(btcAttestData.report.timestamp);
        expect(ethEurData.aggregateTimestamp).to.equal(ethEurAttestData.report.timestamp);
      });

      it("Should handle multiple updates for the same query ID without affecting others", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        // Initial prices
        const ethPrice1 = h.toWei("2000");
        const ethPrice2 = h.toWei("2100");
        const btcPrice = h.toWei("45000");
        
        const ethValue1 = abiCoder.encode(["uint256"], [ethPrice1]);
        const ethValue2 = abiCoder.encode(["uint256"], [ethPrice2]);
        const btcValue = abiCoder.encode(["uint256"], [btcPrice]);
        
        // Store initial data for both query IDs
        let { attestData: ethAttestData1, currentValidatorSet: ethValidatorSet1, sigs: ethSigs1 } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          ethValue1,
          validatorSet
        );
        
        await time.increase(1);
        
        const { attestData: btcAttestData, currentValidatorSet: btcValidatorSet, sigs: btcSigs } = await h.prepareOracleData(
          BTC_USD_QUERY_ID,
          btcValue,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(ethAttestData1, ethValidatorSet1, ethSigs1);
        await tellorDataBank.updateOracleData(btcAttestData, btcValidatorSet, btcSigs);
        
        // Verify initial state
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(1);
        expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(1);
        
        // Update ETH/USD again
        await time.increase(60);
        
        const { attestData: ethAttestData2, currentValidatorSet: ethValidatorSet2, sigs: ethSigs2 } = await h.prepareOracleData(
          ETH_USD_QUERY_ID,
          ethValue2,
          validatorSet
        );
        
        await tellorDataBank.updateOracleData(ethAttestData2, ethValidatorSet2, ethSigs2);
        
        // Verify ETH/USD has 2 entries, BTC/USD still has 1
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(2);
        expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(1);
        
        // Verify latest ETH/USD data
        const latestEthData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, 1);
        expect(abiCoder.decode(["uint256"], latestEthData.value)[0]).to.equal(ethPrice2);
        
        // Verify BTC/USD data is unchanged
        const btcData = await tellorDataBank.getAggregateByIndex(BTC_USD_QUERY_ID, 0);
        expect(abiCoder.decode(["uint256"], btcData.value)[0]).to.equal(btcPrice);
        expect(btcData.aggregateTimestamp).to.equal(btcAttestData.report.timestamp);
      });

      it("Should maintain independent data arrays for different query IDs", async function () {
        const { tellorDataBank, validatorSet } = await loadFixture(deployTellorDataBankFixture);
        
        // Store 3 updates for ETH/USD and 2 updates for BTC/USD
        const ethPrices = [h.toWei("2000"), h.toWei("2100"), h.toWei("2200")];
        const btcPrices = [h.toWei("45000"), h.toWei("46000")];
        
        // Store ETH/USD data
        for (let i = 0; i < ethPrices.length; i++) {
          const ethValue = abiCoder.encode(["uint256"], [ethPrices[i]]);
          const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
            ETH_USD_QUERY_ID,
            ethValue,
            validatorSet
          );
          await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
          await time.increase(60);
          expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(i + 1);
          expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(0);
        }
        
        // Store BTC/USD data
        for (let i = 0; i < btcPrices.length; i++) {
          const btcValue = abiCoder.encode(["uint256"], [btcPrices[i]]);
          const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(
            BTC_USD_QUERY_ID,
            btcValue,
            validatorSet,
          );
          await tellorDataBank.updateOracleData(attestData, currentValidatorSet, sigs);
          await time.increase(60);
          expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(3);
          expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(i + 1);
        }
        
        // Verify independent counts
        expect(await tellorDataBank.getAggregateValueCount(ETH_USD_QUERY_ID)).to.equal(3);
        expect(await tellorDataBank.getAggregateValueCount(BTC_USD_QUERY_ID)).to.equal(2);
        
        // Verify all ETH/USD data
        for (let i = 0; i < ethPrices.length; i++) {
          const ethData = await tellorDataBank.getAggregateByIndex(ETH_USD_QUERY_ID, i);
          expect(abiCoder.decode(["uint256"], ethData.value)[0]).to.equal(ethPrices[i]);
        }
        
        // Verify all BTC/USD data
        for (let i = 0; i < btcPrices.length; i++) {
          const btcData = await tellorDataBank.getAggregateByIndex(BTC_USD_QUERY_ID, i);
          expect(abiCoder.decode(["uint256"], btcData.value)[0]).to.equal(btcPrices[i]);
        }
      });
    });
  });


});
