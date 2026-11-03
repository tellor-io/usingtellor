// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IPriceSource} from "../interfaces/IPriceSource.sol";
import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";

/**
 * @title TellorSpotSource
 * @notice Per-feed Tellor spot reader with an immutable optional relay delay.
 * @dev Returns the bank's raw price without rescaling. The deployer must bind the
 * correct query, base/quote direction, and actual precision; code presence and
 * declared metadata establish neither authenticity nor observation quality.
 */
contract TellorSpotSource is IPriceSource {
    // Immutables
    ITellorDataBank public immutable dataBank;
    bytes32 public immutable override queryId;
    uint8 public immutable override decimals;
    uint256 public immutable RELAY_READ_DELAY;

    // Errors
    error DataBankHasNoCode();
    error InvalidQueryId();
    error InvalidDecimals();
    error NoData();
    error InvalidValueLength();
    error ZeroValue();
    error InvalidTimestamp();

    /**
     * @notice Binds the source configuration without requiring populated history.
     * @param _dataBank Deployed bank; the deployer is responsible for its ABI and trust.
     * @param _queryId Nonzero Tellor query ID identifying the agreed base/quote feed.
     * @param _decimals Actual raw-price precision, from 0 to 77 so 10 ** decimals fits uint256.
     * This declaration does not convert prices or verify their underlying scale.
     * @param _relayReadDelay Delay in seconds; zero explicitly selects latest reports.
     */
    constructor(address _dataBank, bytes32 _queryId, uint8 _decimals, uint256 _relayReadDelay) {
        if (_dataBank.code.length == 0) revert DataBankHasNoCode();
        if (_queryId == bytes32(0)) revert InvalidQueryId();
        if (_decimals > 77) revert InvalidDecimals();

        dataBank = ITellorDataBank(_dataBank);
        queryId = _queryId;
        decimals = _decimals;
        RELAY_READ_DELAY = _relayReadDelay;
    }

    /**
     * @notice Returns the selected spot price and original aggregate timestamp in milliseconds.
     * @dev Positive delay requires relayTimestamp < block.timestamp - RELAY_READ_DELAY.
     * Zero delay uses the latest report, including one relayed in the current block.
     * Missing/invalid data reverts without searching for an older valid price; dependency
     * failures propagate. Trailing payload bytes are accepted. No maximum age is enforced.
     * @return value Raw quote units per whole base unit, scaled by decimals().
     * @return timestampMs Original spot aggregate time, never relay time or read time.
     */
    function getCurrentValue() external view override returns (uint256 value, uint256 timestampMs) {
        ITellorDataBank.AggregateData memory record;
        if (RELAY_READ_DELAY == 0) {
            record = dataBank.getCurrentAggregateData(queryId);
            if (record.value.length == 0) revert NoData();
        } else {
            if (block.timestamp <= RELAY_READ_DELAY) revert NoData();
            bool found;
            (found, record) = dataBank.getRelayBefore(queryId, block.timestamp - RELAY_READ_DELAY);
            if (!found) revert NoData();
        }

        if (record.value.length < 32) revert InvalidValueLength();
        value = abi.decode(record.value, (uint256));
        if (value == 0) revert ZeroValue();
        timestampMs = record.aggregateTimestamp;
        if (timestampMs == 0 || timestampMs > block.timestamp * 1000) revert InvalidTimestamp();
    }
}
