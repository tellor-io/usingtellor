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
    event ChallengeExecuted(address indexed caller);
    event ChallengeExpired(address indexed caller);
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
    event ThresholdChangeCancelled(uint256 proposedThresholdBps);
    event ThresholdChanged(uint256 previousThresholdBps, uint256 newThresholdBps);
    event ThresholdChangeProposed(uint256 proposedThresholdBps, uint256 proposedAt);
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
    error InvalidChallengeDelay();
    error InvalidChallengeThreshold();
    error InvalidMaxPriceAge();
    error InvalidParamChangeDelay();
    error InvalidPauser();
    error InvalidQueryId();
    error InvalidRecoveryDelay();
    error InvalidRelayReadDelay();
    error InvalidTimestamp();
    error InvalidTwapReference();
    error InvalidTwapWindow();
    error InvalidValueLength();
    error NoMatureData();
    error NoNewerReport();
    error NoPendingBackupChange();
    error NoPendingChallenge();
    error NoPendingDataBankChange();
    error NoPendingRecovery();
    error NoPendingThresholdChange();
    error NotAdmin();
    error NotAuthorizedToPause();
    error NotBackupMode();
    error NotDeviating();
    error NotPaused();
    error NotPauser();
    error NotPrimaryMode();
    error PriceOutOfRange();
    error RecoveryAlreadyPending();
    error RecoveryDelayNotElapsed();
    error RecoveryNotAllowed();
    error RecoveryStillAllowed();
    error ShepherdPaused();
    error StalePrice();
    error StillDeviating();
    error ThresholdChangeDelayNotElapsed();
    error ThresholdChangePending();
    error ThresholdUnchanged();
    error ZeroValue();

    // Getter functions

    /// @notice Returns the immutable source price precision; no rescaling is performed.
    function decimals() external view returns (uint8);

    /// @notice Returns the selected source's value and timestamp, or reverts if the read is unavailable.
    /// @dev Preserves the primary aggregate timestamp or the backup-supplied timestamp;
    /// never substitutes relay, switch, or read time. Paused reads and zero, future,
    /// or over-age timestamps revert. Exact maximum age is allowed.
    /// @return value The selected source's price, without adaptor-specific scaling.
    /// @return aggregateTimestamp The selected source's timestamp in milliseconds.
    function getCurrentValue() external view returns (uint256 value, uint256 aggregateTimestamp);

    /// @notice Reads with the same freshness and pause policy as getCurrentValue.
    /// @dev Source timestamps are floored to seconds. Round IDs are zero sentinels;
    /// historical Chainlink rounds are not supported. Prices must fit a positive int256.
    /// @return roundId Zero sentinel; historical rounds are unsupported.
    /// @return answer Positive selected-source price in the configured decimals.
    /// @return startedAt Source timestamp floored to seconds.
    /// @return updatedAt The same source timestamp floored to seconds.
    /// @return answeredInRound Zero sentinel; historical rounds are unsupported.
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );

    /// @notice Returns the immutable Tellor query ID curated by this Shepherd.
    function queryId() external view returns (bytes32);
}
