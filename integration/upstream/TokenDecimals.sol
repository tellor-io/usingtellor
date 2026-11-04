// SPDX-License-Identifier: MIT
pragma solidity 0.8.21;

/// @notice Test-only token metadata; no balances, transfers or vault operations are exercised.
contract TokenDecimals {
    uint8 public immutable decimals;
    constructor(uint8 value) { decimals = value; }
}
