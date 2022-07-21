const { expect } = require("chai");
const { ethers } = require("hardhat");
const h = require("./helpers/helpers");

const precision = BigInt(1e18);
const FAUCET_AMOUNT = BigInt(1000) * precision;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("UsingTellor", function() {

	let bench
  let playground
	let owner, addr0, addr1, addr2;

	beforeEach(async function () {

		const TellorPlayground = await ethers.getContractFactory("TellorPlayground");
		playground = await TellorPlayground.deploy();
    await playground.deployed();
    const BenchUsingTellor = await ethers.getContractFactory("BenchUsingTellor");
    bench = await BenchUsingTellor.deploy(playground.address);
    await bench.deployed();
		[owner, addr1, addr2] = await ethers.getSigners();
	});

  it("retrieveData()", async function() {
    await playground.connect(addr1).submitValue(h.uintTob32(1),150,0,'0x')
    blocky1 = await h.getBlock()
    await playground.connect(addr1).submitValue(h.uintTob32(1),160,1,'0x')
    blocky2 = await h.getBlock()
    await playground.connect(addr1).submitValue(h.uintTob32(1),170,2,'0x')
    blocky3 = await h.getBlock()
    expect(await bench.retrieveData(h.uintTob32(1), blocky1.timestamp)).to.equal(h.bytes(150))
    expect(await bench.retrieveData(h.uintTob32(1), blocky2.timestamp)).to.equal(h.bytes(160))
    expect(await bench.retrieveData(h.uintTob32(1), blocky3.timestamp)).to.equal(h.bytes(170))
  })

  it("getNewValueCountbyQueryId", async function() {
    await playground.connect(addr1).submitValue(h.uintTob32(1),150,0,'0x')
    expect(await bench.getNewValueCountbyQueryId(h.uintTob32(1))).to.equal(1)
    await playground.connect(addr1).submitValue(h.uintTob32(1),160,1,'0x')
    expect(await bench.getNewValueCountbyQueryId(h.uintTob32(1))).to.equal(2)
    await playground.connect(addr1).submitValue(h.uintTob32(1),170,2,'0x')
    expect(await bench.getNewValueCountbyQueryId(h.uintTob32(1))).to.equal(3)
  })

  it("getTimestampbyQueryIdandIndex()", async function() {
    await playground.connect(addr1).submitValue(h.uintTob32(1),150,0,'0x')
    blocky1 = await h.getBlock()
    await playground.connect(addr1).submitValue(h.uintTob32(1),160,1,'0x')
    blocky2 = await h.getBlock()
    await playground.connect(addr1).submitValue(h.uintTob32(1),170,2,'0x')
    blocky3 = await h.getBlock()
    expect(await bench.getTimestampbyQueryIdandIndex(h.uintTob32(1), 0)).to.equal(blocky1.timestamp)
    expect(await bench.getTimestampbyQueryIdandIndex(h.uintTob32(1), 1)).to.equal(blocky2.timestamp)
    expect(await bench.getTimestampbyQueryIdandIndex(h.uintTob32(1), 2)).to.equal(blocky3.timestamp)
  })

  it("getIndexForDataBefore()", async function() {
    await playground.connect(addr1).submitValue(h.uintTob32(1),150,0,'0x')
    blocky1 = await h.getBlock()
    await playground.connect(addr1).submitValue(h.uintTob32(1),160,1,'0x')
    blocky2 = await h.getBlock()
    await playground.connect(addr1).submitValue(h.uintTob32(1),170,2,'0x')
    blocky3 = await h.getBlock()
    index = await bench.getIndexForDataBefore(h.uintTob32(1), blocky3.timestamp)
    expect(index[0])
    expect(index[1]).to.equal(1)
  })

  it("getDataBefore()", async function() {
    await playground.connect(addr1).submitValue(h.uintTob32(1),150,0,'0x')
    blocky1 = await h.getBlock()
    await playground.connect(addr1).submitValue(h.uintTob32(1),160,1,'0x')
    blocky2 = await h.getBlock()
    await playground.connect(addr1).submitValue(h.uintTob32(1),170,2,'0x')
    blocky3 = await h.getBlock()
    dataBefore = await bench.getDataBefore(h.uintTob32(1), blocky2.timestamp)
    expect(dataBefore[0])
    expect(dataBefore[1]).to.equal(h.bytes(150))
    expect(dataBefore[2]).to.equal(blocky1.timestamp)
  })

	it("isInDispute()", async function() {
		await playground.connect(addr1).submitValue(h.uintTob32(1),150,0,'0x')
    blocky1 = await h.getBlock()
    await playground.connect(addr1).submitValue(h.uintTob32(1),160,1,'0x')
    blocky2 = await h.getBlock()
		expect(await bench.isInDispute(h.uintTob32(1), blocky1.timestamp)).to.be.false;
		await playground.beginDispute(h.uintTob32(1), blocky1.timestamp)
		expect(await bench.isInDispute(h.uintTob32(1), blocky1.timestamp))
		await playground.beginDispute(h.uintTob32(1), blocky1.timestamp)
		expect(await bench.isInDispute(h.uintTob32(1), blocky1.timestamp))
		expect(await bench.isInDispute(h.uintTob32(1), blocky2.timestamp)).to.be.false;
		await playground.beginDispute(h.uintTob32(1), blocky2.timestamp)
		expect(await bench.isInDispute(h.uintTob32(1), blocky2.timestamp))
	})

	it("tellor()", async function() {
		expect(await bench.tellor()).to.equal(playground.address)
	})
});
