/** 
* This tests the oracle functions as they are called through the
* TestContract(which is Optimistic and Optimistic is UsingTellor).
*/
const Web3 = require('web3');
const web3 = new Web3(new Web3.providers.WebsocketProvider('ws://localhost:8545'));
const helper = require("./helpers/test_helpers");
const UsingTellor = artifacts.require("./UsingTellor.sol");
const TellorMaster = artifacts.require("..testContracts/TellorMaster.sol");
const Tellor = artifacts.require("./Tellor.sol"); // globally injected artifacts helper
var masterAbi = TellorMaster.abi;
const oracleAbi = Tellor.abi;
const Mappings = artifacts.require("./OracleIDDescriptions");
var bytes = "0xdfaa6f747f0f012e8f2069d6ecacff25f5cdf0258702051747439949737fc0b5";

var api = "json(https://api.gdax.com/products/BTC-USD/ticker).price";
var api3 = "json(https://api.gdax.com/products/ETH-BTC/ticker).price";
var api2 = "json(https://api.gdax.com/products/ETH-USD/ticker).price";

contract('UsingTellor Tests', function(accounts) {
  let oracleBase;
  let oracle;
  let oracle2;
  let usingTellor;
  let oa;
  let master;
  let mappings;

    beforeEach('Setup contract for each test', async function () {
        oracleBase = await Tellor.new()
        oracle = await TellorMaster.new(web3.utils.toChecksumAddress(oracleBase.address));
        master = await new web3.eth.Contract(masterAbi,oracle.address);
        oa = (web3.utils.toChecksumAddress(oracle.address))
        oracle2 = await new web3.eth.Contract(oracleAbi,oa);
        await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api,"BTC/USD",1000,0).encodeABI()})
        var varsid = await oracle.getVariablesOnDeck()
        usingTellor = await UsingTellor.new(oa)
        await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.theLazyCoon(accounts[2],web3.utils.toWei('10000', 'ether')).encodeABI()})
        mappings = await Mappings.new();
        await mappings.defineTellorCodeToStatusCode(0,400);
        await mappings.defineTellorCodeToStatusCode(1,200);
        await mappings.defineTellorCodeToStatusCode(2,404);
        await mappings.defineTellorIdToBytesID(1,bytes);
        await mappings.defineTellorIdtoAdjFactor(1, 1e0);
        await usingTellor.setOracleIDDescriptors(mappings.address);
    })

    it("Test getCurrentValue", async function(){
        for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         }
        let vars = await usingTellor.getCurrentValue.call(1)
        assert(vars[0] == true, "ifRetreive is not true")
        assert(vars[1] == 1200, "Get last value should work")
    })

    it("Test valueFor", async function(){
        for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         }
        let _id = web3.utils.keccak256(api, 1000)
        let vars = await usingTellor.valueFor(bytes)
        
        // console.log("vars0",  web3.utils.hexToNumberString(vars[0]))
        // console.log("vars1",  web3.utils.hexToNumberString(vars[1]))
        // console.log("vars2",  web3.utils.hexToNumberString(vars[2]))
        assert(vars[0] == 1200, "Get value should work")
        assert(vars[1]> 0 , "timestamp works")
        assert(vars[2] == 200, "Get status should work")
    })

    it("Test getAnyDataBefore", async function(){
    	var d = new Date()/1000;
        var startDate = d - (d % 86400);     
        await helper.advanceTime(86400 * 2);
        for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         }
        let vars = await usingTellor.getAnyDataAfter.call(1,startDate);
        assert(vars[0] == true, "ifRetreive is not true")
        assert(vars[1] == 1200, "Get last value should work")
        assert(vars[2] > startDate, "retreive time as greater than startDate")
    })
        it("Test getAnyDataBefore -- most recent", async function(){
        var d = new Date()/1000;
        var startDate = d - (d % 86400);     
        await helper.advanceTime(86400 * 2);
        for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         }
        let vars = await usingTellor.getAnyDataAfter.call(1,startDate);
        assert(vars[0] == true, "ifRetreive is not true")
        assert(vars[1] == 1200, "Get last value should work")
        assert(vars[2] > startDate, "retreive time as greater than startDate")
        assert(0 == 1)
    })


    it("Test three getters with no values", async function(){
        let vars = await usingTellor.getAnyDataAfter.call(1,startDate);
        assert(0 == 1)//???
    })
    
    it("Test isInDispute in Tellor getter", async function(){
        let disp = await usingTellor.isInDispute(1,startDate);
        assert(disp == false)
    })

 });