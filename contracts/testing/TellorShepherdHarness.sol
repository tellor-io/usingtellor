// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";
import {TellorShepherd} from "../databank/TellorShepherd.sol";

/**
 * @notice TEST ONLY: exposes internal backup, TWAP, and deviation helpers for focused tests.
 * @dev Helpers bypass consumer pause policy and are not consumer oracle endpoints.
 */
contract TellorShepherdHarness is TellorShepherd {
    constructor(
        bytes32 _queryId,
        address _dataBank,
        address _backupOracle,
        address _admin,
        uint256 _relayReadDelay,
        uint256 _minPauseDuration,
        uint256 _dataBankChangeDelay,
        uint256 _backupChangeDelay,
        uint256 _twapWindowMs,
        uint256 _challengeThresholdBps,
        uint256[2] memory _transitionDelaysSeconds
    ) TellorShepherd(
        _queryId, _dataBank, _backupOracle, _admin,
        _relayReadDelay, _minPauseDuration, _dataBankChangeDelay, _backupChangeDelay, _twapWindowMs,
        _challengeThresholdBps, _transitionDelaysSeconds
    ) {}

    // TEST ONLY: isolate mode guards without executing a production challenge.
    function setModeForTest(Mode _mode) external {
        mode = _mode;
    }

    function readDeviation() external view returns (bool available, bool deviating) {
        return _readDeviation();
    }

    function readBackup() external view returns (uint256 value, uint256 timestamp) {
        return _readBackup();
    }

    function readTwapReference() external view returns (bool available, ITellorDataBank.TwapData memory twap) {
        return _readTwapReference();
    }
}
