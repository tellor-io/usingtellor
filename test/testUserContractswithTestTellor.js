/** 
* This tests the oracle functions, including mining.
*/
const Web3 = require('web3');
const web3 = new Web3(new Web3.providers.WebsocketProvider('ws://localhost:8545'));
const BN = require('bn.js');  
const helper = require("./helpers/test_helpers");
const UserContract = artifacts.require("./UserContract.sol");
const TestContract = artifacts.require("..testContracts/TestContract.sol");
const TellorMaster = artifacts.require("..testContracts/TellorMaster.sol");
const Tellor = artifacts.require("./Tellor.sol"); // globally injected artifacts helper
//var OldTellor = artifacts.require("./oldContracts/OldTellor.sol")
var masterAbi = TellorMaster.abi;
const oracleAbi = Tellor.abi;

var api = "json(https://api.gdax.com/products/BTC-USD/ticker).price";
var api3 = "json(https://api.gdax.com/products/ETH-BTC/ticker).price";
var api2 = "json(https://api.gdax.com/products/ETH-USD/ticker).price";

function promisifyLogWatch(_address,_event) {
  return new Promise((resolve, reject) => {
    web3.eth.subscribe('logs', {
      address: _address,
      topics: [web3.utils.sha3(_event)]
    }, (error, result) => {
        if (error){
          console.log('Error',error);
          reject(error);
        }
        else{
       	resolve(result);
    	}
    })
  });
}

