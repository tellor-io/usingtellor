// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import { IPriceSource } from "../interfaces/IPriceSource.sol";

/**
 * @notice TEST ONLY: source whose read consumes a configurable amount of gas.
 * @dev A zero configured value returns the gas received at entry instead, exposing the forwarded budget.
 */
contract GasConsumingSourceMock is IPriceSource {
    uint256 public gasToConsume;
    uint256 public timestampMs;
    uint256 public value;

    function configure(uint256 _value, uint256 _timestampMs, uint256 _gasToConsume) external {
        value = _value;
        timestampMs = _timestampMs;
        gasToConsume = _gasToConsume;
    }

    function decimals() external pure override returns (uint8) {
        return 18;
    }

    function getCurrentValue() external view override returns (uint256, uint256) {
        uint256 _entryGas = gasleft();
        uint256 _gasToConsume = gasToConsume;
        while (_entryGas - gasleft() < _gasToConsume) {}
        return (value == 0 ? _entryGas : value, timestampMs);
    }
}
