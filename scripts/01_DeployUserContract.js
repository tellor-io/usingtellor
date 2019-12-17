
/**
* @title Deploy User Contracts 
* @dev This allows Tellor deploy the community sale contract
*/

console.log("test")
// require('dotenv').config()

// const mnemonic = process.env.ETH_MNEMONIC;
// console.log("mnemonic", mnemonic)
// const accessToken = process.env.INFURA_ACCESS_TOKEN;
/*Imports*/
var UserContract = artifacts.require("UserContract");
var UsingTellor = artifacts.require("UsingTellor");

/*Helper functions*/
function sleep_s(secs) {
  secs = (+new Date) + secs * 1000;
  while ((+new Date) < secs);
}

const Web3 = require('web3')
var HDWalletProvider = require("@truffle/hdwallet-provider");
var web3 = new Web3(new HDWalletProvider('',"https://rinkeby.infura.io/v3/7f11ed6df93946658bf4c817620fbced"));
//var web3 = new Web3(new HDWalletProvider("","https://mainnet.infura.io/v3/bc3e399903ae407fa477aa0854a00cdc"));

/*notes for validating contract
//solc: 0.5.8+commit.23d335f2.Emscripten.clang
// truffle-flattener ./contracts/01_DeploySaleContract.sol > ./flat_files/01_DeploySaleContract.sol
// truffle exec scripts/01_DeployUserContract.js --network rinkeby

/*Variables*/
//rinkeby
tellorMaster = '0x724D1B69a7Ba352F11D73fDBdEB7fF869cB22E19';
console.log("tellorMaster", tellorMaster)
//mainnet
//tellorMaster = '0x0Ba45A8b5d5575935B8158a88C631E9F9C95a2e5';

console.log("start");
module.exports =async function(callback) {
    let userContract;
   console.log("1")
    
    // tm = (web3.utils.toChecksumAddress(tellorMaster));
    // console.log("tm", tm);
    userContract = await UserContract.new(tellorMaster);
    
    console.log("userContract address:", userContract.address);

    //set price 
    //deploy oracleiddescription
    //make up a description

process.exit()
}
