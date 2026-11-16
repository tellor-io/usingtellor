// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IPriceSource} from "../interfaces/IPriceSource.sol";

/**
 * @notice TEST ONLY: a source with no queryId selector or fallback.
 */
contract PriceSourceWithoutQueryIdMock is IPriceSource {
    uint8 public immutable override decimals;
    uint256 private immutable value;
    uint256 private immutable timestampMs;

    error ReadUnavailable();

    constructor(uint8 _decimals, uint256 _value, uint256 _timestampMs) {
        decimals = _decimals;
        value = _value;
        timestampMs = _timestampMs;
    }

    function getCurrentValue() external view override returns (uint256, uint256) {
        if (value == 0) revert ReadUnavailable();
        return (value, timestampMs);
    }
}
