// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

interface ITellor {
    function getNewValueCountbyQueryId(bytes32 _queryId) external view returns (uint256);
    function getTimestampbyQueryIdandIndex(bytes32 _queryId, uint256 _index) external view returns (uint256);
    function retrieveData(bytes32 _queryId, uint256 _timestamp) external view returns (bytes memory);
    function getReporterByTimestamp(bytes32 _queryId, uint256 _timestamp) external view returns (address);
    function getDataBefore(bytes32 _queryId, uint256 _timestamp) external  view  returns(bool _ifRetrieve, bytes memory _value, uint256 _timestampRetrieved);
    function getIndexForDataBefore(bytes32 _queryId, uint256 _timestamp) external view returns (bool _found, uint256 _index);
    function isInDispute(bytes32 _queryId, uint256 _timestamp) external view returns (bool);
}
