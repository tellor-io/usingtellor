const { ethers } = require("hardhat");

const hash = ethers.utils.keccak256;
var assert = require('assert');

const takeFifteen = async () => {
await advanceTime(60 * 18);
};


advanceTime = async (time) =>{
  await network.provider.send("evm_increaseTime", [time])
  await network.provider.send("evm_mine")
}

  async function expectThrow(promise) {
    try {
      await promise;
    } catch (error) {
      const invalidOpcode = error.message.search("invalid opcode") >= 0;
      const outOfGas = error.message.search("out of gas") >= 0;
      const revert = error.message.search("revert") >= 0;
      assert(
        invalidOpcode || outOfGas || revert,
        "Expected throw, got '" + error + "' instead"
      );
      return;
    }
    assert.fail("Expected throw not received");
  }

  function to18(n) {
    return ethers.BigNumber.from(n).mul(ethers.BigNumber.from(10).pow(18))
  }

  function tob32(n){
    return ethers.utils.formatBytes32String(n)
  }

  function uintTob32(n){
    let vars = ethers.utils.hexlify(n)
    vars = vars.slice(2)
    while(vars.length < 64){
      vars = "0" + vars
    }
    vars = "0x" + vars
    return vars
  }

  function bytes(n){
    return ethers.utils.hexlify(n)
  }

  function getBlock(){
    return ethers.provider.getBlock()
  }

  function toWei(n){
    return ethers.utils.parseEther(n)
  }

  function fromWei(n){
    return ethers.utils.formatEther(n)
  }

module.exports = {
  timeTarget: 240,
  hash,
  zeroAddress:"0x0000000000000000000000000000000000000000",
  to18,
  uintTob32,
  tob32,
  bytes,
  getBlock,
  advanceTime,
  takeFifteen,
  toWei,
  fromWei,
  expectThrow,
};
