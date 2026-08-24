// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title ITellorDataBank
 * @notice Interface for reading verified SpotPrice history and aggregate-time TWAPs.
 */
interface ITellorDataBank {
    struct AggregateData {
        bytes value;
        uint256 power;
        uint256 aggregateTimestamp;
        uint256 attestationTimestamp;
        uint256 relayTimestamp;
        uint256 cumulativePrice;
    }

    struct TwapData {
        uint256 price;
        uint256 startAggregateTimestamp;
        uint256 endAggregateTimestamp;
        uint256 observationCount;
    }

    function MAX_SPOT_PRICE() external view returns (uint256);

    function getCurrentAggregateData(bytes32 queryId)
        external
        view
        returns (AggregateData memory aggregateData);

    function getAggregateByIndex(bytes32 queryId, uint256 index)
        external
        view
        returns (AggregateData memory aggregateData);

    function getAggregateValueCount(bytes32 queryId)
        external
        view
        returns (uint256);

    function getRelayBefore(bytes32 queryId, uint256 timestamp)
        external
        view
        returns (bool found, AggregateData memory aggregateData);

    function getIndexForRelayBefore(bytes32 queryId, uint256 timestamp)
        external
        view
        returns (bool found, uint256 index);

    /**
     * @notice Returns a TWAP ending immediately before the latest stored value.
     * @dev `window` and returned timestamps use Tellor aggregate-time milliseconds.
     */
    function getTwap(bytes32 queryId, uint256 window)
        external
        view
        returns (bool found, TwapData memory twapData);

    /**
     * @notice Returns a TWAP ending immediately before the value at `endIndex`
     * @dev `window` and returned timestamps use Tellor aggregate-time milliseconds.
     */
    function getTwapAt(bytes32 queryId, uint256 endIndex, uint256 window)
        external
        view
        returns (bool found, TwapData memory twapData);

    /**
     * @notice Selects a relay by EVM time and calculates its preceding aggregate-time TWAP.
     */
    function getRelayWithTwapBefore(
        bytes32 queryId,
        uint256 relayCutoff,
        uint256 window
    )
        external
        view
        returns (
            bool found,
            uint256 index,
            AggregateData memory aggregateData,
            TwapData memory twapData
        );
}
