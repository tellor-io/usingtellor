// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "../interfaces/ITellorDataBridge.sol";

// This contract shows a baseline oracle user that just verifies the data is valid tellor data
// and stores the data for retrieval. It should never be used in production.

contract YoloTellorUser {
    ITellorDataBridge public dataBridge;
    bytes32 public queryId;
    OracleData[] public oracleData;

    struct OracleData {
        uint256 value;
        uint256 timestamp;
    }

    // sets the tellor data bridge address and the queryId
    constructor(address _dataBridge, bytes32 _queryId) {
        dataBridge = ITellorDataBridge(_dataBridge);
        queryId = _queryId;
    }

    // updates this contract with new oracle data using the data bridge
    // production users should add security checks
    function updateOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) external {
        // make sure the data is valid tellor data
        dataBridge.verifyOracleData(_attestData, _currentValidatorSet, _sigs);
        // make sure the data being relayed is the data we want
        require(queryId == _attestData.queryId, "Invalid queryId");

        // decode the data and store it
        uint256 _value = abi.decode(_attestData.report.value, (uint256));
        oracleData.push(OracleData(_value, _attestData.report.timestamp));
    }

    // returns the most recent data
    function getCurrentData() external view returns (OracleData memory) {
        return oracleData[oracleData.length - 1];
    }

    // returns the number of data points stored
    function getValueCount() external view returns (uint256) {
        return oracleData.length;
    }
}