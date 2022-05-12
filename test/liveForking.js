const { AbiCoder } = require("@ethersproject/abi");
const { expect } = require("chai");
const h = require("./helpers/helpers");
var assert = require("assert");
const web3 = require("web3");
const fetch = require("node-fetch");
const { ethers } = require("hardhat");

describe("usingTellor Function Tests", function () {
  const tellorOracleAddress = "0xe8218cACb0a5421BC6409e498d9f8CC8869945ea";
  const tellorMaster = "0x88dF592F8eb5D7Bd38bFeF7dEb0fBc02cf3778a0";

  const DEV_WALLET = "0x39E419bA25196794B595B2a595Ea8E527ddC9856";
  const BIGWALLET = "0xf977814e90da44bfa03b6295a0616a897441acec";
  const abiCoder = new ethers.utils.AbiCoder();
  let queryId;
  let valuesEncoded;
  let queryDataArgs;
  let queryData;
  let run = 0;
  let mainnetBlock = 0;
  let devWallet;
  let bigWallet;

  beforeEach("deploy and setup", async function () {
    if (run == 0) {
      const directors = await fetch(
        "https://api.blockcypher.com/v1/eth/main"
      ).then((response) => response.json());
      mainnetBlock = directors.height - 20;
      console.log("     Forking from block: ", mainnetBlock);
      run = 1;
    }
    [owner, addr1, addr2] = await ethers.getSigners();
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: hre.config.networks.hardhat.forking.url,
            blockNumber: mainnetBlock,
          },
        },
      ],
    });
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [DEV_WALLET],
    });
    await hre.network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [BIGWALLET],
    });
    bigWallet = await ethers.provider.getSigner(BIGWALLET);
    devWallet = await ethers.provider.getSigner(DEV_WALLET);

    oracle = await ethers.getContractAt(
      "ITellor",
      tellorOracleAddress,
      devWallet
    );

    UsingTellor = await ethers.getContractFactory("UsingTellor");
    usingTellor = await UsingTellor.deploy(tellorOracleAddress);
    await usingTellor.deployed();

    await addr1.sendTransaction({
      to: DEV_WALLET,
      value: ethers.utils.parseEther("1.0"),
    });

    valuesEncoded = abiCoder.encode(["bool"], [true]);
    queryDataArgs = abiCoder.encode(["string"], ["1"]);
    queryData = abiCoder.encode(
      ["string", "bytes"],
      ["Snapshot", queryDataArgs]
    );
    queryId = ethers.utils.keccak256(queryData);
  });

  it("retrieveData()", async function () {
    tellorM = await ethers.getContractAt("ITellor", tellorMaster, addr1);
    await tellorM.depositStake();
    // await oracle.submitValue(queryId, valuesEncoded, 0, queryData);
    // blocky = await h.getBlock();
    // const using = await usingTellor.retrieveData(queryId, blocky.timestamp);
  });

  // it("getNewValueCountbyQueryId", async function () {
  //   const using = await usingTellor.getNewValueCountbyQueryId(queryId);

  // });

  // it("getTimestampbyQueryIdandIndex()", async function () {
  //   const using = await usingTellor.getTimestampbyQueryIdandIndex(queryId, 0);
  //   console.log("using: ", using);
  // });

  // it("getCurrentValue()", async function () {
  //   const using = await usingTellor.getCurrentValue(queryId);

  //   console.log("using: ", using);
  // });

  // it("getIndexForDataBefore()", async function () {
  //   blocky = await h.getBlock();

  //   const using = await usingTellor.getIndexForDataBefore(
  //     queryId,
  //     blocky.timestamp
  //   );
  //   console.log("using: ", using);
  // });

  // it("getDataBefore()", async function () {
  //   blocky = await h.getBlock();

  //   using = await usingTellor.getDataBefore(queryId, blocky.timestamp);
  //   console.log("using: ", using);
  // });

  // it("isInDispute()", async function () {
  //   blocky = await h.getBlock();

  //   await usingTellor.isInDispute(queryId, blocky.timestamp);
  // });

  it("tellor()", async function () {
    expect(await usingTellor.tellor()).to.equal(tellorOracleAddress);
  });
});
