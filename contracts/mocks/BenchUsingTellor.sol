// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "../UsingTellor.sol";

/**
 * @title UserContract
 * This contract inherits UsingTellor for simulating user interaction
 */
contract BenchUsingTellor is UsingTellor {
    constructor(address payable _tellor) UsingTellor(_tellor) {}

    function getDataAfter(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bytes memory _value, uint256 _timestampRetrieved)
    {
        return _getDataAfter(_queryId, _timestamp);
    }

    function getDataBefore(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bytes memory _value, uint256 _timestampRetrieved)
    {
        return _getDataBefore(_queryId, _timestamp);
    }

    function getIndexForDataAfter(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bool _found, uint256 _index)
    {
        return _getIndexForDataAfter(_queryId, _timestamp);
    }

    function getIndexForDataBefore(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bool _found, uint256 _index)
    {
        return _getIndexForDataBefore(_queryId, _timestamp);
    }

    function getMultipleValuesBefore(
        bytes32 _queryId,
        uint256 _timestamp,
        uint256 _maxAge,
        uint256 _maxCount
    )
        external
        view
        returns (bytes[] memory _values, uint256[] memory _timestamps)
    {
       return _getMultipleValuesBefore(_queryId, _timestamp, _maxAge, _maxCount);
    }

    function getNewValueCountbyQueryId(bytes32 _queryId)
        external
        view
        returns (uint256)
    {
        return _getNewValueCountbyQueryId(_queryId);
    }

    function getReporterByTimestamp(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (address)
    {
        return _getReporterByTimestamp(_queryId, _timestamp);
    }

    function getTimestampbyQueryIdandIndex(bytes32 _queryId, uint256 _index)
        external
        view
        returns (uint256)
    {
        return _getTimestampbyQueryIdandIndex(_queryId, _index);
    }

    function isInDispute(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bool)
    {
        return _isInDispute(_queryId, _timestamp);
    }

    function retrieveData(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bytes memory)
    {
        return _retrieveData(_queryId, _timestamp);
    }

}
