/****Uncomment the body below to run this with Truffle migrate for truffle testing*/
var TellorTransfer = artifacts.require("./libraries/TellorTransfer.sol");
var TellorLibrary = artifacts.require("./libraries/TellorLibrary.sol");
var TellorDispute = artifacts.require("./libraries/TellorDispute.sol");
var TellorGettersLibrary = artifacts.require("./libraries/TellorGettersLibrary.sol");
var Tellor = artifacts.require("./Tellor.sol");
var TellorMaster = artifacts.require("./TellorMaster.sol");
/****Uncomment the body to run this with Truffle migrate for truffle testing*/

/**
*@dev Use this for setting up contracts for testing 
*/
function sleep_s(secs) {
  secs = (+new Date) + secs * 1000;
  while ((+new Date) < secs);
}
/****Uncomment the body below to run this with Truffle migrate for truffle testing*/
module.exports = async function (deployer) {

  // deploy transfer
  await deployer.deploy(TellorTransfer);
  //sleep_s(30);

  // deploy getters lib
  await deployer.deploy(TellorGettersLibrary);
  //sleep_s(30);

  // deploy dispute
  await deployer.link(TellorTransfer,TellorDispute);
  await deployer.deploy(TellorDispute);
  //sleep_s(30);

  // deploy lib
  await deployer.link(TellorDispute, TellorLibrary);
  await deployer.link(TellorTransfer, TellorLibrary);
  await deployer.deploy(TellorLibrary);
  //sleep_s(60);

  // deploy tellor
    await deployer.link(TellorDispute, Tellor);
  await deployer.link(TellorTransfer,Tellor);
  await deployer.link(TellorLibrary,Tellor);
  await deployer.deploy(Tellor);
  //sleep_s(60);

  // deploy tellor master
  await deployer.link(TellorTransfer,TellorMaster);
  await deployer.link(TellorGettersLibrary,TellorMaster);
  await deployer.deploy(Tellor).then(async function() {
    await deployer.deploy(TellorMaster, Tellor.address)
  });

};
