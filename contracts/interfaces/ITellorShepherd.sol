// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title ITellorShepherd
 * @notice Consumer reads, events, and errors for a per-feed Tellor safety layer.
 */
interface ITellorShepherd {
    // Events
    event BackupChangeCancelled(address indexed proposedBackup);
    event BackupChanged(address indexed previousBackup, address indexed newBackup);
    event BackupChangeProposed(address indexed proposedBackup, uint256 proposedAt);
    event ChallengeCancelled(address indexed caller);
    event ChallengeExecuted(address indexed caller);
    event ChallengeInvalidated();
    event ChallengeRequested(address indexed caller, uint256 requestedAt);
    event DataBankChangeCancelled(address indexed proposedBank);
    event DataBankChanged(address indexed previousBank, address indexed newBank);
    event DataBankChangeProposed(address indexed proposedBank, uint256 proposedAt);
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
    error BackupChangeDelayNotElapsed();
    error BackupChangePending();
    error BackupHasNoCode();
    error BackupOracleHasNoCode();
    error BackupUnchanged();
    error ChallengeAlreadyPending();
    error ChallengeDelayNotElapsed();
    error DataBankChangeDelayNotElapsed();
    error DataBankChangePending();
    error DataBankHasNoCode();
    error DataBankUnchanged();
    error DiagnosticUnavailable();
    error InvalidAdmin();
    error InvalidBackupChangeDelay();
    error InvalidChallengeDelay();
    error InvalidChallengeThreshold();
    error InvalidDataBankChangeDelay();
    error InvalidMinPauseDuration();
    error InvalidPauser();
    error InvalidQueryId();
    error InvalidRecoveryDelay();
    error InvalidRelayReadDelay();
    error InvalidTwapReference();
    error InvalidTwapWindow();
    error InvalidValueLength();
    error NoMatureData();
    error NoPendingBackupChange();
    error NoPendingChallenge();
    error NoPendingDataBankChange();
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

    /// @notice Returns the selected source's value and timestamp, or reverts if the read is unavailable.
    /// @dev Preserves the primary aggregate timestamp or the backup-supplied timestamp;
    /// never substitutes relay, submission, switch, or read time. Paused reads revert.
    /// @return value The selected source's price, without adaptor-specific scaling.
    /// @return aggregateTimestamp The selected source's timestamp in milliseconds.
    function getCurrentValue() external view returns (uint256 value, uint256 aggregateTimestamp);

    /// @notice Returns the immutable Tellor query ID curated by this Shepherd.
    function queryId() external view returns (bytes32);
}
