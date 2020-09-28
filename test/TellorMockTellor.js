const MockTellor = artifacts.require("MockTellor.sol");
const UsingTellor = artifacts.require("UsingTellor.sol");
const BenchUsingTellor = artifacts.require("BenchUsingTellor.sol");

advanceTime = (time) => {
  return new Promise((resolve, reject) => {
    web3.currentProvider.send(
      {
        jsonrpc: "2.0",
        method: "evm_increaseTime",
        params: [time],
        id: new Date().getTime(),
      },
      (err, result) => {
        if (err) {
          return reject(err);
        }
        return resolve(result);
      }
    );
  });
};

const getIndexForDataBefore = async (_requestId, _timestamp, tellor) => {
  let _countB = await tellor.getNewValueCountbyRequestId(_requestId);
  // console.log("STARTING", _timestamp);
  let _count = _countB.toNumber();
  if (_count > 0) {
    let start = 0;
    let end = _count - 1;
    let middle;
    while (true) {
      middle = Math.floor((end - start) / 2) + 1 + start;
      // console.log("I: ", i);
      // console.log("start", start);
      // console.log("middle", middle);
      // console.log("end", end);
      let _timeB = await tellor.getTimestampbyRequestIDandIndex(
        _requestId,
        middle
      );
      let _timeS = await tellor.getTimestampbyRequestIDandIndex(
        _requestId,
        start
      );
      let _timeE = await tellor.getTimestampbyRequestIDandIndex(
        _requestId,
        end
      );
      if (_timeE.toNumber() < _timestamp) return [true, end];
      if (_timeS.toNumber() >= _timestamp) return [false, 0];
      let _time = _timeB.toNumber();
      // console.log("time:", _time);

      if (_time < _timestamp) {
        // console.log("Time is smaller than timestamp");
        //get imeadiate next value
        let _nextTimeB = await tellor.getTimestampbyRequestIDandIndex(
          _requestId,
          middle + 1
        );
        let _nextTime = _nextTimeB.toNumber();
        // console.log("nextTime", _nextTime);
        if (_nextTime >= _timestamp) {
          // console.log("returning inside nextTime", true, middle);
          //_time is correct
          return [true, middle];
        } else {
          //look from middle + 1 to count
          start = middle + 1;
        }
      } else {
        // console.log("Time is bigger than timestamp");
        let _prevTimeB = await tellor.getTimestampbyRequestIDandIndex(
          _requestId,
          middle - 1
        );
        let _prevTime = _prevTimeB.toNumber();
        if (_prevTime < _timestamp) {
          // _prevtime is correct
          // console.log("returning inside prevTime", true, middle - 1);
          return [true, middle - 1];
        } else {
          //look from middle -1 to 0
          end = middle - 1;
        }
      }
    }
  }
  return [false, 0];
};
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

contract("Using Tellor", function(accounts) {
  let oracle;
  let usingTellor;
  let balances = [];
  for (var i = 0; i < accounts.length; i++) {
    balances.push(web3.utils.toWei("7000", "ether"));
  }
  const val = "4000";
  const requestId = 1;

  beforeEach("Setup contract for each test", async function() {
    //deploy old, request, update address, mine old challenge.
    oracle = await MockTellor.new(accounts, balances);
    usingTellor = await UsingTellor.new(oracle.address);
  });

  it("Can find IndexForDataBefore", async () => {
    //add a bunch of times
    for (let i = 0; i <= 20; i++) {
      await oracle.submitValue(requestId, i + val);
      await advanceTime(2);
    }
    // let am = await oracle.getNewValueCountbyRequestId(requestId);
    let lowValue = await oracle.getTimestampbyRequestIDandIndex(requestId, 0);
    let highValue = await oracle.getTimestampbyRequestIDandIndex(requestId, 20);
    for (let i = lowValue.toNumber(); i <= highValue.toNumber() + 2; i++) {
      // console.log("Cheking for timestamp ", i);
      let idx = await usingTellor.getIndexForDataBefore(requestId, i);
      let ref_idx = await getIndexForDataBefore(requestId, i, oracle);
      // console.log(idx["0"], ref_idx[0], idx["1"].toNumber(), ref_idx[1]);
      assert(idx["0"] == ref_idx[0]);
      assert(idx["1"].toNumber() == ref_idx[1]);
    }
  });

  it("Gas Value Test For GetDataBefore", async () => {
    let bench = await BenchUsingTellor.new(oracle.address);
    //add a bunch of times
    for (let i = 0; i <= 100; i++) {
      await oracle.submitValue(requestId, i + val);
      await advanceTime(1);
    }
    // let am = await oracle.getNewValueCountbyRequestId(requestId);
    let lowValue = await oracle.getTimestampbyRequestIDandIndex(requestId, 0);
    let highValue = await oracle.getTimestampbyRequestIDandIndex(
      requestId,
      100
    );

    let worse = 0;
    for (let i = lowValue.toNumber(); i <= highValue.toNumber() + 1; i++) {
      // console.log(i);
      let idx = await bench.wrapper(requestId, i);
      let gas = idx.receipt.gasUsed;
      if (gas > worse) {
        worse = gas;
      }
    }
    // console.log("Gas used for worse case scnerio: ", worse);

    // I run with 10k values in the array and the gas spendig was:
    //Gas used for worse case scnerio:  128033
  });
});
