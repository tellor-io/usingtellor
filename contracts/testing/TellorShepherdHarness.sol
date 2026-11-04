// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {TellorShepherd} from "../databank/TellorShepherd.sol";

/**
 * @notice TEST ONLY: exposes mode and deviation for focused control tests.
 */
contract TellorShepherdHarness is TellorShepherd {
    // Constructor

    constructor(
        bytes32 _queryId, uint8 _decimals, address _primary, address _backup, address _admin,
        uint256 _minPauseDuration, uint256 _configChangeDelay, uint256 _threshold,
        uint256[2] memory _delays, uint256 _maxDataAge
    ) TellorShepherd(_queryId, _decimals, _primary, _backup, _admin,
        _minPauseDuration, _configChangeDelay, _threshold, _delays, _maxDataAge) {}

    // State-changing functions

    function setModeForTest(Mode _mode) external { mode = _mode; }

    // Getter functions

    function readDeviation() external view returns (bool) { return _readDeviation(); }
}
