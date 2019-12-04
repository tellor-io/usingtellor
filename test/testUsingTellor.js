/** 
* This tests the oracle functions as they are called through the
* TestContract(which is Optimistic and Optimistic is UsingTellor).
*/
const Web3 = require('web3');
const web3 = new Web3(new Web3.providers.WebsocketProvider('ws://localhost:8545'));
const BN = require('bn.js');  
const helper = require("./helpers/test_helpers");
const UserContract = artifacts.require("./UserContract.sol");
const UsingTellor = artifacts.require("./UsingTellor.sol");
const TellorMaster = artifacts.require("..testContracts/TellorMaster.sol");
const Tellor = artifacts.require("./Tellor.sol"); // globally injected artifacts helper
var masterAbi = TellorMaster.abi;
const oracleAbi = Tellor.abi;

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
  let userContract;
  let newOracle;

    beforeEach('Setup contract for each test', async function () {
        oracleBase = await Tellor.new()
        oracle = await TellorMaster.new(web3.utils.toChecksumAddress(oracleBase.address));
        master = await new web3.eth.Contract(masterAbi,oracle.address);
        oa = (web3.utils.toChecksumAddress(oracle.address))
        oracle2 = await new web3.eth.Contract(oracleAbi,oa);
        //intitial data request:
        await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api,"BTC/USD",1000,0).encodeABI()})
        var varsid = await oracle.getVariablesOnDeck()
        console.log("reqId", web3.utils.hexToNumberString(varsid[0]))

        userContract = await UserContract.new(oa);//deploy userContract
        //deploy user contract or your contract:
        usingTellor = await UsingTellor.new(userContract.address)
        //set the userContract on the testContract or your contract:
        await usingTellor.setUserContract(userContract.address);
        //This function gives Tellor tributes to acct 2--however this function does not 
        //exist in the production/mainnet Tellor contract, it's a shortcut to avoid the
        //mining functions for testing reads
        await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.theLazyCoon(accounts[2],web3.utils.toWei('10000', 'ether')).encodeABI()})
        newOracle = await Tellor.new();
        await web3.eth.sendTransaction({to: oracle.address,from:accounts[0],gas:4000000,data:master.methods.changeTellorContract(newOracle.address).encodeABI()})
        await userContract.setPrice(web3.utils.toWei("1","ether"))
    })

    // it("Test getCurrentValue", async function(){
    //     //No MINING
    //     //instead of mining, test submitminingsolution
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
    //      //console.log(i)
    //      }
    //     let vars = await usingTellor.getCurrentValue.call(1)
    //     assert(vars[0] == true, "ifRetreive is not true")
    //     assert(vars[1] == 1200, "Get last value should work")
    // })

    // it("Test getFirstVerifiedDataAfter", async function(){
    // 	var d = new Date()/1000;
    // 	console.log("d", d)
    //     var startDate = d - (d % 86400);     
    //     console.log('startDate',web3.utils.hexToNumberString(startDate));
    //     //No MINING
    //     //instead of mining, test submitminingsolution
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
    //      console.log(i)
    //      }
    //     await helper.advanceTime(86400 * 2);
    //     let vars = await usingTellor.getFirstVerifiedDataAfter.call(1,startDate);
    //     console.log("_timestampRetrieved", web3.utils.hexToNumberString(vars[2]))
    //     assert(vars[0] == true, "ifRetreive is not true")
    //     assert(vars[1] == 1200, "Get last value should work")
    //     assert(vars[2] > startDate, "retreive time as greater than startDate")
    // })

    // it("Test getAnyDataAfter", async function(){
    // 	var d = new Date()/1000;
    // 	console.log("d", d)
    //     var startDate = d - (d % 86400);     
    //     console.log('startDate',web3.utils.hexToNumberString(startDate));
    //     await helper.advanceTime(86400 * 2);
    //     //No MINING
    //     //instead of mining, test submitminingsolution
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
    //      console.log(i)
    //      }
    //     //await helper.advanceTime(86400 * 2);
    //     let vars = await usingTellor.getAnyDataAfter.call(1,startDate);
    //     console.log("_timestampRetrieved", web3.utils.hexToNumberString(vars[2]))
    //     assert(vars[0] == true, "ifRetreive is not true")
    //     assert(vars[1] == 1200, "Get last value should work")
    //     assert(vars[2] > startDate, "retreive time as greater than startDate")
    // })

    // it("Test getAnyDataAfter", async function(){
    // 	var d = new Date()/1000;
    // 	console.log("d", d)
    //     var startDate = d - (d % 86400);     
    //     console.log('startDate',web3.utils.hexToNumberString(startDate));
    //     await helper.advanceTime(86400 * 2);
    //     //No MINING
    //     //instead of mining, test submitminingsolution
    //     for(var i = 0;i <=4 ;i++){
    //       await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
    //      console.log(i)
    //      }
    //     //await helper.advanceTime(86400 * 2);
    //     let vars = await usingTellor.getAnyDataAfter.call(1,startDate);
    //     console.log("_timestampRetrieved", web3.utils.hexToNumberString(vars[2]))
    //     assert(vars[0] == true, "ifRetreive is not true")
    //     assert(vars[1] == 1200, "Get last value should work")
    //     assert(vars[2] > startDate, "retreive time as greater than startDate")
    // })

    it("Test requestData", async function(){
    	var d = new Date()/1000;
    	console.log("d", d)
        var startDate = d - (d % 86400);     
        console.log('startDate',web3.utils.hexToNumberString(startDate));
        await helper.advanceTime(86400 * 2);
        var tbalance = await oracle.balanceOf(accounts[2])
        console.log("tbalance", web3.utils.fromWei(tbalance, 'ether'))
        console.log('usingtellor', usingTellor.address)

        await web3.eth.sendTransaction({to:oa,from:accounts[2],gas:4000000,data:oracle2.methods.approve(usingTellor.address, web3.utils.toWei('5', 'ether')).encodeABI()})      
        
        await usingTellor.requestData(api2,"ETH-USD",1000,web3.utils.toWei('1', 'ether'),{from:accounts[2]});

        var tbalance1 = await oracle.balanceOf(accounts[2])
        console.log("tbalance1", web3.utils.fromWei(tbalance1, 'ether'))

        //No MINING
        //instead of mining, test submitminingsolution
        for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         console.log(i)
         }
        //await helper.advanceTime(86400 * 2);
        let vars = await usingTellor.getCurrentValue.call(1)
        console.log("_timestampRetrieved", web3.utils.hexToNumberString(vars[2]))
        assert(vars[0] == true, "ifRetreive is not true")
        assert(vars[1] == 1200, "Get last value should work")
    })

    it("Test requestDataWithEther", async function(){
    	var d = new Date()/1000;
    	console.log("d", d)
        var startDate = d - (d % 86400);     
        console.log('startDate',web3.utils.hexToNumberString(startDate));
        await helper.advanceTime(86400 * 2);
        var tbalance = await oracle.balanceOf(accounts[2])
        console.log("tbalance", web3.utils.fromWei(tbalance, 'ether'))
        await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.approve(usingTellor.address, web3.utils.toWei('10', 'ether')).encodeABI()})      
        await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.theLazyCoon(userContract.address,web3.utils.toWei('10000', 'ether')).encodeABI()})
  
        var bal1 = await web3.utils.fromWei(await web3.eth.getBalance(accounts[2]), 'ether');
        console.log("bal1",bal1)
        await usingTellor.requestDataWithEther(api2,"ETH-USD",1000,web3.utils.toWei("2","ether"),{from:accounts[2], value:web3.utils.toWei('2','ether')});
        var bal2 = await web3.utils.fromWei(await web3.eth.getBalance(accounts[2]), 'ether');
        console.log("bal2",bal2)
        var tbalance1 = await oracle.balanceOf(accounts[2])
        console.log("tbalance1", web3.utils.fromWei(tbalance1, 'ether'))
        
        //No MINING
        //instead of mining, test submitminingsolution
        for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         console.log(i)
         }
        //await helper.advanceTime(86400 * 2);
        let vars = await usingTellor.getCurrentValue.call(1)
        console.log("_timestampRetrieved", web3.utils.hexToNumberString(vars[2]))
        assert(vars[0] == true, "ifRetreive is not true")
        assert(vars[1] == 1200, "Get last value should work")
    })

    it("Test requestData", async function(){
    	var d = new Date()/1000;
    	console.log("d", d)
        var startDate = d - (d % 86400);     
        console.log('startDate',web3.utils.hexToNumberString(startDate));
        await helper.advanceTime(86400 * 2);
        var tbalance = await oracle.balanceOf(accounts[2])
        console.log("tbalance", web3.utils.fromWei(tbalance, 'ether'))
        console.log('usingtellor', usingTellor.address)

        await web3.eth.sendTransaction({to:oa,from:accounts[2],gas:4000000,data:oracle2.methods.approve(usingTellor.address, web3.utils.toWei('5', 'ether')).encodeABI()})      
        
        await usingTellor.addTip(1,web3.utils.toWei('1', 'ether'),{from:accounts[2]});

        var tbalance1 = await oracle.balanceOf(accounts[2])
        console.log("tbalance1", web3.utils.fromWei(tbalance1, 'ether'))

        //No MINING
        //instead of mining, test submitminingsolution
        for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         console.log(i)
         }
        //await helper.advanceTime(86400 * 2);
        let vars = await usingTellor.getCurrentValue.call(1)
        console.log("_timestampRetrieved", web3.utils.hexToNumberString(vars[2]))
        assert(vars[0] == true, "ifRetreive is not true")
        assert(vars[1] == 1200, "Get last value should work")
    })

    it("Test addTipWithEther", async function(){
    	var d = new Date()/1000;
    	console.log("d", d)
        var startDate = d - (d % 86400);     
        console.log('startDate',web3.utils.hexToNumberString(startDate));
        await helper.advanceTime(86400 * 2);

        var bal1 = await web3.utils.fromWei(await web3.eth.getBalance(accounts[2]), 'ether');
        console.log("bal1",bal1)


        await web3.eth.sendTransaction({to:oa,from:accounts[2],gas:4000000,data:oracle2.methods.approve(usingTellor.address, web3.utils.toWei('5', 'ether')).encodeABI()})      
        await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.theLazyCoon(userContract.address,web3.utils.toWei('10000', 'ether')).encodeABI()})
  

        await usingTellor.requestData(api2,"ETH-USD",1000,web3.utils.toWei('1', 'ether'),{from:accounts[2]});
        //RequestId, Totaltips, and API
        var vars1 = await oracle.getVariablesOnDeck()
        //var vars1 = await web3.eth.sendTransaction({to: oracle.address,from:accounts[0],gas:4000000,data:master.methods.getVariablesOnDeck().encodeABI()})
        console.log("reqId", web3.utils.hexToNumberString(vars1[0]))
        await usingTellor.requestData(api,"BTC/USD",1000,web3.utils.toWei('2', 'ether'),{from:accounts[2]});

        var vars2 = await oracle.getVariablesOnDeck()
        //var vars2 = await web3.eth.sendTransaction({to: oracle.address,from:accounts[0],gas:4000000,data:master.methods.getVariablesOnDeck().encodeABI()})
        console.log("reqId", web3.utils.hexToNumberString(vars2[0]))
        await usingTellor.addTipWithEther(1,{from:accounts[2], value:web3.utils.toWei('2','ether')});

        var bal2 = await web3.utils.fromWei(await web3.eth.getBalance(accounts[2]), 'ether');
        console.log("bal1",bal2)

        var vars3 = await oracle.getVariablesOnDeck()
        //var vars3 = await web3.eth.sendTransaction({to: oracle.address,from:accounts[0],gas:4000000,data:master.methods.getVariablesOnDeck().encodeABI()})
        console.log("reqId", web3.utils.hexToNumberString(vars3[0]))


        //No MINING
        //instead of mining, test submitminingsolution
        for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         console.log(i)
         }
        //await helper.advanceTime(86400 * 2);
        let vars = await usingTellor.getCurrentValue.call(1)
        console.log("_timestampRetrieved", web3.utils.hexToNumberString(vars[2]))
        assert(vars[0] == true, "ifRetreive is not true")
        assert(vars[1] == 1200, "Get last value should work")
    })


/*
addTip(uint256 _requestId, uint256 _tip)
addTipWithEther(uint256 _requestId)
setUserContract(address _userContract) 
transferOwnership(address payable _newOwner)*/


 });