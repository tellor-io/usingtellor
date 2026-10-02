// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IBackupOracle} from "../interfaces/IBackupOracle.sol";

/**
 * @title BackupOracleMock
 * @notice TEST ONLY: unauthenticated configurable responses, never a production backup.
 * @dev Setters intentionally accept arbitrary prices, timestamps, and recovery results
 * to exercise consumer failures. They provide no evidence of price or primary health.
 */
contract BackupOracleMock is IBackupOracle {
    enum Behavior { Normal, Revert, Malformed }

    bytes32 public immutable queryId;
    uint256 public value;
    uint256 public timestamp;
    bool public recoveryAllowed;
    Behavior public readBehavior = Behavior.Revert;
    Behavior public recoveryBehavior;

    error ReadUnavailable();
    error RecoveryUnavailable();
    error UnsupportedQueryId();

    constructor(bytes32 _queryId) {
        queryId = _queryId;
    }

    /// @notice Configures read output, including deliberately invalid observations.
    function configureRead(uint256 _value, uint256 _timestamp, Behavior _behavior) external {
        value = _value;
        timestamp = _timestamp;
        readBehavior = _behavior;
    }

    /// @notice Configures recovery output independently of read availability.
    function configureRecovery(bool _allowed, Behavior _behavior) external {
        recoveryAllowed = _allowed;
        recoveryBehavior = _behavior;
    }

    function getCurrentValue(bytes32 _queryId) external view override returns (uint256, uint256) {
        if (_queryId != queryId) revert UnsupportedQueryId();
        if (readBehavior == Behavior.Revert) revert ReadUnavailable();
        if (readBehavior == Behavior.Malformed) {
            // Fault injection: a successful EVM call with no ABI-encoded return values.
            assembly { return(0, 0) }
        }
        return (value, timestamp);
    }

    function canRecover(bytes32 _queryId) external view override returns (bool) {
        if (_queryId != queryId) revert UnsupportedQueryId();
        if (recoveryBehavior == Behavior.Revert) revert RecoveryUnavailable();
        if (recoveryBehavior == Behavior.Malformed) {
            // Fault injection only; the production interface requires an encoded bool.
            assembly { return(0, 0) }
        }
        return recoveryAllowed;
    }
}
