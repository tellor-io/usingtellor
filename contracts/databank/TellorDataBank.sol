// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "../interfaces/ITellorDataBridge.sol";
import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";

/**
 @author Tellor Inc.
 @title TellorDataBank
 @dev this contract is used to store data for multiple data feeds. It prioritizes consensus data,
 and falls back to optimistic data if consensus data is not available. It has hardcoded preferences
 for max data age, max attestation age, optimistic delay, and optimistic power threshold.
*/
contract TellorDataBank is ITellorDataBank {
    // Constants
    uint256 public constant MAX_AGGREGATE_TIMESTAMP = type(uint64).max;
    uint256 public constant MAX_ATTESTATION_AGE = 10 minutes; // the max age of an attestation
    uint256 public constant MAX_DATA_AGE = 24 hours; // the max age of relayed data
    uint256 public constant MAX_SPOT_PRICE = type(uint192).max;
    uint256 public constant MS_PER_SECOND = 1000; // the number of milliseconds in a second
    uint256 public constant OPTIMISTIC_DELAY = 12 hours; // the min time from report to attestation for nonconsensus data

    // Immutables
    ITellorDataBridge public immutable dataBridge; // interface to the Tellor data bridge

    // Storage
    // Index-aligned with data; units are price * aggregate milliseconds.
    mapping(bytes32 => uint256[]) public cumulativePrice;
    mapping(bytes32 => AggregateData[]) public data; // queryId -> aggregate data array

    // Events
    event OracleUpdated(bytes32 indexed queryId, OracleAttestationData attestData);

    // Errors
    error AggregateTimestampOutOfRange();
    error InvalidPriceLength();
    error InvalidTwapWindow();
    error PriceOutOfRange();

    // Constructor

    /**
     * @dev initializes the TellorDataBank with a data bridge
     * @param _dataBridge address of the Tellor data bridge contract
     */
    constructor(address _dataBridge) {
        dataBridge = ITellorDataBridge(_dataBridge);
    }

    // State-changing functions

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
        bytes32 queryId = _attestData.queryId;
        uint256 count = data[queryId].length;
        uint256 cumulative;
        if (count > 0) {
            AggregateData storage previous = data[queryId][count - 1];
            cumulative = cumulativePrice[queryId][count - 1]
                + abi.decode(previous.value, (uint256)) * (_attestData.report.timestamp - previous.aggregateTimestamp);
        }
        cumulativePrice[queryId].push(cumulative);
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
     * @dev returns the newest stored relay whose EVM relay time is strictly before `_timestamp`
     * @param _queryId the query ID to search
     * @param _timestamp EVM timestamp cutoff in seconds
     */
    function getRelayBefore(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bool _found, AggregateData memory _aggregateData)
    {
        (bool indexFound, uint256 index) = _getIndexForRelayBefore(_queryId, _timestamp);
        if (!indexFound) {
            return (false, AggregateData(bytes(""), 0, 0, 0, 0));
        }
        return (true, data[_queryId][index]);
    }

    /**
     * @notice Returns a preceding TWAP and the actual wider interval used to calculate it.
     * @dev Availability describes computable history, not acceptable sampling or freshness.
     * No gap scan or extrapolation is performed. The endpoint is not a contributing observation.
     */
    function getTwapBefore(bytes32 _queryId, uint256 _relayCutoffSeconds, uint256 _minWindowMs)
        external
        view
        override
        returns (bool _available, TwapData memory _twap)
    {
        (_available, _twap.startIndex, _twap.endIndex, _twap.value) =
            _getTwapBefore(_queryId, _relayCutoffSeconds, _minWindowMs);
        if (!_available) return (false, _twap);

        _twap.startTimestamp = data[_queryId][_twap.startIndex].aggregateTimestamp;
        _twap.endTimestamp = data[_queryId][_twap.endIndex].aggregateTimestamp;
        _twap.observationCount = _twap.endIndex - _twap.startIndex;
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
     * @dev binary search for the newest index with relayTimestamp strictly before `_timestamp`
     */
    function _getIndexForRelayBefore(bytes32 _queryId, uint256 _timestamp)
        internal
        view
        returns (bool _found, uint256 _index)
    {
        uint256 count = data[_queryId].length;
        if (count == 0 || data[_queryId][0].relayTimestamp >= _timestamp) {
            return (false, 0);
        }

        uint256 end = count - 1;
        if (data[_queryId][end].relayTimestamp < _timestamp) {
            return (true, end);
        }

        uint256 start;
        while (start < end) {
            uint256 middle = (start + end + 1) / 2;
            if (data[_queryId][middle].relayTimestamp < _timestamp) {
                start = middle;
            } else {
                end = middle - 1;
            }
        }
        return (true, start);
    }

    /**
     * @dev Computes a wider-interval reference from stored history, without coverage policy.
     * Endpoint selection uses exclusive EVM seconds; start selection uses inclusive aggregate ms.
     * Missing history returns an entirely empty result, never a partial interval or extrapolation.
     * Returned indices identify the actual interval in data; only prices before end carry weight.
     */
    function _getTwapBefore(bytes32 _queryId, uint256 _relayCutoffSeconds, uint256 _minWindowMs)
        internal
        view
        returns (bool _available, uint256 _startIndex, uint256 _endIndex, uint256 _value)
    {
        if (_minWindowMs == 0) revert InvalidTwapWindow();
        (_available, _endIndex) = _getIndexForRelayBefore(_queryId, _relayCutoffSeconds);
        if (!_available) return (false, 0, 0, 0);

        uint256 endTimestamp = data[_queryId][_endIndex].aggregateTimestamp;
        if (endTimestamp < _minWindowMs) return (false, 0, 0, 0);
        uint256 target = endTimestamp - _minWindowMs;
        if (data[_queryId][0].aggregateTimestamp > target) return (false, 0, 0, 0);

        uint256 upper = _endIndex;
        // The first observation is eligible. Keep the newest eligible start inside [start, upper].
        // Rounding the midpoint up ensures progress when only two indices remain.
        while (_startIndex < upper) {
            uint256 middle = _startIndex + (upper - _startIndex + 1) / 2;
            if (data[_queryId][middle].aggregateTimestamp <= target) {
                _startIndex = middle;
            } else {
                upper = middle - 1;
            }
        }

        // Positive minimum window guarantees start < end and a nonzero denominator.
        // Cumulative subtraction excludes the endpoint price; division floors the wider average.
        uint256 weightedSum = cumulativePrice[_queryId][_endIndex] - cumulativePrice[_queryId][_startIndex];
        uint256 duration = endTimestamp - data[_queryId][_startIndex].aggregateTimestamp;
        return (true, _startIndex, _endIndex, weightedSum / duration);
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
        // Validate on admission so an unsupported stored price cannot poison the next interval.
        if (_attestData.report.timestamp > MAX_AGGREGATE_TIMESTAMP) revert AggregateTimestampOutOfRange();
        if (_attestData.report.value.length < 32) revert InvalidPriceLength();
        uint256 price = abi.decode(_attestData.report.value, (uint256));
        if (price == 0 || price > MAX_SPOT_PRICE) revert PriceOutOfRange();
        // check that the data is not too old
        require(block.timestamp - (_attestData.report.timestamp / MS_PER_SECOND) < MAX_DATA_AGE, "TellorDataBank: Data too old");
        // check that the attestation is not too old
        require(block.timestamp - (_attestData.attestationTimestamp / MS_PER_SECOND) < MAX_ATTESTATION_AGE, "TellorDataBank: Attestation too old");
        // check that timestamps are monotonically increasing
        AggregateData memory _previousData = _getCurrentAggregateData(_attestData.queryId);
        if (data[_attestData.queryId].length > 0) {
            require(_attestData.report.timestamp > _previousData.aggregateTimestamp, "TellorDataBank: Report timestamp must increase");
            require(_previousData.relayTimestamp < block.timestamp, "TellorDataBank: Only one relay per block");
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
