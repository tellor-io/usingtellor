// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/// @notice Fallback price source used after a sustained Tellor/TWAP deviation.
interface IBackupOracle {
    /// @notice Returns the backup price and its observation timestamp.
    function getCurrentValue()
        external
        view
        returns (uint256 value, uint256 timestamp);

    /// @notice True when Shepherd may switch back to the primary Tellor path.
    function readyToReturn() external view returns (bool);
}
