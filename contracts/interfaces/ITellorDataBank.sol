// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title ITellorDataBank
 * @notice Interface for TellorDataBank contract
 */
interface ITellorDataBank {
    struct AggregateData {
        bytes value;
        uint256 power;
        uint256 aggregateTimestamp;
        uint256 attestationTimestamp;
        uint256 relayTimestamp;
    }

    /**
     * @dev returns the current aggregate data for a given query ID
     * @param _queryId the query ID to get the current aggregate data for
     * @return _aggregateData the current aggregate data
     */
    function getCurrentAggregateData(bytes32 _queryId) external view returns (AggregateData memory _aggregateData);

    /**
     * @dev returns the aggregate data for a given query ID and index
     * @param _queryId the query ID to get the aggregate data for
     * @param _index the index of the aggregate data to get
     * @return _aggregateData the aggregate data
     */
    function getAggregateByIndex(bytes32 _queryId, uint256 _index) external view returns (AggregateData memory _aggregateData);

    /**
     * @dev returns the total number of aggregate values
     * @param _queryId the query ID to get the aggregate value count for
     * @return number of aggregate values stored
     */
    function getAggregateValueCount(bytes32 _queryId) external view returns (uint256);

    function getRelayBefore(bytes32 _queryId, uint256 _timestamp) external view returns (bool _found, AggregateData memory _aggregateData);
}

