// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {TellorDataBank} from "../databank/TellorDataBank.sol";
import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";

/**
 * @notice TEST ONLY: exposes internal interval calculation for focused boundary tests.
 * @dev Uses real bank admission and accumulation; provides no history-writing shortcuts.
 */
contract TellorDataBankHarness is TellorDataBank {
    constructor(address _dataBridge) TellorDataBank(_dataBridge) {}

    function calculateTwapBefore(bytes32 _queryId, uint256 _relayCutoffSeconds, uint256 _minWindowMs)
        external
        view
        returns (bool available, uint256 startIndex, uint256 endIndex, uint256 value)
    {
        return _getTwapBefore(_queryId, _relayCutoffSeconds, _minWindowMs);
    }
}

/**
 * @notice TEST ONLY: independently configurable responses for Shepherd consistency checks.
 * @dev This unauthenticated fault double is not a bank implementation or production source.
 */
contract TwapDataBankMock {
    bool private available;
    ITellorDataBank.TwapData private twap;
    uint256 private failureMode;
    mapping(uint256 => ITellorDataBank.AggregateData) private records;
    bool private endFound;
    ITellorDataBank.AggregateData private selectedEnd;
    ITellorDataBank.AggregateData private candidate;
    error TwapUnavailable();

    function configureCandidate(ITellorDataBank.AggregateData calldata _candidate) external {
        candidate = _candidate;
    }

    function getCurrentAggregateData(bytes32) external view returns (ITellorDataBank.AggregateData memory) {
        return candidate;
    }

    function configureTwap(bool _available, ITellorDataBank.TwapData calldata _twap, uint256 _failureMode) external {
        available = _available;
        twap = _twap;
        failureMode = _failureMode;
    }

    function configureRecord(uint256 _index, ITellorDataBank.AggregateData calldata _record) external {
        records[_index] = _record;
    }

    function configureEnd(bool _found, ITellorDataBank.AggregateData calldata _record) external {
        endFound = _found;
        selectedEnd = _record;
    }

    function getTwapBefore(bytes32, uint256, uint256) external view returns (bool, ITellorDataBank.TwapData memory) {
        if (failureMode == 1) revert TwapUnavailable();
        if (failureMode == 2) {
            assembly { return(0, 0) }
        }
        return (available, twap);
    }

    function getAggregateByIndex(bytes32, uint256 _index) external view returns (ITellorDataBank.AggregateData memory) {
        return records[_index];
    }

    function getRelayBefore(bytes32, uint256) external view returns (bool, ITellorDataBank.AggregateData memory) {
        return (endFound, selectedEnd);
    }
}
