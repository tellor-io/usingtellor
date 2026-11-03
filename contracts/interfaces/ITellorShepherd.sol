// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IPriceSource} from "./IPriceSource.sol";

/**
 * @title ITellorShepherd
 * @notice Consumer reads, events, and errors for a per-feed Tellor safety layer.
 */
interface ITellorShepherd {
    // Events
    event ChallengeCancelled(address indexed caller);
    event ChallengeExecuted(address indexed caller);
    event ChallengeInvalidated();
    event ChallengeRequested(address indexed caller, uint256 requestedAt);
    event SourcesChangeCancelled(address indexed proposedPrimary, address indexed proposedBackup);
    event SourcesChanged(address previousPrimary, address previousBackup, address indexed newPrimary, address indexed newBackup);
    event SourcesChangeProposed(address indexed proposedPrimary, address indexed proposedBackup, uint256 proposedAt);
    event Paused(address indexed caller);
    event PauserAdded(address indexed pauser);
    event PauserRemoved(address indexed pauser);
    event RecoveryCancelled(address indexed caller);
    event RecoveryExecuted(address indexed caller);
    event RecoveryInvalidated();
    event RecoveryRequested(address indexed caller, uint256 requestedAt);
    event Unpaused(address indexed caller);

    // Errors
    error AlreadyPaused();
    error AlreadyPauser();
    error ChallengeAlreadyPending();
    error ChallengeDelayNotElapsed();
    error SourcesChangeDelayNotElapsed();
    error SourcesChangePending();
    error SourceHasNoCode();
    error SourcesUnchanged();
    error InvalidAdmin();
    error InvalidChallengeDelay();
    error InvalidChallengeThreshold();
    error InvalidSourcesChangeDelay();
    error InvalidMinPauseDuration();
    error InvalidPauser();
    error InvalidQueryId();
    error InvalidDecimals();
    error InvalidTimestamp();
    error SourceQueryIdMismatch();
    error SourceDecimalsMismatch();
    error InvalidRecoveryDelay();
    error NoPendingChallenge();
    error NoPendingSourcesChange();
    error NoPendingRecovery();
    error NotAdmin();
    error NotAuthorizedToPause();
    error NotBackupMode();
    error NotDeviating();
    error NotPaused();
    error NotPauser();
    error NotPrimaryMode();
    error PauseDurationNotElapsed();
    error RecoveryAlreadyPending();
    error RecoveryDelayNotElapsed();
    error RecoveryNotAllowed();
    error RecoveryStillAllowed();
    error ShepherdPaused();
    error StillDeviating();
    error ZeroValue();

    // Getter functions

    /// @notice Returns only the selected source's nonzero value and original millisecond timestamp.
    /// @dev Paused, failed, zero/future timestamp reads revert. No automatic fallback or maximum age check.
    /// A TWAP endpoint does not establish contributor freshness. No adaptor-specific rescaling occurs.
    function getCurrentValue() external view returns (uint256 value, uint256 aggregateTimestamp);

    /// @notice Returns the immutable agreed base/quote identifier.
    function queryId() external view returns (bytes32);

    /// @notice Returns the immutable source price precision.
    function decimals() external view returns (uint8);

    function primarySource() external view returns (IPriceSource);
    function backupSource() external view returns (IPriceSource);
}
