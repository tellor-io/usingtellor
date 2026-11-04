// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IPriceSource} from "./IPriceSource.sol";

/**
 * @title ITellorShepherd
 * @notice Consumer reads, events, and errors for a per-feed Tellor safety layer.
 */
interface ITellorShepherd {
    // Events
    event AdminChangeCancelled(address indexed proposedAdmin);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);
    event AdminChangeProposed(address indexed proposedAdmin, uint256 proposedAt);
    event ChallengeCancelled(address indexed caller);
    event ChallengeExecuted(address indexed caller);
    event ChallengeInvalidated();
    event ChallengeRequested(address indexed caller, uint256 requestedAt);
    event ChallengeThresholdChangeCancelled(uint256 proposedThresholdBps);
    event ChallengeThresholdChanged(uint256 previousThresholdBps, uint256 newThresholdBps);
    event ChallengeThresholdChangeProposed(uint256 proposedThresholdBps, uint256 proposedAt);
    event MinPauseDurationChangeCancelled(uint256 proposedDuration);
    event MinPauseDurationChanged(uint256 previousDuration, uint256 newDuration);
    event MinPauseDurationChangeProposed(uint256 proposedDuration, uint256 proposedAt);
    event Paused(address indexed caller);
    event PauserAdded(address indexed pauser);
    event PauserRemoved(address indexed pauser);
    event RecoveryCancelled(address indexed caller);
    event RecoveryExecuted(address indexed caller);
    event RecoveryInvalidated();
    event RecoveryRequested(address indexed caller, uint256 requestedAt);
    event SourcesChangeCancelled(address indexed proposedPrimary, address indexed proposedBackup);
    event SourcesChanged(address previousPrimary, address previousBackup, address indexed newPrimary, address indexed newBackup);
    event SourcesChangeProposed(address indexed proposedPrimary, address indexed proposedBackup, uint256 proposedAt);
    event Unpaused(address indexed caller);

    // Errors
    error AdminChangePending();
    error AdminUnchanged();
    error AlreadyPaused();
    error AlreadyPauser();
    error ChallengeAlreadyPending();
    error ChallengeDelayNotElapsed();
    error ChallengeThresholdChangePending();
    error ChallengeThresholdUnchanged();
    error ConfigChangeDelayNotElapsed();
    error InvalidAdmin();
    error InvalidChallengeDelay();
    error InvalidChallengeThreshold();
    error InvalidConfigChangeDelay();
    error InvalidDecimals();
    error InvalidMaxAge();
    error InvalidPauser();
    error InvalidQueryId();
    error InvalidRecoveryDelay();
    error InvalidTimestamp();
    error MinPauseDurationChangePending();
    error MinPauseDurationUnchanged();
    error NoPendingAdminChange();
    error NoPendingChallenge();
    error NoPendingChallengeThresholdChange();
    error NoPendingMinPauseDurationChange();
    error NoPendingRecovery();
    error NoPendingSourcesChange();
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
    error SignedPriceOverflow();
    error SourceDecimalsMismatch();
    error SourceHasNoCode();
    error SourceQueryIdMismatch();
    error SourcesChangePending();
    error SourcesUnchanged();
    error StalePrice();
    error StillDeviating();
    error ZeroValue();

    // Getter functions

    /**
     * @notice Returns the current backup source.
     */
    function backupSource() external view returns (IPriceSource);

    /**
     * @notice Returns the immutable source price precision.
     */
    function decimals() external view returns (uint8);

    /**
     * @notice Returns only the selected source's nonzero value and original millisecond timestamp.
     * @dev Paused, failed, zero/future or over-age timestamp reads revert. No automatic fallback.
     * Age equality is valid at full millisecond precision; one immutable maximum data age applies to both sources.
     * A TWAP endpoint does not establish contributor freshness. No adaptor-specific rescaling occurs.
     */
    function getCurrentValue() external view returns (uint256 value, uint256 aggregateTimestamp);

    /**
     * @notice Latest-read Chainlink ABI subset; not a historical-round interface.
     * @dev Uses the same selected-source/pause/validity checks as getCurrentValue, in original milliseconds.
     * Reverts with SignedPriceOverflow above int256.max; native uint256 reads remain supported.
     * @return roundId Always zero: unavailable sentinel, not a retrievable historical round.
     * @return answer Positive raw source price at decimals() precision; no rescaling.
     * @return startedAt Always zero: round start metadata is unavailable.
     * @return updatedAt Original source timestamp floored to Unix seconds after full-ms validation.
     * Flooring can make an observation appear less than one second older to downstream consumers.
     * @return answeredInRound Always zero: unavailable sentinel; no round progression is synthesized.
     */
    function latestRoundData() external view returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    );

    /**
     * @notice Immutable maximum observation age in seconds, shared by both sources.
     */
    function MAX_DATA_AGE() external view returns (uint256);

    /**
     * @notice Returns the current primary source.
     */
    function primarySource() external view returns (IPriceSource);

    /**
     * @notice Returns the immutable agreed base/quote identifier.
     */
    function queryId() external view returns (bytes32);
}
