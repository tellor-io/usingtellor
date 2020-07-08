/**
* This tests the oracle functions as they are called through usingTellor
*/
const Web3 = require('web3');
const web3 = new Web3(new Web3.providers.WebsocketProvider('ws://localhost:8545'));
const UsingTellor = artifacts.require("./UsingTellor.sol");
const TellorMaster = artifacts.require("..testContracts/TellorMaster.sol");
const Tellor = artifacts.require("./Tellor.sol");
var masterAbi = TellorMaster.abi;
const oracleAbi = Tellor.abi;
const Mappings = artifacts.require("./OracleIDDescriptions");
var bytes = "0xdfaa6f747f0f012e8f2069d6ecacff25f5cdf0258702051747439949737fc0b5";
var api = "json(https://api.gdax.com/products/BTC-USD/ticker).price";
var d = new Date()/1000;
var startDate = Math.round(d + 86400);

advanceTime = (time) => {
    return new Promise((resolve, reject) => {
        web3.currentProvider.send({
            jsonrpc: "2.0",
            method: "evm_increaseTime",
            params: [time],
            id: new Date().getTime()
        }, (err, result) => {
            if (err) { return reject(err); }
            return resolve(result);
        });
    });
}

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

    // it("Test add a lot of data to retreive old values wrong loop", async function(){
    //     for(var i = 0;i <=10 ;i++){
    //         for (var j = 1; j<=10 ; j ++)
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[0],gas:4000000,data:oracle2.methods.testAddData(1,j).encodeABI()})
    //      }
    //     let vars = await usingTellor.getDataBefore.call(1,20,1,0)
    //     assert(vars[0] == true)
    //     vars = await usingTellor.getCurrentValue.call(1)
    //     assert(vars[0] == true, "ifRetreive is not true")
    // })

    it("Test add a lot of data to retreive old values", async function(){

        for (var j = 0; j<10000 ; j+=10){
            await web3.eth.sendTransaction({to: oracle.address,from:accounts[0],gas:4000000,data:oracle2.methods.testAddData(1,j).encodeABI()})
            if (j%100==0){
                console.log(j) 
            }
        }
    
        console.log(await oracle.getNewValueCountbyRequestId(1))
        let vars = await usingTellor.getDataBefore.call(1,100,200,200)
        console.log("1",vars)
        assert(vars[0] == false,"should be able to getData")
        vars = await usingTellor.getDataBefore.call(1,100,100,9950)
        console.log("2",vars)
        assert(vars[0] == true,"should be able to getData2")
        vars = await usingTellor.getCurrentValue.call(1)
        assert(vars[0] == true, "ifRetreive is not true")

    })

    // it("Test getCurrentValue", async function(){
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
    //      }
    //     let vars = await usingTellor.getCurrentValue.call(1)
    //     assert(vars[0] == true, "ifRetreive is not true")
    //     assert(vars[1] == 1200, "Get last value should work")
    // })
    // it("Test valueFor", async function(){
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
    //     }
    //     let _id = web3.utils.keccak256(api, 1000)
    //     let vars = await usingTellor.valueFor(bytes)
    //     assert(vars[0] == 1200, "Get value should work")
    //     assert(vars[1]> 0 , "timestamp works")
    //     assert(vars[2] == 200, "Get status should work")
    // })
    // it("Test getDataBefore", async function(){
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
    //      }
    //     let vars = await usingTellor.getDataBefore.call(1,startDate,1,0)
    //     assert(vars[0] == true, "ifRetreive is not true")
    //     assert(vars[1] == 1200, "Get last value should work")
    // })
    // it("Test -- most recent", async function(){
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 120).encodeABI()})
    //     }
    //     await advanceTime(1000)
    //     await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api,"BTC/USD",1000,0).encodeABI()})
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
    //     }
    //     let vars = await usingTellor.getDataBefore.call(1,startDate,1,0)
    //     assert(vars[0] == true, "ifRetreive is not true")
    //     assert(vars[1] == 1200, "Get last value should work")
    //     vars = await usingTellor.getCurrentValue.call(1);
    //     assert(vars[0] == true, "ifRetreive is not true (cv)")
    //     assert(vars[1] == 1200, "Get last value should work (cv)")
    // })
    // it("Test three getters with no values", async function(){
    //     let vars = await usingTellor.getDataBefore.call(1,startDate,1,0)
    //     assert(vars[0] == false, "ifRetreive is not true")
    //     assert(vars[1] == 0, "Get last value should work")
    //     assert(vars[2] == 0, "timestamp should be 0")
    //     vars = await usingTellor.getCurrentValue.call(1)
    //     assert(vars[0] == false, "ifRetreive is not true")
    //     assert(vars[1] == 0, "Get last value should work")
    //     vars = await usingTellor.valueFor(bytes)
    //     assert(vars[0] == 0, "Get value should work")
    //     assert(vars[1] == 0 , "timestamp works")
    //     assert(vars[2] == 404, "Get status should work")
    // })
    // it("Test isInDispute in Tellor getter", async function(){
    //     for (var j = 0; j<100 ; j+=10){
    //         await web3.eth.sendTransaction({to: oracle.address,from:accounts[0],gas:4000000,data:oracle2.methods.testAddData(1,j).encodeABI()})
    //     }
    //     let vars = await usingTellor.getCurrentValue.call(1)
    //     await web3.eth.sendTransaction({to: oracle.address,from:accounts[0],gas:4000000,data:oracle2.methods.beginDispute(1,vars[2]-0,2).encodeABI()})
    //     vars = await usingTellor.getDataBefore.call(1,80,2,1)
    //     assert(vars[0] == false)
    //     vars = await usingTellor.getDataBefore.call(1,80,2,9)
    //     assert(vars[0] == false)
    //     vars = await usingTellor.getDataBefore.call(1,80,20,30)
    //     assert(vars[0] == true, "ifRetreive is not true")
    //     assert(vars[1] == 80, "Get last value should work")
    // })
    // it("Test isInDispute in Tellor getter non 2 index", async function(){
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 120).encodeABI()})
    //     }
    //     await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api,"BTC/USD",1000,0).encodeABI()})
    //     await advanceTime(1000)
    //     for(var i = 0;i <=4 ;i++){
    //       res = await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
    //     }
    //     let vars2 = await usingTellor.getCurrentValue.call(1)
    //     await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.beginDispute(1,vars2[2]-0,0).encodeABI()})
    //     let vars = await usingTellor.getCurrentValue.call(1)
    //     assert(vars[0] == true, "ifRetreive is not true")
    //     assert(vars[1] == 1200, "Get last value should work")
    // })
 });
