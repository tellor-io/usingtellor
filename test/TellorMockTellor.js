const MockTellor = artifacts.require("MockTellor.sol");
const UsingTellor = artifacts.require("UsingTellor.sol");

contract("Mock Tellor", function(accounts) {
  let oracle;
  let balances = [];
  for (var i = 0; i < accounts.length; i++) {
    balances.push(web3.utils.toWei("7000", "ether"));
  }
  const val = "4000";
  const requestId = 1;

  beforeEach("Setup contract for each test", async function() {
    //deploy old, request, update address, mine old challenge.
    oracle = await MockTellor.new(accounts, balances);
  });
  it("Can add a value and retrieve value", async function() {
    await oracle.submitValue(requestId, val);
    let time = await oracle.getTimestampbyRequestIDandIndex(requestId, 0);
    let value = await oracle.retrieveData(requestId, time.toString());
    assert.equal(value.toString(), val);
  });

  it("Can dispute value", async () => {
    await oracle.submitValue(requestId, val);
    let time = await oracle.getTimestampbyRequestIDandIndex(requestId, 0);

    let value = await oracle.retrieveData(requestId, time.toString());
    assert.equal(value.toString(), val);
    await oracle.disputeValue(requestId, time.toString());

    value = await oracle.retrieveData(requestId, time.toString());
    assert.equal(value.toString(), "0");
    assert.isTrue(await oracle.isInDispute(requestId, time.toString()));
  });

  it("Correctly return value count", async () => {
    let count = await oracle.getNewValueCountbyRequestId(requestId);
    assert.isTrue(count.toString() == "0");
    await oracle.submitValue(requestId, val);
    count = await oracle.getNewValueCountbyRequestId(requestId);
    assert.isTrue(count.toString() == "1");
  });
});
