// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IBackupOracle} from "../interfaces/IBackupOracle.sol";

/**
 * @title ManualBackupOracle
 * @notice Admin-set price source that Shepherd can switch to after a challenge.
 */
contract ManualBackupOracle is IBackupOracle {
    address public admin;
    uint256 public value;
    uint256 public lastUpdatedAt;
    bool public readyToReturn;

    error NotAdmin();
    error InvalidAdmin();
    error PriceUnset();

    event ValueSet(uint256 value, uint256 timestamp);
    event ReadyToReturnSet(bool ready);

    constructor(address _admin) {
        if (_admin == address(0)) revert InvalidAdmin();
        admin = _admin;
    }

    function setValue(uint256 _value) external {
        if (msg.sender != admin) revert NotAdmin();
        value = _value;
        lastUpdatedAt = block.timestamp;
        if (readyToReturn) {
            readyToReturn = false;
            emit ReadyToReturnSet(false);
        }
        emit ValueSet(_value, lastUpdatedAt);
    }

    function setReadyToReturn(bool _ready) external {
        if (msg.sender != admin) revert NotAdmin();
        readyToReturn = _ready;
        emit ReadyToReturnSet(_ready);
    }

    function getCurrentValue()
        external
        view
        override
        returns (uint256, uint256)
    {
        if (lastUpdatedAt == 0) revert PriceUnset();
        return (value, lastUpdatedAt);
    }
}
