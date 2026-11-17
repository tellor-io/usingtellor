const { expect } = require("chai");

describe("Package entry point", function () {
  it("exports usable helpers through the package root", function () {
    const { toWei, fromWei, getDomainSeparator } = require("..");
    expect(toWei("1.5")).to.equal(1500000000000000000n);
    expect(fromWei(1500000000000000000n)).to.equal("1.5");
    expect(getDomainSeparator("tellor-1")).to.equal(
      "0x636865636b706f696e7400000000000000000000000000000000000000000000"
    );
  });

  it("uses the consumer's Hardhat network for time helpers", async function () {
    const { advanceTime, getBlock } = require("..");
    const before = await getBlock();
    await advanceTime(60);
    const after = await getBlock();
    expect(after.timestamp).to.be.at.least(before.timestamp + 60);
  });
});
