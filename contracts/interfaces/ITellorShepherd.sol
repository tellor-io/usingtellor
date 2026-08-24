// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/// @notice Consumer-facing interface for a view-first Tellor price oracle.
interface ITellorShepherd {
    enum Status {
        UNAVAILABLE,
        NORMAL,
        RECOVERY,
        PAUSED,
        INVALID_PRICE,
        INVALID_COVERAGE,
        DEVIATING
    }

    struct PricePreview {
        Status status;
        uint256 candidateIndex;
        uint256 candidateValue;
        uint256 candidateAggregateTimestamp;
        uint256 candidateRelayTimestamp;
        uint256 twap;
        uint256 deviationBps;
        uint256 twapStartTimestamp;
        uint256 twapEndTimestamp;
        uint256 observationCount;
    }

    /// @notice Returns the current validated price or the latched recovery snapshot.
    /// @return value SpotPrice with 18 decimals.
    /// @return aggregateTimestamp Tellor aggregate timestamp in milliseconds.
    function getCurrentValue()
        external
        view
        returns (uint256 value, uint256 aggregateTimestamp);

    /// @notice Describes what `getCurrentValue` would return and why it may be unavailable.
    function previewValue() external view returns (PricePreview memory preview);
}
