const web3 = require("web3");
var contract = require("@truffle/contract");
var tellor = require("example-truffle-library/build/contracts/MockTellor.json");

const addData = (_requestId, _value) => {
  return tellor.submitValue(_requestId, _value);
};

const disputeValue = (_requestId, _timestamp) => {
  return tellor.disputeValue(_requestId, _timestamp);
};
