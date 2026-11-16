// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IPriceSource} from "./IPriceSource.sol";

/**
 * @title ITellorShepherd
 * @notice Consumer reads, source diagnostics, events, and errors for a per-feed Tellor safety layer.
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
    error ChallengeNotAllowed();
    error ChallengeStillAllowed();
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
    error NotPausable();
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
    error SourceNotUsable();
    error SourcesChangePending();
    error SourcesUnchanged();
    error StalePrice();
    error UnexpectedState();
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
     * @notice Returns the display label set at deployment, with no setter.
     * @dev May be empty. This label does not validate source identity, units, or trust.
     */
    function description() external view returns (string memory);

    /**
     * @notice Returns only the selected source's nonzero value and original millisecond timestamp.
     * @dev Paused, failed, zero/future or over-age timestamp reads revert. No automatic fallback.
     * Age equality is valid at full millisecond precision; one immutable maximum data age applies to both sources.
     * A TWAP endpoint does not establish contributor freshness. No adaptor-specific rescaling occurs.
     */
    function getCurrentValue() external view returns (uint256 value, uint256 aggregateTimestamp);

    /**
     * @notice Whether explicit pausing is enabled, fixed at deployment.
     * @dev False does not guarantee price availability or prevent delayed source replacement.
     */
    function isPausable() external view returns (bool);

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
     * @notice Manually checks a candidate source's metadata and current native-read usability.
     * @dev Callable by anyone, including while paused, without selecting or registering the source.
     * Requires code, matching decimals, a nonzero price, and a nonzero/nonfuture timestamp
     * no older than MAX_DATA_AGE at full millisecond precision; age equality is accepted.
     * Metadata failures revert; caught price-read failures and invalid values revert with SourceNotUsable.
     * Malformed successful ABI output can revert during decoding. No guarantee of a specific error for it.
     * Success does not establish asset identity, trustworthy prices or future availability.
     * Construction and source migration remain metadata-only; this check does not change their policy.
     * @param _source Candidate IPriceSource, whether or not currently configured.
     * @return value Original raw uint256 price, without the signed latestRoundData bound.
     * @return timestampMs Original source observation timestamp in Unix milliseconds.
     */
    function validateSource(address _source) external view returns (uint256 value, uint256 timestampMs);

}
