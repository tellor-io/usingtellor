const Web3 = require('web3');
const web3 = new Web3(new Web3.providers.WebsocketProvider('ws://localhost:8545'));
const Mappings = artifacts.require("./OracleIDDescriptions");
var bytes = "0x0d7effefdb084dfeb1621348c8c70cc4e871eba4000000000000000000000000";

contract('Mapping Tests', function(accounts) {
    let mappings;
    beforeEach('Setup contract for each test', async function () {
        mappings = await Mappings.new();
    });
    it("Test all functions", async function(){
    	await mappings.defineTellorCodeToStatusCode(1,200);
    	assert(await mappings.getTellorStatusFromStatus(200) == 1, "getting Tellor Status should work")
    	assert(await mappings.getStatusFromTellorStatus(1) == 200, "getting Status should work")
    	await mappings.defineTellorIdToBytesID(1,bytes);
    	assert(await mappings.getTellorIdFromBytes(bytes) == 1, "getting TellorID should work")
    	assert(await mappings.getBytesFromTellorID(1) == bytes, "getting bytes should work")
    });
});