contract('UserContract Tests', function(accounts) {
  let oracle;
  let oracle2;
  let logMineWatcher;
  let testContract;
  let oa;
  let master;
  let userContract;
  let newOracle;

    beforeEach('Setup contract for each test', async function () {
        //oracleBase = await OldTellor.new();
        oracleBase = await Tellor.new();
        oracle = await TellorMaster.new(web3.utils.toChecksumAddress(oracleBase.address));
        master = await new web3.eth.Contract(masterAbi,oracle.address);
        oa = (web3.utils.toChecksumAddress(oracle.address))
        oracle2 = await new web3.eth.Contract(oracleAbi,oa);///will this instance work for logWatch? hopefully...
        //intitial data request:
        await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api,"BTC/USD",1000,0).encodeABI()})
        userContract = await UserContract.new(oa);//deploy userContract
        //deploy user contract or your contract:
        testContract = await TestContract.new(userContract.address,10,86400*3,[1],86400)
        //set the userContract on the testContract or your contract:
        await testContract.setUserContract(userContract.address);
        //This function gives Tellor tributes to acct 2--however this function does not 
        //exist in the production/mainnet Tellor contract, it's a shortcut to avoid the
        //mining functions for testing reads
        await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.theLazyCoon(accounts[2],web3.utils.toWei('5000', 'ether')).encodeABI()})
        newOracle = await Tellor.new();
        await web3.eth.sendTransaction({to: oracle.address,from:accounts[0],gas:4000000,data:master.methods.changeTellorContract(newOracle.address).encodeABI()})
    });

    it("Test Base Derivative Contract - Optimistic Up Move", async function(){
      await testContract.setContractDetails(7 * 86400)
      var startTime = await testContract.startDateTime.call()
      assert(startTime > 0, "Start time should be positive")
      assert(startTime == await testContract.endDateTime.call() - 86400*7,"end daSte should be in a week")
      await testContract.setValue(startTime, 1000);
      assert(await testContract.getMyValuesByTimestamp(startTime) == 1000, "Start time should have the correct value");
      assert(await testContract.getIsValue(startTime) == true, "get Is Value should be true");
      await helper.advanceTime(86400 * 110);
      await testContract.setValue(await testContract.endDateTime.call(), 2000);
      await testContract.settleContracts();
      assert(testContract.getIsValue(await testContract.endDateTime.call()),"endTime should have a value");
      assert(await testContract.getMyValuesByTimestamp(await testContract.endDateTime.call()) == 2000, "End date should have correct value");
      assert(await testContract.startValue.call() > 0, "Start Value should be positive");
      assert(await testContract.endValue.call() > 0, "End Value should be positive")
      assert(await testContract.longWins.call(), "Long should win");
      assert(await testContract.contractEnded.call(), "the contract should be ended")
      let vars = await testContract.getFirstUndisputedValueAfter(startTime*1 + 1);
      assert(vars[1] == 2000, "Get last value should work");
    })


    it("Test Base Derivative Contract - Optimistic Down Move", async function(){
      await testContract.setContractDetails(7 * 86400)
      var startTime = await testContract.startDateTime.call();
      await testContract.setValue(startTime, 1000);
      await helper.advanceTime(86400 * 11);
      await testContract.setValue(await testContract.endDateTime.call(), 500);

      await testContract.settleContracts();
      assert(await testContract.longWins.call() == false, "long should not win")
      assert(await testContract.contractEnded.call(), "Contract should be ended")
      let vars = await testContract.getTimestamps()
      assert(vars[0] * 1 == startTime * 1 , "Start time should be correct");
      assert(await testContract.getCurrentValue() == 500, "endValue should be currentValue")
    })
    it("Test Ownership Transfer", async function(){
      assert(await testContract.owner.call() == accounts[0]);
      await testContract.transferOwnership(accounts[1]);
      assert(await testContract.owner.call() == accounts[1]);
      assert(await userContract.owner.call() == accounts[0])
      await userContract.transferOwnership(accounts[1]);
      assert(await userContract.owner.call() == accounts[1]);
    })

    it("Test Base Derivative Contract - Disputed Up Move", async function(){
      await testContract.setContractDetails(7 * 86400)
      var startTime = await testContract.startDateTime.call();
      var endTime = await testContract.endDateTime.call();
      await testContract.setValue(startTime, 1000);
      await helper.advanceTime(86400 * 10);
      await testContract.setValue(await testContract.endDateTime.call(), 500);
      let vars = await testContract.getTimestamps()
      assert(vars[0] - startTime == 0, "getTimestamps should work");
      assert(vars[1] - endTime == 0, "getTimestamps should work");
      assert(await testContract.disputeFee.call() == 10);
      assert(await testContract.disputePeriod.call() == 86400*3, "dispute Period should be correct");
      assert(await testContract.granularity.call() == 86400);
      //No MINING
      //instead of mining, test submitminingsolution
    for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         console.log(i)
         }
      let mydata = oracle2.methods.approve(testContract.address,10).encodeABI()
      let x = await web3.eth.sendTransaction({to:oa,from:accounts[2],gas:4000000,data:mydata})
      assert(await oracle.getNewValueCountbyRequestId(1) == 1, "should have a newValue count")
      await testContract.disputeOptimisticValue(endTime,{from:accounts[2],value:10})
      await helper.advanceTime(86400 * 10);
      await testContract.getTellorValues(endTime);
      vars = await testContract.getFirstUndisputedValueAfter(startTime*1 + 1);
      await testContract.settleContracts();
      assert(await testContract.longWins.call(),"Long should Win")
      assert(await testContract.contractEnded.call(), "Contract should be ended")
    });

     it("Test Base Derivative Contract - Disputed Down Move", async function(){
      await testContract.setContractDetails(7 * 86400)
      let startTime = await testContract.startDateTime.call();
      var endTime = await testContract.endDateTime.call();
      await testContract.setValue(startTime, 50000000);
      await helper.advanceTime(86400 * 10);
      await testContract.setValue(await testContract.endDateTime.call(), 500);

      //launch and mine one on Tellor
      //set up the contracts to handle getting the value

      for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         console.log(i)
         }

      res = await testContract.getAnyDataAfter(1,startTime*1 + 1)
      console.log("new price", res[1])

      await web3.eth.sendTransaction({to: oa,from:accounts[2],gas:4000000,data:oracle2.methods.approve(testContract.address,10).encodeABI()})
      await testContract.disputeOptimisticValue(endTime,{from:accounts[2],value:10})
      assert(await testContract.isDisputed((await testContract.endDateTime.call()) * 1) == true, "isDisputed should work");
      await helper.advanceTime(86400 * 10);
      await testContract.getTellorValues(await testContract.endDateTime.call());
      await testContract.settleContracts();
      assert(await testContract.longWins.call() == false)
      assert(await testContract.contractEnded.call(), "Contract should be ended")
      
      var mynum = await testContract.getAnyDataAfter.call(1,startTime*1 + 1) 
      console.log("mynum", web3.utils.hexToNumberString(mynum[1]))
      assert(web3.utils.hexToNumberString(mynum[1]) == 1200, "get any data should work");
      assert(await testContract.getNumberOfDisputedValues() == 1);
      assert(await testContract.getDisputedValueByIndex(0) - await testContract.endDateTime.call() == 0, "Disputed value should be endtime");
      mynum = await testContract.getDisputedValues()
      assert(web3.utils.hexToNumberString(mynum[0]) - await testContract.endDateTime.call() == 0, "getDisputedValues should work")
    });

    it("Test Disputed Start and End Timestamps and someone wins", async function(){
      await testContract.setContractDetails(7 * 86400)
      console.log(1)
      var startTime = await testContract.startDateTime.call();
      console.log("startime", web3.utils.hexToNumberString(startTime))
      await testContract.setValue(startTime, 500000000);
      console.log(3)
      await web3.eth.sendTransaction({to: oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api,"BTC/USD",1000,0).encodeABI()})
console.log(4)
      await web3.eth.sendTransaction({to:oa,from:accounts[2],gas:4000000,data:oracle2.methods.approve(testContract.address,10).encodeABI()})
  console.log(5) 
      await testContract.disputeOptimisticValue(startTime,{from:accounts[2],value:10})
      await testContract.getTellorValues(startTime);
      await helper.advanceTime(86400 * 10);
      await testContract.setValue(await testContract.endDateTime.call(), 500);
      endDate= await testContract.endDateTime.call()
      console.log(web3.utils.hexToNumberString(endDate))
      //launch and mine one on Tellor
      //set up the contracts to handle getting the value
      await web3.eth.sendTransaction({to: oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api,"BTC/USD",1000,0).encodeABI()})
      
      for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 1200).encodeABI()})
         }

      await web3.eth.sendTransaction({to: oa,from:accounts[2],gas:4000000,data:oracle2.methods.approve(testContract.address,10).encodeABI()})
      var myend = 1* (await testContract.endDateTime.call());
      await testContract.disputeOptimisticValue(web3.utils.hexToNumberString(myend),{from:accounts[2],value:10})
      await helper.advanceTime(86400 * 10);
      await testContract.getTellorValues(await testContract.endDateTime.call());
      await testContract.settleContracts();
      assert(await testContract.longWins.call() == false, "long should not win")
      assert(await testContract.contractEnded.call(), "Contract should be ended")
      var mynum = await testContract.getAnyDataAfter.call(1,startTime*1 + 86400*9)
      assert(web3.utils.hexToNumberString(mynum[1]) == 1200,"getAnyDataAfter should work");
      assert(await testContract.getNumberOfDisputedValues() == 2, "there should be two disputed value");
      assert(await testContract.isDisputed(web3.utils.hexToNumberString(myend)) == true, "value should be disputed");
      assert(await testContract.getDisputedValueByIndex(1) == 1 * (await testContract.endDateTime.call()), "getDisputedValueByIndex should work");
      mynum = await testContract.getDisputedValues();
      console.log("mynum disputed values", web3.utils.hexToNumberString(mynum[0]))
      console.log("mynum disputed values", web3.utils.hexToNumberString(mynum[1]))
      assert(web3.utils.hexToNumberString(mynum[0]) - startTime == 0, "disputed value timestamp")
      assert(web3.utils.hexToNumberString(mynum[1]) - myend == 0, "disputed value timestamp")
    })

    it("Test No Tributes in User Contract w/Solution", async function(){
      await testContract.setContractDetails(7 * 86400)
      var startTime = await testContract.startDateTime.call();
      await testContract.setValue(startTime, 1000);
      await helper.advanceTime(86400 * 10);
      await testContract.setValue(await testContract.endDateTime.call(), 2000);

      //launch and mine one on Tellor
      //set up the contracts to handle getting the value
  
      await web3.eth.sendTransaction({to:oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api,"BTC/USD",1000,0).encodeABI()})
      await web3.eth.sendTransaction({to:oa,from:accounts[2],gas:4000000,data:oracle2.methods.approve(testContract.address,10).encodeABI()})
      await testContract.disputeOptimisticValue(await testContract.endDateTime.call(),{from:accounts[2],value:10})
      await userContract.setPrice(web3.utils.toWei("1","ether"));
      assert(await userContract.tributePrice.call() == web3.utils.toWei("1","ether"), "Tribute Price should be correct");
      
      await web3.eth.sendTransaction({to: oa,from:accounts[2],gas:4000000,data:oracle2.methods.transfer(userContract.address,web3.utils.toWei("1","ether")).encodeABI()})
      await testContract.addTipWithEther(1,{value:web3.utils.toWei("1","ether"),from:accounts[3]})
      
      for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 3000).encodeABI()})
         
         }

      await helper.advanceTime(86400 * 8);
      await testContract.getTellorValues(await testContract.endDateTime.call());
      await testContract.settleContracts();
      await testContract.setContractDetails(7 * 86400)
      assert(await testContract.longWins.call() == true, "long should win")
      assert(await testContract.contractEnded.call(), "contract should be ended")
      var bal1 = await web3.utils.fromWei(await web3.eth.getBalance(accounts[0]), 'ether');
      await userContract.withdrawEther();
      var bal2 = await web3.utils.fromWei(await web3.eth.getBalance(accounts[0]), 'ether');
      assert(bal2 - bal1 -1 < .01, "balance should change correctly");

    })

    it("Lots of Stuff", async function(){
      for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 2000).encodeABI()})
         }
      await userContract.setPrice(web3.utils.toWei("1","ether"));
       await web3.eth.sendTransaction({to: oa,from:accounts[2],gas:4000000,data:oracle2.methods.transfer(userContract.address,web3.utils.toWei("1","ether")).encodeABI()})
      await userContract.requestDataWithEther(api2,"ETH-USD",1000,web3.utils.toWei("1","ether"),{from:accounts[1], value:web3.utils.toWei('1','ether')});
      for(var j = 0;j <=4 ;j++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[j],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",2, 3000).encodeABI()})
         }
      await web3.eth.sendTransaction({to: oa,from:accounts[2],gas:4000000,data:oracle2.methods.transfer(userContract.address,web3.utils.toWei("5","ether")).encodeABI()})
      await userContract.addTipWithEther(1,{value:web3.utils.toWei("5","ether"),from:accounts[2]});
      await web3.eth.sendTransaction({to: oa,from:accounts[1],gas:4000000,data:oracle2.methods.approve(testContract.address,web3.utils.toWei("5","ether")).encodeABI()})
      await testContract.addTip(2,web3.utils.toWei("5","ether"),{from:accounts[1]});
      vars = await oracle.getVariablesOnDeck();
      let apiOnQ = web3.utils.hexToNumberString(vars['0']);
      assert(apiOnQ == 2,"ApiID on Q should be 2");
      await testContract.requestData(api2,"ETH-USD",1000,0);
    })


    it("Test 3 request ID avearge for Optimistic disputed Value", async function(){
      testContract = await TestContract.new(userContract.address,10,86400*3,[1,2,3],86400)
      console.log(1)
      await testContract.setUserContract(userContract.address);
      console.log(2)
      await testContract.setContractDetails(7 * 86400)
      console.log(3)
      var startTime = await testContract.startDateTime.call();
      console.log(4)
      var endTime = await testContract.endDateTime.call();
      console.log(5)
      await testContract.setValue(startTime, 1000);
      console.log(6)
      await helper.advanceTime(86400 * 10);
      console.log(7)
      await testContract.setValue(await testContract.endDateTime.call(), 500);
      console.log(8)

      for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",1, 2000).encodeABI()})
         console.log(i)
         }
      console.log(9)
      await web3.eth.sendTransaction({to: oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api2,"BTC/USD2",100,0).encodeABI()})
      console.log(10)
      for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",2, 2000).encodeABI()})
         console.log(i)
         }
         console.log(11)
      await web3.eth.sendTransaction({to: oa,from:accounts[0],gas:4000000,data:oracle2.methods.requestData(api3,"BTC/USD3",1000000,1).encodeABI()})
       console.log(12)
      for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",3, 2000).encodeABI()})
         console.log(i)
         }
