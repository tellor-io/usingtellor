// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "../interfaces/ITellorDataBridge.sol";
import { ITellorDataBank } from "../interfaces/ITellorDataBank.sol";

/**
 * @author Tellor Inc.
 * @title TellorDataBank
 * @notice Stores verified reports per feed and supplies relay history and time-weighted averages.
 * @dev Consensus and optimistic reports follow separate admission rules. Timing policy is fixed
 * at deployment; the optimistic power threshold is derived from the bridge.
 */
contract TellorDataBank is ITellorDataBank {
    // Constants
    uint256 public constant MAX_AGGREGATE_TIMESTAMP = type(uint64).max;
    uint256 public constant MAX_SPOT_PRICE = type(uint192).max;
    uint256 public constant MS_PER_SECOND = 1000; // the number of milliseconds in a second

    // Immutables
    ITellorDataBridge public immutable dataBridge; // interface to the Tellor data bridge
    uint256 public immutable MAX_ATTESTATION_AGE; // exclusive attestation age limit, seconds
    uint256 public immutable MAX_DATA_AGE; // exclusive report age limit, seconds
    uint256 public immutable OPTIMISTIC_DELAY; // inclusive report-to-attestation minimum, seconds

    // Storage
    // Index-aligned with data; units are price * aggregate milliseconds.
    mapping(bytes32 => uint256[]) public cumulativePrice;
    mapping(bytes32 => AggregateData[]) public data; // queryId -> aggregate data array

    // Events
    event OracleUpdated(bytes32 indexed queryId, OracleAttestationData attestData);

    // Errors
    error AggregateTimestampOutOfRange();
    error AttestationBeforeReport();
    error AttestationTimestampInFuture();
    error InvalidPriceLength();
    error InvalidTimingConfiguration();
    error InvalidTwapWindow();
    error NextTimestampInFuture();
    error PriceOutOfRange();
    error ReportTimestampInFuture();

    // Constructor

    /**
     * @notice Binds the data bridge and immutable report-admission timing policy.
     * @param _dataBridge Address of the bridge used to verify validator attestations.
     * @param _optimisticDelay Positive nonconsensus report-to-attestation delay, in seconds.
     * @param _maxAttestationAge Positive exclusive attestation age limit, in seconds.
     * @param _maxDataAge Positive exclusive report age limit, in seconds.
     * @dev The deployer must calibrate dispute safety and compatible source/consumer timing.
     */
    constructor(address _dataBridge, uint256 _optimisticDelay, uint256 _maxAttestationAge, uint256 _maxDataAge) {
        if (_optimisticDelay == 0 || _maxAttestationAge == 0 || _maxDataAge == 0) revert InvalidTimingConfiguration();
        dataBridge = ITellorDataBridge(_dataBridge);
        OPTIMISTIC_DELAY = _optimisticDelay;
        MAX_ATTESTATION_AGE = _maxAttestationAge;
        MAX_DATA_AGE = _maxDataAge;
    }

    // State-changing functions

    /**
     * @notice Verifies and appends a report and its cumulative price-time integral.
     * @param _attestData Oracle attestation and report to verify and store.
     * @param _currentValidatorSet Current validators, ordered to match the signatures.
     * @param _sigs Validator signatures in the same order as _currentValidatorSet.
     */
    function updateOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) external {
        _verifyOracleData(_attestData, _currentValidatorSet, _sigs);
        bytes32 _queryId = _attestData.queryId;
        uint256 _count = data[_queryId].length;
        uint256 _cumulative;
        if (_count > 0) {
            AggregateData storage _previous = data[_queryId][_count - 1];
            _cumulative =
                cumulativePrice[_queryId][_count - 1] +
                abi.decode(_previous.value, (uint256)) *
                (_attestData.report.timestamp - _previous.aggregateTimestamp);
        }
        cumulativePrice[_queryId].push(_cumulative);
        data[_attestData.queryId].push(
            AggregateData(
                _attestData.report.value,
                _attestData.report.aggregatePower,
                _attestData.report.timestamp,
                _attestData.attestationTimestamp,
                block.timestamp
            )
        );
        emit OracleUpdated(_attestData.queryId, _attestData);
    }

    // Getter functions

    /**
     * @notice Returns the stored aggregate for a query ID and index.
     * @param _queryId Feed whose stored aggregate is requested.
     * @param _index Zero-based aggregate index; out-of-range access reverts.
     * @return _aggregateData Stored report with aggregate/attestation times in milliseconds and relay time in seconds.
     */
    function getAggregateByIndex(
        bytes32 _queryId,
        uint256 _index
    ) external view returns (AggregateData memory _aggregateData) {
        return data[_queryId][_index];
    }

    /**
     * @notice Returns the number of stored aggregates for a query ID.
     * @param _queryId Feed whose stored aggregates are counted.
     * @return Number of aggregates stored for the feed.
     */
    function getAggregateValueCount(bytes32 _queryId) external view returns (uint256) {
        return data[_queryId].length;
    }

    /**
     * @notice Returns the newest stored aggregate for a query ID, or an empty struct if none exists.
     * @param _queryId Feed whose newest stored aggregate is requested.
     * @return _aggregateData Newest stored aggregate, or an empty struct if none exists.
     */
    function getCurrentAggregateData(bytes32 _queryId) external view returns (AggregateData memory _aggregateData) {
        return _getCurrentAggregateData(_queryId);
    }

    /**
     * @notice Returns the newest stored relay whose EVM relay time is strictly before _timestamp.
     * @param _queryId Feed whose relay history is searched.
     * @param _timestamp Exclusive EVM relay-time cutoff in seconds.
     * @return _found Whether a relay exists strictly before the cutoff.
     * @return _aggregateData Matching relay, or an empty struct if none exists.
     */
    function getRelayBefore(
        bytes32 _queryId,
        uint256 _timestamp
    ) external view returns (bool _found, AggregateData memory _aggregateData) {
        (bool _indexFound, uint256 _index) = _getIndexForRelayBefore(_queryId, _timestamp);
        if (!_indexFound) {
            return (false, AggregateData(bytes(""), 0, 0, 0, 0));
        }
        return (true, data[_queryId][_index]);
    }

    /**
     * @notice Returns a preceding TWAP and the actual wider interval used to calculate it.
     * @dev Availability describes computable history, not acceptable sampling or freshness.
     * No gap scan or extrapolation is performed. The endpoint is not a contributing observation.
     * @param _queryId Feed whose stored history supplies the average.
     * @param _relayCutoffSeconds Exclusive EVM relay-time cutoff in seconds.
     * @param _minWindowMs Positive minimum aggregate-time interval in milliseconds.
     * @return _available Whether the requested interval can be computed from stored history.
     * @return _twap Average and metadata for the actual interval; its endpoint does not establish contributor freshness.
     */
    function getTwapBefore(
        bytes32 _queryId,
        uint256 _relayCutoffSeconds,
        uint256 _minWindowMs
    ) external view override returns (bool _available, TwapData memory _twap) {
        (_available, _twap.startIndex, _twap.endIndex, _twap.value) = _getTwapBefore(
            _queryId,
            _relayCutoffSeconds,
            _minWindowMs
        );
        if (!_available) return (false, _twap);

        _twap.startTimestamp = data[_queryId][_twap.startIndex].aggregateTimestamp;
        _twap.endTimestamp = data[_queryId][_twap.endIndex].aggregateTimestamp;
        _twap.observationCount = _twap.endIndex - _twap.startIndex;
    }

    // Internal functions

    /**
     * @dev Returns the newest stored aggregate, or an empty struct if no history exists.
     * @param _queryId Feed whose newest stored aggregate is requested.
     * @return _aggregateData Newest stored aggregate, or an empty struct if none exists.
     */
    function _getCurrentAggregateData(bytes32 _queryId) internal view returns (AggregateData memory _aggregateData) {
        if (data[_queryId].length == 0) {
            return (AggregateData(bytes(""), 0, 0, 0, 0));
        }
        _aggregateData = data[_queryId][data[_queryId].length - 1];
        return _aggregateData;
    }

    /**
     * @dev Binary search for the newest index with relayTimestamp strictly before _timestamp.
     * @param _queryId Feed whose relay history is searched.
     * @param _timestamp Exclusive EVM relay-time cutoff in seconds.
     * @return _found Whether an eligible relay exists.
     * @return _index Newest eligible relay index, or zero when _found is false.
     */
    function _getIndexForRelayBefore(
        bytes32 _queryId,
        uint256 _timestamp
    ) internal view returns (bool _found, uint256 _index) {
        uint256 _count = data[_queryId].length;
        if (_count == 0 || data[_queryId][0].relayTimestamp >= _timestamp) {
            return (false, 0);
        }

        uint256 _end = _count - 1;
        if (data[_queryId][_end].relayTimestamp < _timestamp) {
            return (true, _end);
        }

        uint256 _start;
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
     * @dev Computes a wider-interval reference from stored history, without coverage policy.
     * Endpoint selection uses exclusive EVM seconds; start selection uses inclusive aggregate ms.
     * Missing history returns an entirely empty result, never a partial interval or extrapolation.
     * Returned indices identify the actual interval in data; only prices before end carry weight.
     * @param _queryId Feed whose stored history supplies the average.
     * @param _relayCutoffSeconds Exclusive EVM relay-time cutoff in seconds.
     * @param _minWindowMs Positive minimum aggregate-time interval in milliseconds.
     * @return _available Whether the requested interval can be computed.
     * @return _startIndex Inclusive interval-start index, or zero if unavailable.
     * @return _endIndex Interval-end index whose price has zero weight, or zero if unavailable.
     * @return _value Raw time-weighted average rounded down, or zero if unavailable.
     */
    function _getTwapBefore(
        bytes32 _queryId,
        uint256 _relayCutoffSeconds,
        uint256 _minWindowMs
    ) internal view returns (bool _available, uint256 _startIndex, uint256 _endIndex, uint256 _value) {
        if (_minWindowMs == 0) revert InvalidTwapWindow();
        (_available, _endIndex) = _getIndexForRelayBefore(_queryId, _relayCutoffSeconds);
        if (!_available) return (false, 0, 0, 0);

        uint256 _endTimestamp = data[_queryId][_endIndex].aggregateTimestamp;
        if (_endTimestamp < _minWindowMs) return (false, 0, 0, 0);
        uint256 _target = _endTimestamp - _minWindowMs;
        if (data[_queryId][0].aggregateTimestamp > _target) return (false, 0, 0, 0);

        uint256 _upper = _endIndex;
        // The first observation is eligible. Keep the newest eligible start inside [_startIndex, _upper].
        // Rounding the midpoint up ensures progress when only two indices remain.
        while (_startIndex < _upper) {
            uint256 _middle = _startIndex + (_upper - _startIndex + 1) / 2;
            if (data[_queryId][_middle].aggregateTimestamp <= _target) {
                _startIndex = _middle;
            } else {
                _upper = _middle - 1;
            }
        }

        // Positive minimum window guarantees _startIndex < _endIndex and a nonzero denominator.
        // Cumulative subtraction excludes the endpoint price; division floors the wider average.
        uint256 _weightedSum = cumulativePrice[_queryId][_endIndex] - cumulativePrice[_queryId][_startIndex];
        uint256 _duration = _endTimestamp - data[_queryId][_startIndex].aggregateTimestamp;
        return (true, _startIndex, _endIndex, _weightedSum / _duration);
    }

    /**
     * @dev Checks report bounds, timing and admission policy before verifying bridge attestations.
     * @param _attestData Oracle attestation and report to verify.
     * @param _currentValidatorSet Current validators, ordered to match the signatures.
     * @param _sigs Validator signatures in the same order as _currentValidatorSet.
     */
    function _verifyOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) internal view {
        // Validate on admission so an unsupported stored price cannot poison the next interval.
        if (_attestData.report.timestamp > MAX_AGGREGATE_TIMESTAMP) revert AggregateTimestampOutOfRange();
        if (_attestData.report.value.length < 32) revert InvalidPriceLength();
        uint256 _price = abi.decode(_attestData.report.value, (uint256));
        if (_price == 0 || _price > MAX_SPOT_PRICE) revert PriceOutOfRange();
        // Validate subtraction operands first, preserving the bank's whole-second age policy.
        if (_attestData.report.timestamp / MS_PER_SECOND > block.timestamp) revert ReportTimestampInFuture();
        if (_attestData.attestationTimestamp / MS_PER_SECOND > block.timestamp) revert AttestationTimestampInFuture();
        if (_attestData.report.nextTimestamp / MS_PER_SECOND > block.timestamp) revert NextTimestampInFuture();
        if (_attestData.attestationTimestamp < _attestData.report.timestamp) revert AttestationBeforeReport();
        // check that the data is not too old
        require(
            block.timestamp - (_attestData.report.timestamp / MS_PER_SECOND) < MAX_DATA_AGE,
            "TellorDataBank: Data too old"
        );
        // check that the attestation is not too old
        require(
            block.timestamp - (_attestData.attestationTimestamp / MS_PER_SECOND) < MAX_ATTESTATION_AGE,
            "TellorDataBank: Attestation too old"
        );
        // check that timestamps are monotonically increasing
        AggregateData memory _previousData = _getCurrentAggregateData(_attestData.queryId);
        if (data[_attestData.queryId].length > 0) {
            require(
                _attestData.report.timestamp > _previousData.aggregateTimestamp,
                "TellorDataBank: Report timestamp must increase"
            );
            require(_previousData.relayTimestamp < block.timestamp, "TellorDataBank: Only one relay per block");
        }
        // check if there's a more recent optimistic report available
        if (_attestData.report.nextTimestamp != 0) {
            require(
                block.timestamp - (_attestData.report.nextTimestamp / MS_PER_SECOND) < OPTIMISTIC_DELAY,
                "TellorDataBank: More recent optimistic report available"
            );
        }
        // handle optimistic vs consensus data verification
        if (_attestData.report.timestamp != _attestData.report.lastConsensusTimestamp) {
            // using optimistic data - additional checks required
            require(
                _attestData.report.lastConsensusTimestamp < _attestData.report.timestamp,
                "TellorDataBank: Newer consensus data available"
            );
            require(
                (_attestData.attestationTimestamp - _attestData.report.timestamp) / MS_PER_SECOND >= OPTIMISTIC_DELAY,
                "TellorDataBank: Dispute period not passed"
            );
            require(
                _attestData.report.aggregatePower > dataBridge.powerThreshold() / 2,
                "TellorDataBank: Insufficient optimistic report power"
            );
        }
        // verify signatures and data integrity through the data bridge
        dataBridge.verifyOracleData(_attestData, _currentValidatorSet, _sigs);
    }
}
