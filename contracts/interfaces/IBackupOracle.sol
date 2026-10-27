// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title IBackupOracle
 * @notice Query-addressed backup source and primary recovery assessment.
 * @dev Implementations define source trust, timestamp meaning, and recovery authority.
 */
interface IBackupOracle {
    // Getter functions

    /// @notice Returns whether recovery to the specified feed's primary is permitted.
    /// @dev False or a revert must not authorize recovery.
    /// Permission may express an admin decision rather than computed health evidence.
    /// The backup owns primary identification; this call supplies no bank or read delay.
    /// Integration must ensure assessment remains relevant after primary migration.
    /// @param _queryId Feed whose primary is being assessed.
    function canRecover(bytes32 _queryId) external view returns (bool);

    /// @notice Returns a source observation, or reverts when unavailable.
    /// @dev Implementations must document timestamp meaning. The trusted-streamer example
    /// returns submission time; it does not establish underlying observation freshness.
    /// Shepherd preserves the supplied timestamp and enforces its configured maximum age.
    /// @param _queryId Requested feed; unavailable or unsupported feeds must revert.
    /// @return value Nonzero price in the primary feed's units and scaling.
    /// @return timestamp Source-defined timestamp in milliseconds; never refreshed on reads.
    function getCurrentValue(bytes32 _queryId) external view returns (uint256 value, uint256 timestamp);
}
