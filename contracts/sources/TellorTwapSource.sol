// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import { IPriceSource } from "../interfaces/IPriceSource.sol";
import { ITellorDataBank } from "../interfaces/ITellorDataBank.sol";

/**
 * @author Tellor Inc.
 * @title TellorTwapSource
 * @notice Per-feed reader of a delayed DataBank TWAP, preserving its actual interval.
 * @dev Returns the bank's raw average without rescaling or recomputing its arithmetic.
 * The deployer must bind the correct query, base/quote direction, and actual precision.
 * Metadata and consistency checks do not authenticate a bank or independently verify its math.
 */
contract TellorTwapSource is IPriceSource {
    // Immutables
    ITellorDataBank public immutable dataBank;
    bytes32 public immutable queryId;
    uint8 public immutable override decimals;
    uint256 public immutable RELAY_READ_DELAY;
    uint256 public immutable TWAP_WINDOW_MS;

    // Errors
    error DataBankHasNoCode();
    error InvalidDecimals();
    error InvalidQueryId();
    error InvalidRelayReadDelay();
    error InvalidTwapReference();
    error InvalidTwapWindow();
    error NoTwapData();

    /**
     * @notice Binds the source configuration without requiring populated history.
     * @param _dataBank Deployed bank; the deployer is responsible for its ABI and trust.
     * @param _queryId Nonzero Tellor query ID identifying the agreed base/quote feed.
     * @param _decimals Actual raw-price precision, from 0 to 77 so 10 ** decimals fits uint256.
     * This declaration does not convert prices or verify their underlying scale.
     * @param _relayReadDelay Positive delay in seconds, measured from EVM relay time.
     * @param _twapWindowMs Positive minimum interval in aggregate milliseconds.
     */
    constructor(address _dataBank, bytes32 _queryId, uint8 _decimals, uint256 _relayReadDelay, uint256 _twapWindowMs) {
        if (_dataBank.code.length == 0) revert DataBankHasNoCode();
        if (_queryId == bytes32(0)) revert InvalidQueryId();
        if (_decimals > 77) revert InvalidDecimals();
        if (_relayReadDelay == 0) revert InvalidRelayReadDelay();
        if (_twapWindowMs == 0) revert InvalidTwapWindow();

        dataBank = ITellorDataBank(_dataBank);
        queryId = _queryId;
        decimals = _decimals;
        RELAY_READ_DELAY = _relayReadDelay;
        TWAP_WINDOW_MS = _twapWindowMs;
    }

    /**
     * @notice Returns the bank's TWAP and original interval-end timestamp in milliseconds.
     * @dev Endpoint selection requires relayTimestamp < block.timestamp - RELAY_READ_DELAY.
     * The bank holds each price until the next observation and floors the average over
     * the actual interval, which may exceed TWAP_WINDOW_MS. The endpoint has zero weight.
     * Two records with one contributing price suffice. No maximum age, duration, gap,
     * or sampling-quality policy is applied; endpoint recency does not bound contributor age.
     * Missing/inconsistent data reverts without substituting spot; dependency errors propagate.
     * Zero prices and future endpoint timestamps pass through for consumers such as Shepherd to assess.
     * A zero endpoint still cannot satisfy the positive interval and history-consistency checks.
     * @return _value Raw quote units per whole base unit, scaled by decimals().
     * @return _timestampMs Original TWAP interval end, never relay time or read time.
     */
    function getCurrentValue() external view override returns (uint256 _value, uint256 _timestampMs) {
        if (block.timestamp <= RELAY_READ_DELAY) revert NoTwapData();
        uint256 _cutoff = block.timestamp - RELAY_READ_DELAY;
        (bool _available, ITellorDataBank.TwapData memory _twap) = dataBank.getTwapBefore(
            queryId,
            _cutoff,
            TWAP_WINDOW_MS
        );
        if (!_available) revert NoTwapData();
        if (_twap.startIndex >= _twap.endIndex || _twap.startTimestamp >= _twap.endTimestamp)
            revert InvalidTwapReference();
        if (
            _twap.observationCount != _twap.endIndex - _twap.startIndex ||
            _twap.endTimestamp - _twap.startTimestamp < TWAP_WINDOW_MS
        ) revert InvalidTwapReference();

        ITellorDataBank.AggregateData memory _start = dataBank.getAggregateByIndex(queryId, _twap.startIndex);
        ITellorDataBank.AggregateData memory _end = dataBank.getAggregateByIndex(queryId, _twap.endIndex);
        (bool _found, ITellorDataBank.AggregateData memory _selectedEnd) = dataBank.getRelayBefore(queryId, _cutoff);
        if (
            !_found ||
            _start.aggregateTimestamp != _twap.startTimestamp ||
            _end.aggregateTimestamp != _twap.endTimestamp ||
            _selectedEnd.aggregateTimestamp != _twap.endTimestamp ||
            _selectedEnd.relayTimestamp != _end.relayTimestamp ||
            _end.relayTimestamp >= _cutoff
        ) revert InvalidTwapReference();

        return (_twap.value, _twap.endTimestamp);
    }
}
