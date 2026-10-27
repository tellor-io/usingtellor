// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";
import {TellorShepherd} from "../databank/TellorShepherd.sol";

/**
 * @notice TEST ONLY: exposes internal backup, TWAP, and deviation helpers for focused tests.
 * @dev Helpers bypass consumer pause/freshness policy and are not consumer oracle endpoints.
 */
contract TellorShepherdHarness is TellorShepherd {
    constructor(Configuration memory _configuration) TellorShepherd(_configuration) {}

    // TEST ONLY: isolate mode guards without executing a production challenge.
    function setModeForTest(Mode _mode) external {
        mode = _mode;
    }

    function readDeviation() external view returns (bool available, bool deviating) {
        (available, deviating,,) = _readDeviation();
    }

    function readBackup() external view returns (uint256 value, uint256 timestamp) {
        return _readBackup();
    }

    function readTwapReference() external view returns (bool available, ITellorDataBank.TwapData memory twap) {
        return _readTwapReference();
    }
}
