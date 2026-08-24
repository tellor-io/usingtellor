// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "../interfaces/ITellorDataBridge.sol";
import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";

/**
 * @title TellorDataBank
 * @notice Verifies and stores Tellor SpotPrice reports and exposes historical TWAP reads.
 * @dev Relay timestamps govern when data became visible on this chain. Aggregate timestamps
 *      govern how long a reported price is weighted in the cumulative-price accumulator.
 */
contract TellorDataBank is ITellorDataBank {
    ITellorDataBridge public immutable dataBridge;
    uint256 public immutable MAX_DATA_AGE;
    uint256 public immutable MAX_ATTESTATION_AGE;
    uint256 public immutable OPTIMISTIC_DELAY;
    uint256 public immutable override MAX_SPOT_PRICE;

    uint256 public constant MS_PER_SECOND = 1000;

    mapping(bytes32 => AggregateData[]) public data;

    event OracleUpdated(bytes32 indexed queryId, OracleAttestationData attestData);

    constructor(
        address _dataBridge,
        uint256 _maxDataAge,
        uint256 _maxAttestationAge,
        uint256 _optimisticDelay,
        uint256 _maxSpotPrice
    ) {
        require(
            _dataBridge != address(0) && _dataBridge.code.length > 0,
            "TellorDataBank: Invalid bridge"
        );
        require(
            _maxSpotPrice > 0 &&
                _maxSpotPrice <= type(uint256).max / type(uint64).max,
            "TellorDataBank: Invalid max price"
        );

        dataBridge = ITellorDataBridge(_dataBridge);
        MAX_DATA_AGE = _maxDataAge;
        MAX_ATTESTATION_AGE = _maxAttestationAge;
        OPTIMISTIC_DELAY = _optimisticDelay;
        MAX_SPOT_PRICE = _maxSpotPrice;
    }

    /**
     * @notice Verifies and stores a Tellor SpotPrice report.
     * @dev Values must be ABI-encoded positive uint256 prices no greater than MAX_SPOT_PRICE.
     */
    function updateOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) external {
        _decodeSpotPrice(_attestData.report.value);
        _verifyOracleData(_attestData, _currentValidatorSet, _sigs);

        AggregateData[] storage _history = data[_attestData.queryId];
        uint256 _cumulativePrice;

        if (_history.length > 0) {
            AggregateData storage _previous = _history[_history.length - 1];
            uint256 _elapsed = _attestData.report.timestamp -
                _previous.aggregateTimestamp;
            uint256 _previousPrice = abi.decode(_previous.value, (uint256));
            _cumulativePrice =
                _previous.cumulativePrice +
                (_previousPrice * _elapsed);
        }

        _history.push(
            AggregateData({
                value: _attestData.report.value,
                power: _attestData.report.aggregatePower,
                aggregateTimestamp: _attestData.report.timestamp,
                attestationTimestamp: _attestData.attestationTimestamp,
                relayTimestamp: block.timestamp,
                cumulativePrice: _cumulativePrice
            })
        );

        emit OracleUpdated(_attestData.queryId, _attestData);
    }

    function getAggregateByIndex(bytes32 _queryId, uint256 _index)
        external
        view
        override
        returns (AggregateData memory)
    {
        return data[_queryId][_index];
    }

    function getAggregateValueCount(bytes32 _queryId)
        external
        view
        override
        returns (uint256)
    {
        return data[_queryId].length;
    }

    function getCurrentAggregateData(bytes32 _queryId)
        external
        view
        override
        returns (AggregateData memory)
    {
        return _getCurrentAggregateData(_queryId);
    }

    function getRelayBefore(bytes32 _queryId, uint256 _timestamp)
        external
        view
        override
        returns (bool _found, AggregateData memory _aggregateData)
    {
        (bool _indexFound, uint256 _index) = getIndexForRelayBefore(
            _queryId,
            _timestamp
        );
        if (!_indexFound) return (false, _emptyAggregateData());
        return (true, data[_queryId][_index]);
    }

    function getIndexForRelayBefore(bytes32 _queryId, uint256 _timestamp)
        public
        view
        override
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

    function getTwapAt(bytes32 _queryId, uint256 _endIndex, uint256 _window)
        external
        view
        override
        returns (bool _found, TwapData memory _twapData)
    {
        return _getTwapAt(_queryId, _endIndex, _window);
    }

    function getTwap(bytes32 _queryId, uint256 _window)
        external
        view
        override
        returns (bool _found, TwapData memory _twapData)
    {
        uint256 _count = data[_queryId].length;
        if (_count == 0) return (false, _emptyTwapData());
        return _getTwapAt(_queryId, _count - 1, _window);
    }

    function getRelayWithTwapBefore(
        bytes32 _queryId,
        uint256 _relayCutoff,
        uint256 _window
    )
        external
        view
        override
        returns (
            bool _found,
            uint256 _index,
            AggregateData memory _aggregateData,
            TwapData memory _twapData
        )
    {
        (bool _relayFound, uint256 _relayIndex) = getIndexForRelayBefore(
            _queryId,
            _relayCutoff
        );
        if (!_relayFound) {
            return (false, 0, _emptyAggregateData(), _emptyTwapData());
        }

        (bool _twapFound, TwapData memory _twap) = _getTwapAt(
            _queryId,
            _relayIndex,
            _window
        );
        if (!_twapFound) {
            return (
                false,
                _relayIndex,
                data[_queryId][_relayIndex],
                _emptyTwapData()
            );
        }

        return (
            true,
            _relayIndex,
            data[_queryId][_relayIndex],
            _twap
        );
    }

    function getRelayTimestampbyQueryIdandIndex(
        bytes32 _queryId,
        uint256 _index
    ) external view returns (uint256) {
        return data[_queryId][_index].relayTimestamp;
    }

    function _getTwapAt(
        bytes32 _queryId,
        uint256 _endIndex,
        uint256 _window
    ) internal view returns (bool _found, TwapData memory _twapData) {
        AggregateData[] storage _history = data[_queryId];
        if (_window == 0 || _endIndex >= _history.length || _endIndex == 0) {
            return (false, _emptyTwapData());
        }

        AggregateData storage _endObservation = _history[_endIndex];
        if (_endObservation.aggregateTimestamp < _window) {
            return (false, _emptyTwapData());
        }

        uint256 _targetTimestamp =
            _endObservation.aggregateTimestamp -
            _window;
        (bool _startFound, uint256 _startIndex) = _getIndexForAggregateAtOrBefore(
            _queryId,
            _targetTimestamp,
            _endIndex
        );
        if (!_startFound || _startIndex == _endIndex) {
            return (false, _emptyTwapData());
        }

        AggregateData storage _startObservation = _history[_startIndex];
        uint256 _elapsed =
            _endObservation.aggregateTimestamp -
            _startObservation.aggregateTimestamp;
        uint256 _cumulativeDelta =
            _endObservation.cumulativePrice -
            _startObservation.cumulativePrice;

        return (
            true,
            TwapData({
                price: _cumulativeDelta / _elapsed,
                startAggregateTimestamp: _startObservation.aggregateTimestamp,
                endAggregateTimestamp: _endObservation.aggregateTimestamp,
                observationCount: _endIndex - _startIndex + 1
            })
        );
    }

    function _getIndexForAggregateAtOrBefore(
        bytes32 _queryId,
        uint256 _timestamp,
        uint256 _endIndex
    ) internal view returns (bool _found, uint256 _index) {
        AggregateData[] storage _history = data[_queryId];
        if (
            _history.length == 0 ||
            _endIndex >= _history.length ||
            _history[0].aggregateTimestamp > _timestamp
        ) {
            return (false, 0);
        }

        uint256 _start;
        uint256 _end = _endIndex;
        while (_start < _end) {
            uint256 _middle = (_start + _end + 1) / 2;
            if (_history[_middle].aggregateTimestamp <= _timestamp) {
                _start = _middle;
            } else {
                _end = _middle - 1;
            }
        }
        return (true, _start);
    }

    function _decodeSpotPrice(bytes calldata _value)
        internal
        view
        returns (uint256 _price)
    {
        require(_value.length == 32, "TellorDataBank: Invalid SpotPrice");
        _price = abi.decode(_value, (uint256));
        require(
            _price > 0 && _price <= MAX_SPOT_PRICE,
            "TellorDataBank: SpotPrice out of range"
        );
    }

    function _getCurrentAggregateData(bytes32 _queryId)
        internal
        view
        returns (AggregateData memory)
    {
        uint256 _count = data[_queryId].length;
        if (_count == 0) return _emptyAggregateData();
        return data[_queryId][_count - 1];
    }

    function _emptyAggregateData()
        internal
        pure
        returns (AggregateData memory)
    {
        return AggregateData(bytes(""), 0, 0, 0, 0, 0);
    }

    function _emptyTwapData() internal pure returns (TwapData memory) {
        return TwapData(0, 0, 0, 0);
    }

    function _verifyOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) internal view {
        uint256 _reportTimestamp =
            _attestData.report.timestamp /
            MS_PER_SECOND;
        uint256 _attestationTimestamp =
            _attestData.attestationTimestamp /
            MS_PER_SECOND;

        require(
            _reportTimestamp <= block.timestamp,
            "TellorDataBank: Report timestamp is in the future"
        );
        require(
            _attestationTimestamp <= block.timestamp,
            "TellorDataBank: Attestation timestamp is in the future"
        );
        require(
            block.timestamp - _reportTimestamp < MAX_DATA_AGE,
            "TellorDataBank: Data too old"
        );
        require(
            block.timestamp - _attestationTimestamp < MAX_ATTESTATION_AGE,
            "TellorDataBank: Attestation too old"
        );

        AggregateData memory _previousData = _getCurrentAggregateData(
            _attestData.queryId
        );
        if (_previousData.aggregateTimestamp > 0) {
            require(
                _attestData.report.timestamp >
                    _previousData.aggregateTimestamp,
                "TellorDataBank: Report timestamp must increase"
            );
        }

        if (_attestData.report.nextTimestamp != 0) {
            uint256 _nextTimestamp =
                _attestData.report.nextTimestamp /
                MS_PER_SECOND;
            require(
                _nextTimestamp <= block.timestamp &&
                    block.timestamp - _nextTimestamp < OPTIMISTIC_DELAY,
                "TellorDataBank: More recent optimistic report available"
            );
        }

        if (
            _attestData.report.timestamp !=
            _attestData.report.lastConsensusTimestamp
        ) {
            require(
                _attestData.attestationTimestamp >=
                    _attestData.report.timestamp,
                "TellorDataBank: Invalid attestation timestamp"
            );
            require(
                _attestData.report.lastConsensusTimestamp <
                    _attestData.report.timestamp,
                "TellorDataBank: Newer consensus data available"
            );
            require(
                (_attestData.attestationTimestamp -
                    _attestData.report.timestamp) /
                    MS_PER_SECOND >=
                    OPTIMISTIC_DELAY,
                "TellorDataBank: Dispute period not passed"
            );
            require(
                _attestData.report.aggregatePower >
                    dataBridge.powerThreshold() /
                    2,
                "TellorDataBank: Insufficient optimistic report power"
            );
        }

        dataBridge.verifyOracleData(
            _attestData,
            _currentValidatorSet,
            _sigs
        );
    }
}
