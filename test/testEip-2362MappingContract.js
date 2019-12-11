const Web3 = require('web3');
const web3 = new Web3(new Web3.providers.WebsocketProvider('ws://localhost:8545'));
const BN = require('bn.js');  
const helper = require("./helpers/test_helpers");
const Mappings = artifacts.require("./OracleIDDescriptions");

var api = "json(https://api.gdax.com/products/BTC-USD/ticker).price";

contract('UsingTellor Tests', function(accounts) {
    let mappings;


    beforeEach('Setup contract for each test', async function () {
        mappings = await Mappings.new();
    })

    it("Test defineBytes32ID", async function(){
        let vars = await mappings.defineBytes32ID(api, 1000);
        console.log(vars);
    })
});