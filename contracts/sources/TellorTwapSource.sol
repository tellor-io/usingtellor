// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IPriceSource} from "../interfaces/IPriceSource.sol";
import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";

/**
 * @title TellorTwapSource
 * @notice Per-feed reader of a delayed DataBank TWAP, preserving its actual interval.
 * @dev Returns the bank's raw average without rescaling or recomputing its arithmetic.
 * The deployer must bind the correct query, base/quote direction, and actual precision.
 * Metadata and consistency checks do not authenticate a bank or independently verify its math.
 */
contract TellorTwapSource is IPriceSource {
    // Immutables
    ITellorDataBank public immutable dataBank;
    bytes32 public immutable override queryId;
    uint8 public immutable override decimals;
    uint256 public immutable RELAY_READ_DELAY;
    uint256 public immutable TWAP_WINDOW_MS;

    // Errors
    error DataBankHasNoCode();
    error InvalidQueryId();
    error InvalidDecimals();
    error InvalidRelayReadDelay();
    error InvalidTwapWindow();
    error NoTwapData();
    error InvalidTwapReference();
    error InvalidTimestamp();

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
     * @return value Raw quote units per whole base unit, scaled by decimals().
     * @return timestampMs Original TWAP interval end, never relay time or read time.
     */
    function getCurrentValue() external view override returns (uint256 value, uint256 timestampMs) {
        if (block.timestamp <= RELAY_READ_DELAY) revert NoTwapData();
        uint256 cutoff = block.timestamp - RELAY_READ_DELAY;
        (bool available, ITellorDataBank.TwapData memory twap) =
            dataBank.getTwapBefore(queryId, cutoff, TWAP_WINDOW_MS);
        if (!available) revert NoTwapData();
        if (twap.endTimestamp == 0 || twap.endTimestamp > block.timestamp * 1000) revert InvalidTimestamp();
        if (twap.value == 0 || twap.startIndex >= twap.endIndex
            || twap.startTimestamp >= twap.endTimestamp) revert InvalidTwapReference();
        if (twap.observationCount != twap.endIndex - twap.startIndex
            || twap.endTimestamp - twap.startTimestamp < TWAP_WINDOW_MS) revert InvalidTwapReference();

        ITellorDataBank.AggregateData memory start = dataBank.getAggregateByIndex(queryId, twap.startIndex);
        ITellorDataBank.AggregateData memory end = dataBank.getAggregateByIndex(queryId, twap.endIndex);
        (bool found, ITellorDataBank.AggregateData memory selectedEnd) = dataBank.getRelayBefore(queryId, cutoff);
        if (!found || start.aggregateTimestamp != twap.startTimestamp
            || end.aggregateTimestamp != twap.endTimestamp
            || selectedEnd.aggregateTimestamp != twap.endTimestamp
            || selectedEnd.relayTimestamp != end.relayTimestamp
            || end.relayTimestamp >= cutoff) revert InvalidTwapReference();

        return (twap.value, twap.endTimestamp);
    }
}
