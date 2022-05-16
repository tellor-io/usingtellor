const { AbiCoder } = require("@ethersproject/abi");
const { expect } = require("chai");
const h = require("./helpers/helpers");
var assert = require("assert");
const web3 = require("web3");
const fetch = require("node-fetch");
const { ethers } = require("hardhat");
const { tob32 } = require("./helpers/helpers");

describe("usingTellor Mainnet Forking Tests", function () {
  const tellorOracleAddress = "0xe8218cACb0a5421BC6409e498d9f8CC8869945ea";
  const tellorMaster = "0x88dF592F8eb5D7Bd38bFeF7dEb0fBc02cf3778a0";
  const DEV_WALLET = "0x39E419bA25196794B595B2a595Ea8E527ddC9856";
  const BIGWALLET = "0xf977814e90da44bfa03b6295a0616a897441acec";
  const governanceAddress = "0x51d4088d4EeE00Ae4c55f46E0673e9997121DB00";

  const abiCoder = new ethers.utils.AbiCoder();
  let queryId;
  let queryDataArgs;
  let queryData;
  let run = 0;
  let mainnetBlock = 0;
  let devWallet;

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

    await owner.sendTransaction({
      to: DEV_WALLET,
      value: ethers.utils.parseEther("5.0"),
    });

    bigWallet = await ethers.provider.getSigner(BIGWALLET);
    devWallet = await ethers.provider.getSigner(DEV_WALLET);

    UsingTellor = await ethers.getContractFactory("UsingTellor");
    usingTellor = await UsingTellor.deploy(tellorOracleAddress);
    await usingTellor.deployed();

    trueEncoded = abiCoder.encode(["bool"], [true]);
    falseEncoded = abiCoder.encode(["bool"], [false]);

    queryDataArgs = abiCoder.encode(["string"], ["1"]);
    queryData = abiCoder.encode(
      ["string", "bytes"],
      ["Snapshot", queryDataArgs]
    );
    queryId = ethers.utils.keccak256(queryData);

    tellorM = await ethers.getContractAt("ITellor", tellorMaster, devWallet);
    governance = await ethers.getContractAt(
      "ITellor",
      governanceAddress,
      devWallet
    );

    await tellorM.depositStake();

    oracle = await ethers.getContractAt(
      "ITellor",
      tellorOracleAddress,
      devWallet
    );
  });

  it("retrieveData()", async function () {
    await oracle.submitValue(queryId, falseEncoded, 0, queryData);
    blocky1 = await h.getBlock();
    await h.advanceTime(100000);
    await oracle.submitValue(queryId, trueEncoded, 1, queryData);
    blocky2 = await h.getBlock();
    expect(await usingTellor.retrieveData(queryId, blocky1.timestamp)).to.equal(
      h.uintTob32(0)
    );
    expect(await usingTellor.retrieveData(queryId, blocky2.timestamp)).to.equal(
      h.uintTob32(1)
    );
  });

  it("getNewValueCountbyQueryId", async function () {
    await oracle.submitValue(queryId, falseEncoded, 0, queryData);
    expect(await usingTellor.getNewValueCountbyQueryId(queryId)).to.equal(1);
    await h.advanceTime(100000);
    await oracle.submitValue(queryId, trueEncoded, 1, queryData);
    expect(await usingTellor.getNewValueCountbyQueryId(queryId)).to.equal(2);
  });

  it("getTimestampbyQueryIdandIndex()", async function () {
    await oracle.submitValue(queryId, falseEncoded, 0, queryData);
    blocky1 = await h.getBlock();
    await h.advanceTime(100000);
    await oracle.submitValue(queryId, trueEncoded, 1, queryData);
    blocky2 = await h.getBlock();
    expect(
      await usingTellor.getTimestampbyQueryIdandIndex(queryId, 0)
    ).to.equal(blocky1.timestamp);
    expect(
      await usingTellor.getTimestampbyQueryIdandIndex(queryId, 1)
    ).to.equal(blocky2.timestamp);
  });

  it("getCurrentValue()", async function () {
    await oracle.submitValue(queryId, falseEncoded, 0, queryData);
    blocky1 = await h.getBlock();
    currentVal1 = await usingTellor.getCurrentValue(queryId);
    expect(currentVal1[0]);
    expect(currentVal1[1]).to.equal(h.uintTob32(0));
    expect(currentVal1[2]).to.equal(blocky1.timestamp);
    await h.advanceTime(100000);
    await oracle.submitValue(queryId, trueEncoded, 1, queryData);
    blocky2 = await h.getBlock();
    currentVal1 = await usingTellor.getCurrentValue(queryId);
    expect(currentVal1[0]);
    expect(currentVal1[1]).to.equal(h.uintTob32(1));
    expect(currentVal1[2]).to.equal(blocky2.timestamp);
    await h.advanceTime(100000);
    await oracle.submitValue(
      h.hash("abracadabra"),
      h.bytes("houdini"),
      0,
      h.bytes("abracadabra")
    );
    blocky3 = await h.getBlock();
    currentVal3 = await usingTellor.getCurrentValue(h.hash("abracadabra"));
    expect(currentVal3[0]);
    expect(currentVal3[1]).to.equal(h.bytes("houdini"));
    expect(currentVal3[2]).to.equal(blocky3.timestamp);
  });

  it("getIndexForDataBefore()", async function () {
    await oracle.submitValue(queryId, falseEncoded, 0, queryData);
    blocky1 = await h.getBlock();
    await h.advanceTime(100000);
    await oracle.submitValue(queryId, trueEncoded, 1, queryData);
    blocky2 = await h.getBlock();

    index = await usingTellor.getIndexForDataBefore(queryId, blocky2.timestamp);
    expect(index[0]);
    expect(index[1]).to.equal(0);
  });

  it("getDataBefore()", async function () {
    await oracle.submitValue(queryId, falseEncoded, 0, queryData);
    blocky1 = await h.getBlock();
    await h.advanceTime(100000);
    await oracle.submitValue(queryId, trueEncoded, 1, queryData);
    blocky2 = await h.getBlock();

    dataBefore = await usingTellor.getDataBefore(queryId, blocky2.timestamp);
    expect(dataBefore[0]);
    expect(dataBefore[1]).to.equal(h.uintTob32(0));
    expect(dataBefore[2]).to.equal(blocky1.timestamp);
  });

  it("isInDispute()", async function () {
    await oracle.submitValue(queryId, falseEncoded, 0, queryData);
    blocky1 = await h.getBlock();
    await governance.beginDispute(queryId, blocky1.timestamp);
    expect(await usingTellor.isInDispute(queryId, blocky1.timestamp));
  });

  it("tellor()", async function () {
    expect(await usingTellor.tellor()).to.equal(tellorOracleAddress);
  });
});
