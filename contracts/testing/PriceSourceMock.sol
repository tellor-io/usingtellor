// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IPriceSource} from "../interfaces/IPriceSource.sol";

/**
 * @notice TEST ONLY: configurable protocol-neutral source and metadata faults.
 * @dev Mutable metadata deliberately violates IPriceSource's semantic contract to
 * test migration rechecks. No setter authenticates prices or proves source quality.
 */
contract PriceSourceMock is IPriceSource {
    bytes32 public override queryId;
    uint8 public override decimals;
    uint256 public value;
    uint256 public timestampMs;
    uint8 public behavior = 1; // 0: return, 1: revert, 2: malformed ABI.

    error ReadUnavailable();

    constructor(bytes32 _queryId, uint8 _decimals) {
        queryId = _queryId;
        decimals = _decimals;
    }

    function configureMetadata(bytes32 _queryId, uint8 _decimals) external {
        queryId = _queryId;
        decimals = _decimals;
    }

    function configureRead(uint256 _value, uint256 _timestampMs, uint8 _behavior) external {
        value = _value;
        timestampMs = _timestampMs;
        behavior = _behavior;
    }

    function getCurrentValue() external view override returns (uint256, uint256) {
        if (behavior == 1) revert ReadUnavailable();
        if (behavior == 2) {
            assembly { return(0, 0) }
        }
        return (value, timestampMs);
    }
}
