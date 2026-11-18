// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import { IPriceSource } from "../interfaces/IPriceSource.sol";
import { ITellorDataBank } from "../interfaces/ITellorDataBank.sol";

/**
 * @author Tellor Inc.
 * @title TellorSpotSource
 * @notice Per-feed Tellor spot reader with an immutable optional relay delay.
 * @dev Returns the bank's raw price without rescaling. The deployer must bind the
 * correct query, base/quote direction, and actual precision; code presence and
 * declared metadata establish neither authenticity nor observation quality.
 */
contract TellorSpotSource is IPriceSource {
    // Immutables
    ITellorDataBank public immutable dataBank;
    bytes32 public immutable queryId;
    uint8 public immutable override decimals;
    uint256 public immutable RELAY_READ_DELAY;

    // Errors
    error DataBankHasNoCode();
    error InvalidDecimals();
    error InvalidQueryId();
    error InvalidValueLength();
    error NoData();

    /**
     * @notice Binds the source configuration without requiring populated history.
     * @param _dataBank Deployed bank; the deployer is responsible for its ABI and trust.
     * @param _queryId Nonzero Tellor query ID identifying the agreed base/quote feed.
     * @param _decimals Actual raw-price precision, from 0 to 77 so 10 ** decimals fits uint256.
     * This declaration does not convert prices or verify their underlying scale.
     * @param _relayReadDelay Delay in seconds; zero still excludes current-block relays.
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
     * @dev Requires relayTimestamp < block.timestamp - RELAY_READ_DELAY, including at zero delay.
     * Zero delay selects the newest relay strictly before the current block's timestamp.
     * Missing data, short payloads and dependency failures revert without searching for an older price.
     * Trailing payload bytes are accepted. Zero prices and zero/future timestamps pass through;
     * consumers such as Shepherd enforce price usability and maximum age.
     * @return _value Raw quote units per whole base unit, scaled by decimals().
     * @return _timestampMs Original spot aggregate time, never relay time or read time.
     */
    function getCurrentValue() external view override returns (uint256 _value, uint256 _timestampMs) {
        ITellorDataBank.AggregateData memory _record;
        if (block.timestamp <= RELAY_READ_DELAY) revert NoData();
        bool _found;
        (_found, _record) = dataBank.getRelayBefore(queryId, block.timestamp - RELAY_READ_DELAY);
        if (!_found) revert NoData();
        if (_record.value.length < 32) revert InvalidValueLength();
        _value = abi.decode(_record.value, (uint256));
        _timestampMs = _record.aggregateTimestamp;
    }
}
