// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "../interfaces/ITellorDataBridge.sol";
import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";

/**
 @author Tellor Inc.
 @title TellorDataBank2
 @dev Stores aggregate oracle data and exposes Tellor-style historical lookups by relay timestamp.
*/
contract TellorDataBank is ITellorDataBank {
    // Storage
    ITellorDataBridge public immutable dataBridge; // interface to the Tellor data bridge
    mapping(bytes32 => AggregateData[]) public data; // queryId -> aggregate data array, sorted by relayTimestamp
    uint256 public immutable MAX_DATA_AGE; // the max age of an aggregate report
    uint256 public immutable MAX_ATTESTATION_AGE; // the max age of an attestation
    uint256 public constant MS_PER_SECOND = 1000; // the number of milliseconds in a second
    uint256 public immutable OPTIMISTIC_DELAY; // the min time from report to attestation for nonconsensus data

    // Events
    event OracleUpdated(bytes32 indexed queryId, OracleAttestationData attestData);

    // Functions
    /**
     * @dev initializes the TellorDataBank2 with a data bridge
     * @param _dataBridge address of the Tellor data bridge contract
     * @param _maxDataAge the max age of relayed data
     * @param _maxAttestationAge the max age of an attestation
     * @param _optimisticDelay the min time from report to attestation for nonconsensus data
     */
    constructor(address _dataBridge, uint256 _maxDataAge, uint256 _maxAttestationAge, uint256 _optimisticDelay) {
        dataBridge = ITellorDataBridge(_dataBridge);
        MAX_DATA_AGE = _maxDataAge;
        MAX_ATTESTATION_AGE = _maxAttestationAge;
        OPTIMISTIC_DELAY = _optimisticDelay;
    }

    /**
     * @dev updates oracle data with new attestation data after verification
     * @param _attestData the oracle attestation data to be stored
     * @param _currentValidatorSet array of current validators
     * @param _sigs array of validator signatures
     */
    function updateOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) external {
        _verifyOracleData(
            _attestData,
            _currentValidatorSet,
            _sigs
        );
        data[_attestData.queryId].push(AggregateData(
            _attestData.report.value,
            _attestData.report.aggregatePower,
            _attestData.report.timestamp,
            _attestData.attestationTimestamp,
            block.timestamp
        ));
        emit OracleUpdated(_attestData.queryId, _attestData);
    }

    // Getter functions

    /**
     * @dev returns the aggregate data for a given query ID and index
     * @param _queryId the query ID to get the aggregate data for
     * @param _index the index of the aggregate data to get
     * @return _aggregateData the aggregate data
     */
    function getAggregateByIndex(bytes32 _queryId, uint256 _index) external view returns (AggregateData memory _aggregateData) {
        return data[_queryId][_index];
    }

    /**
     * @dev returns the total number of aggregate values
     * @param _queryId the query ID to get the aggregate value count for
     * @return number of aggregate values stored
     */
    function getAggregateValueCount(bytes32 _queryId) external view returns (uint256) {
        return data[_queryId].length;
    }

    /**
     * @dev returns the current aggregate data for a given query ID
     * @param _queryId the query ID to get the current aggregate data for
     * @return _aggregateData the current aggregate data
     */
    function getCurrentAggregateData(bytes32 _queryId) external view returns (AggregateData memory _aggregateData) {
        return _getCurrentAggregateData(_queryId);
    }

    /**
     * @dev retrieves latest aggregate data relayed before the specified timestamp for the queryId
     * @param _queryId the query ID to look up
     * @param _timestamp the relay timestamp before which to search
     * @return _found whether data was found
     * @return _aggregateData the aggregate data found
     */
    function getRelayBefore(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bool _found, AggregateData memory _aggregateData)
    {
        (bool _indexFound, uint256 _index) = getIndexForRelayBefore(_queryId, _timestamp);
        if (!_indexFound) {
            return (false, AggregateData(bytes(""), 0, 0, 0, 0));
        }
        return (true, data[_queryId][_index]);
    }

    /**
     * @dev retrieves latest array index of data relayed before the specified timestamp for the queryId
     * @param _queryId the query ID to look up
     * @param _timestamp the relay timestamp before which to search
     * @return _found whether an index was found
     * @return _index the latest index found before the specified relay timestamp
     */
    function getIndexForRelayBefore(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bool _found, uint256 _index)
    {
        uint256 _count = data[_queryId].length;
        if (_count == 0 || data[_queryId][0].relayTimestamp >= _timestamp) {
            return (false, 0);
        }

        uint256 _end = _count - 1;
        if (data[_queryId][_end].relayTimestamp < _timestamp) {
            return (true, _end);
        }

        uint256 _start = 0;
        while (_start < _end) {
            uint256 _middle = (_start + _end + 1) / 2;
            if (data[_queryId][_middle].relayTimestamp < _timestamp) {
                _start = _middle;
            } else {
                _end = _middle - 1;
            }
        }
        return (true, _start);
    }

    /**
     * @dev returns the relay timestamp for the value based on its index
     * @param _queryId the query ID to look up
     * @param _index the value index to look up
     * @return relay timestamp
     */
    function getRelayTimestampbyQueryIdandIndex(bytes32 _queryId, uint256 _index) external view returns (uint256) {
        return data[_queryId][_index].relayTimestamp;
    }

    // Internal functions
    /**
     * @dev internal function to get the current aggregate data for a query ID
     * @param _queryId the query ID to get the current aggregate data for
     * @return _aggregateData the current aggregate data
     */
    function _getCurrentAggregateData(bytes32 _queryId) internal view returns (AggregateData memory _aggregateData) {
        if (data[_queryId].length == 0) {
            return (AggregateData(bytes(""), 0, 0, 0, 0));
        }
        _aggregateData = data[_queryId][data[_queryId].length - 1];
        return _aggregateData;
    }

    /**
     * @dev internal function to verify oracle data meets all requirements before storage
     * @param _attestData the oracle attestation data to verify
     * @param _currentValidatorSet array of current validators
     * @param _sigs array of validator signatures
     */
    function _verifyOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) internal view {
        // check that the data is not too old
        require(block.timestamp - (_attestData.report.timestamp / MS_PER_SECOND) < MAX_DATA_AGE, "TellorDataBank: Data too old");
        // check that the attestation is not too old
        require(block.timestamp - (_attestData.attestationTimestamp / MS_PER_SECOND) < MAX_ATTESTATION_AGE, "TellorDataBank: Attestation too old");
        // check that timestamps are monotonically increasing
        AggregateData memory _previousData = _getCurrentAggregateData(_attestData.queryId);
        if (_previousData.aggregateTimestamp > 0) {
            require(_attestData.report.timestamp > _previousData.aggregateTimestamp, "TellorDataBank: Report timestamp must increase");
        }
        // check that the current block timestamp is greater than or equal to the report timestamp
        require(block.timestamp >= (_attestData.report.timestamp / MS_PER_SECOND), "TellorDataBank: Report timestamp is in the future");
        // check if there's a more recent optimistic report available
        if (_attestData.report.nextTimestamp != 0) {
            require(block.timestamp - (_attestData.report.nextTimestamp / MS_PER_SECOND) < OPTIMISTIC_DELAY, "TellorDataBank: More recent optimistic report available");
        }
        // handle optimistic vs consensus data verification
        if (_attestData.report.timestamp != _attestData.report.lastConsensusTimestamp) {
            // using optimistic data - additional checks required
            require(_attestData.report.lastConsensusTimestamp < _attestData.report.timestamp, "TellorDataBank: Newer consensus data available");
            require((_attestData.attestationTimestamp - _attestData.report.timestamp) / MS_PER_SECOND >= OPTIMISTIC_DELAY, "TellorDataBank: Dispute period not passed");
            require(_attestData.report.aggregatePower > dataBridge.powerThreshold() / 2, "TellorDataBank: Insufficient optimistic report power");
        }
        // verify signatures and data integrity through the data bridge
        dataBridge.verifyOracleData(_attestData, _currentValidatorSet, _sigs);
    }
}
