// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

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
    error ChallengeAlreadyPending();
    error ChallengeDelayNotElapsed();
    error DataBankChangeDelayNotElapsed();
    error DataBankChangePending();
    error DataBankHasNoCode();
    error DataBankUnchanged();
    error DiagnosticUnavailable();
    error InvalidAdmin();
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
    error NoPendingChallenge();
    error NoPendingDataBankChange();
    error NoPendingRecovery();
    error NoTwapData();
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
    /// @dev Primary returns the TWAP interval-end timestamp; backup returns spot aggregate time.
    /// Both are delayed DataBank reads. Never substitutes relay, switch, or read time.
    /// Endpoint age does not bound TWAP contributor age. Paused reads revert.
    /// @return value The selected source's price, without adaptor-specific scaling.
    /// @return aggregateTimestamp The selected source's timestamp in milliseconds.
    function getCurrentValue() external view returns (uint256 value, uint256 aggregateTimestamp);

    /// @notice Returns the immutable Tellor query ID curated by this Shepherd.
    function queryId() external view returns (bytes32);
}
