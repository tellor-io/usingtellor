var assert = require('assert');
const h = require("../src/helpers/evmHelpers.js")
const abiCoder = new ethers.AbiCoder();

// encode query data and query id for eth/usd price feed
const ETH_USD_QUERY_DATA_ARGS = abiCoder.encode(["string","string"], ["eth","usd"])
const ETH_USD_QUERY_DATA = abiCoder.encode(["string", "bytes"], ["SpotPrice", ETH_USD_QUERY_DATA_ARGS])
const ETH_USD_QUERY_ID = h.hash(ETH_USD_QUERY_DATA)

// define tellor chain parameters
const TELLOR_CHAIN_ID = "tellor-1"

describe("TellorLab - Function Tests", function () {
  // init the assets which will be used in the tests
  let accounts, databank, validatorSet;

  beforeEach(async function () {
    // init accounts
    accounts = await ethers.getSigners();
    // init tellor validator set
    validatorSet = await h.createTellorValset({tellorChainId: TELLOR_CHAIN_ID})
    // deploy databank
    databank = await ethers.deployContract("TellorLab");
  })

  it("updateOracleData, getCurrentData, getValueCount", async function () {
    // "value" is the reported oracle data, in this case the ETH/USD price
    price = "3000";
    priceWithDecimals = h.toWei(price);
    let _value = abiCoder.encode(["uint256"], [priceWithDecimals])
    const { attestData, currentValidatorSet, sigs } = await h.prepareOracleData(ETH_USD_QUERY_ID, _value, validatorSet)
    let _b = await h.getBlock() // get block before update
    await databank.updateOracleData(attestData, currentValidatorSet, sigs);
    let _dataRetrieved =  await databank.getCurrentAggregateData(ETH_USD_QUERY_ID);
    assert.equal(_dataRetrieved.value, _value, "value should be correct");
    // report timestamp is defined in prepareOracleData as: (block.timestamp - 2) * 1000
    assert.equal(_dataRetrieved.aggregateTimestamp, (_b.timestamp - 2) * 1000, "timestamp should be correct")
    assert.equal(await databank.getAggregateValueCount(ETH_USD_QUERY_ID), 1, "value count should be correct")
  });

  it("updateOracleDataLab, getCurrentData, getValueCount", async function () {
    // price as $3000
    price = "3000";
    // SpotPrice reported with 18 decimals
    priceWithDecimals = h.toWei(price);
    // encode the price as bytes
    let _value = abiCoder.encode(["uint256"], [priceWithDecimals])
    // update the oracle data using the lab function
    await databank.updateOracleDataLab(ETH_USD_QUERY_ID, _value);
    // get the current aggregate data
    let _dataRetrieved =  await databank.getCurrentAggregateData(ETH_USD_QUERY_ID);
    // assert the value is correct
    assert.equal(_dataRetrieved.value, _value, "value should be correct");
    // assert the value count is correct
    assert.equal(await databank.getAggregateValueCount(ETH_USD_QUERY_ID), 1, "value count should be correct")
  });
});