console.log(13)
      await web3.eth.sendTransaction({to: oa,from:accounts[2],gas:4000000,data:oracle2.methods.requestData(api3,"BTC/USD3",1000000,10).encodeABI()})
      console.log(14)
      for(var i = 0;i <=4 ;i++){
          await web3.eth.sendTransaction({to: oracle.address,from:accounts[i],gas:4000000,data:oracle2.methods.submitMiningSolution("nonce",3, 2000).encodeABI()})
         console.log(i)
         }
      console.log(15)
      await web3.eth.sendTransaction({to: oa,from:accounts[2],gas:4000000,data:oracle2.methods.approve(testContract.address,10).encodeABI()})
      assert(await oracle.getNewValueCountbyRequestId(3) == 2, "new value count should be correct")
      await testContract.disputeOptimisticValue(endTime,{from:accounts[2],value:10})
      await helper.advanceTime(86400 * 10);
      await testContract.getTellorValues(await testContract.endDateTime.call());
      await testContract.settleContracts();
      assert(await testContract.longWins.call(), "Long should win")
      assert(await testContract.contractEnded.call(), "Contract should be ended")
      var rIds = await testContract.getRequestIds();
      assert(rIds['0'] == 1, "getRequestIds should work")
      assert(rIds['1'] == 2)
      assert(rIds['2'] == 3)
      let vars= await testContract.getTimestamps();
      assert(await testContract.getNumberOfValuesPerTimestamp(vars[vars.length -1]*1) == 3, "number of values per timestamp should work");
      rIds = await testContract.getRequestIdsIncluded(vars[vars.length -1]*1);
      assert(rIds['0'] == 1, "included Id's should be correct")
      assert(rIds['1'] == 2)
      assert(rIds['2'] == 3)
      console.log(await testContract.endValue.call() ,res[1] )
      assert(await testContract.endValue.call() > res[1] * 1, 'value should be an average')
       });

});