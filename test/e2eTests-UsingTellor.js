const { expect, assert } = require("chai");
const { ethers } = require("hardhat");
const h = require("./helpers/helpers");
const web3 = require('web3');
let abiCoder = new ethers.utils.AbiCoder

const precision = BigInt(1e18);
const FAUCET_AMOUNT = BigInt(1000) * precision;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("UsingTellor Function Tests", function() {

	let bench
  let playground
  let mappingContract;
	let owner, addr0, addr1, addr2;

	beforeEach(async function () {
    
		const TellorPlayground = await ethers.getContractFactory("TellorPlayground");
		playground = await TellorPlayground.deploy();
    await playground.deployed();

    const BenchUsingTellor = await ethers.getContractFactory("BenchUsingTellor");
    bench = await BenchUsingTellor.deploy(playground.address);
    await bench.deployed();

    const MappingContract = await ethers.getContractFactory("MappingContractExample");
    mappingContract = await MappingContract.deploy();
    await mappingContract.deployed();

		[owner, addr1, addr2] = await ethers.getSigners();
	});

  it("test getDataBefore and disputed data", async function() {
    let queryData = h.uintTob32(1);
    let queryId = h.hash(queryData);

    await playground.connect(addr1).submitValue(queryId,150,0,queryData)
    blocky1 = await h.getBlock()
    await playground.connect(addr1).submitValue(queryId,160,1,queryData)
    blocky2 = await h.getBlock()
    await playground.connect(addr1).submitValue(queryId,170,2,queryData)
    blocky3 = await h.getBlock()

    dataRetrieved = await bench.getDataBefore(queryId,blocky3.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(160))
    expect(dataRetrieved[1]).to.equal(blocky2.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky2.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(150))
    expect(dataRetrieved[1]).to.equal(blocky1.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky1.timestamp)
    expect(dataRetrieved[0]).to.equal('0x')
    expect(dataRetrieved[1]).to.equal(0)

    dataRetrieved = await bench.getDataBefore(queryId,blocky3.timestamp + 1)
    expect(dataRetrieved[0]).to.equal(h.bytes(170))
    expect(dataRetrieved[1]).to.equal(blocky3.timestamp)
    

    // dispute the middle value
    await playground.connect(addr1).beginDispute(queryId, blocky2.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky3.timestamp + 1)
    expect(dataRetrieved[0]).to.equal(h.bytes(170))
    expect(dataRetrieved[1]).to.equal(blocky3.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky3.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(150))
    expect(dataRetrieved[1]).to.equal(blocky1.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky2.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(150))
    expect(dataRetrieved[1]).to.equal(blocky1.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky1.timestamp)
    expect(dataRetrieved[0]).to.equal('0x')
    expect(dataRetrieved[1]).to.equal(0)


    // dispute the last value
    await playground.connect(addr1).beginDispute(queryId, blocky3.timestamp)
    
    dataRetrieved = await bench.getDataBefore(queryId,blocky3.timestamp + 1)
    expect(dataRetrieved[0]).to.equal(h.bytes(150))
    expect(dataRetrieved[1]).to.equal(blocky1.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky3.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(150))
    expect(dataRetrieved[1]).to.equal(blocky1.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky2.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(150))
    expect(dataRetrieved[1]).to.equal(blocky1.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky1.timestamp)
    expect(dataRetrieved[0]).to.equal('0x')
    expect(dataRetrieved[1]).to.equal(0)


    // dispute the first value
    await playground.connect(addr1).beginDispute(queryId, blocky1.timestamp)

    dataRetrieved = await bench.getDataBefore(queryId,blocky3.timestamp + 1)
    expect(dataRetrieved[0]).to.equal('0x')
    expect(dataRetrieved[1]).to.equal(0)

    dataRetrieved = await bench.getDataBefore(queryId,blocky3.timestamp)
    expect(dataRetrieved[0]).to.equal('0x')
    expect(dataRetrieved[1]).to.equal(0)

    dataRetrieved = await bench.getDataBefore(queryId,blocky2.timestamp)
    expect(dataRetrieved[0]).to.equal('0x')
    expect(dataRetrieved[1]).to.equal(0)

    dataRetrieved = await bench.getDataBefore(queryId,blocky1.timestamp)
    expect(dataRetrieved[0]).to.equal('0x')
    expect(dataRetrieved[1]).to.equal(0)
  })

  it("test getDataAfter and disputed data", async function() {
    let queryData = h.uintTob32(1);
    let queryId = h.hash(queryData);

    await playground.connect(addr1).submitValue(queryId,150,0,queryData)
    blocky1 = await h.getBlock()
    await playground.connect(addr1).submitValue(queryId,160,1,queryData)
    blocky2 = await h.getBlock()
    await playground.connect(addr1).submitValue(queryId,170,2,queryData)
    blocky3 = await h.getBlock()

    dataRetrieved = await bench.getDataAfter(queryId,blocky3.timestamp)
    expect(dataRetrieved[0]).to.equal('0x')
    expect(dataRetrieved[1]).to.equal(0)

    dataRetrieved = await bench.getDataAfter(queryId,blocky2.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(170))
    expect(dataRetrieved[1]).to.equal(blocky3.timestamp)

    dataRetrieved = await bench.getDataAfter(queryId,blocky1.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(160))
    expect(dataRetrieved[1]).to.equal(blocky2.timestamp)

    dataRetrieved = await bench.getDataAfter(queryId,blocky1.timestamp - 1)
    expect(dataRetrieved[0]).to.equal(h.bytes(150))
    expect(dataRetrieved[1]).to.equal(blocky1.timestamp)
    

    // dispute the middle value
    console.log("\ndispute the middle value")
    await playground.connect(addr1).beginDispute(queryId, blocky2.timestamp)

    console.log("\ndataRetrieved = await bench.getDataAfter(queryId,block1.timestamp - 1)")
    dataRetrieved = await bench.getDataAfter(queryId,blocky1.timestamp - 1)
    expect(dataRetrieved[0]).to.equal(h.bytes(150))
    expect(dataRetrieved[1]).to.equal(blocky1.timestamp)

    console.log("\ndataRetrieved = await bench.getDataAfter(queryId,blocky1.timestamp)")
    dataRetrieved = await bench.getDataAfter(queryId,blocky1.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(170))
    expect(dataRetrieved[1]).to.equal(blocky3.timestamp)

    dataRetrieved = await bench.getDataAfter(queryId,blocky2.timestamp)
    expect(dataRetrieved[0]).to.equal(h.bytes(170))
    expect(dataRetrieved[1]).to.equal(blocky3.timestamp)

    dataRetrieved = await bench.getDataAfter(queryId,blocky3.timestamp)
    expect(dataRetrieved[0]).to.equal('0x')
    expect(dataRetrieved[1]).to.equal(0)


   
  })

  it("lil test", async function() {
    let queryData = h.uintTob32(1);
    let queryId = h.hash(queryData);

    await playground.connect(addr1).submitValue(queryId,150,0,queryData)
    blocky1 = await h.getBlock()
    await playground.connect(addr1).submitValue(queryId,160,1,queryData)
    blocky2 = await h.getBlock()
    await playground.connect(addr1).submitValue(queryId,170,2,queryData)
    blocky3 = await h.getBlock()

    // dispute the middle value
    console.log("\ndispute the middle value")
    await playground.connect(addr1).beginDispute(queryId, blocky2.timestamp)

    console.log("\ndataRetrieved = await bench.getDataAfter(queryId,block1.timestamp - 1)")
    dataRetrieved = await bench.getDataAfter(queryId,blocky1.timestamp - 1)
    expect(dataRetrieved[0]).to.equal(h.bytes(150))
    expect(dataRetrieved[1]).to.equal(blocky1.timestamp)

    console.log("\ndataRetrieved = await bench.getDataAfter(queryId,blocky1.timestamp)")
    dataRetrieved = await bench.getDataAfter(queryId,blocky1.timestamp)
    index = await bench.getIndexForDataAfter(queryId,blocky1.timestamp)
    console.log("found: ",index[0])
    console.log("index: ",index[1])
    expect(dataRetrieved[0]).to.equal(h.bytes(170))
    expect(dataRetrieved[1]).to.equal(blocky3.timestamp)

   
  })

  it("query")

  // cases:
  //   - no data
  //   - one data point
  //   - two data points
  //   - last submitted value's timestamp is before the requested timestamp
  //   - first submitted value's timestamp is after the requested timestamp
  //   - "", is disputed, next value is not disputed
  //   - "", is disputed, next value is disputed
  //   - target value is in bottom half of values
  //   - target value is in top half of values
  //   - target value is in bottom half of values, but is disputed
  //   - target value is in top half of values, but is disputed
  //   - target value is in bottom half of values, but is disputed, and next value is disputed
  //   - target value is in top half of values, but is disputed, and next value is disputed
  //   - middle value == inputted timestamp
