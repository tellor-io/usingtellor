// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IPriceSource} from "../interfaces/IPriceSource.sol";
import {ITellorShepherd} from "../interfaces/ITellorShepherd.sol";

/**
 * @title TellorShepherd
 * @notice Per-feed selector of interchangeable primary and backup price sources.
 * @dev Price, timestamp validity and the immutable maximum data age are checked here.
 * Source compatibility does not establish trust or appropriate timing configuration.
 */
contract TellorShepherd is ITellorShepherd {
    // Immutables
    uint256 public immutable CHALLENGE_DELAY_SECONDS;
    uint256 public immutable CONFIG_CHANGE_DELAY;
    uint8 public immutable override decimals;
    uint256 public immutable override MAX_DATA_AGE;
    bytes32 public immutable override queryId;
    uint256 public immutable RECOVERY_DELAY_SECONDS;

    // Storage
    address public admin;
    uint256 public adminProposedAt;
    IPriceSource public override backupSource;
    bool public challengePending;
    uint256 public challengeRequestedAt;
    uint256 public challengeThresholdBps;
    uint256 public challengeThresholdProposedAt;
    uint256 public minPauseDuration;
    bool public minPauseDurationChangePending;
    uint256 public minPauseDurationProposedAt;
    Mode public mode;
    bool public paused;
    uint256 public pausedAt;
    address public pendingAdmin;
    address public pendingBackupSource;
    uint256 public pendingChallengeThresholdBps;
    uint256 public pendingMinPauseDuration;
    address public pendingPrimarySource;
    IPriceSource public override primarySource;
    bool public recoveryPending;
    uint256 public recoveryRequestedAt;
    uint256 public sourcesProposedAt;

    mapping(address => bool) public isPauser;


    // Enums
    enum Mode {
        PRIMARY,
        BACKUP
    }

    // Constructor

    /**
     * @notice Binds the feed, source pair, administrator, initial policies, and immutable control settings.
     * @dev Metadata is checked without requiring available prices. Deployers must calibrate
     * challenge/recovery delays against source timing and security requirements, including
     * every replacement. The common age limit must accommodate both sources; metadata cannot prove this.
     * A replacement needing different core delays or maximum age requires a new Shepherd.
     * @param _queryId Nonzero agreed base/quote identifier, fixed for this instance.
     * @param _decimals Fixed raw-price precision, from 0 to 77; no prices are rescaled here.
     * @param _primarySource Initial primary reader implementing IPriceSource.
     * @param _backupSource Initial backup reader implementing the same interface.
     * @param _admin Nonzero administrator, independent of the deployment caller.
     * @param _minPauseDuration Initial minimum uninterrupted pause duration in seconds; zero is allowed.
     * @param _configChangeDelay Positive shared notice period for source-pair, admin, pause-duration and threshold changes, in seconds.
     * @param _challengeThresholdBps Initial strict absolute deviation relative to primary, from 1 to 9999 bps.
     * @param _transitionDelaysSeconds Positive challenge and recovery waits in seconds, respectively.
     * @param _maxDataAge Positive maximum observation age in seconds, shared by both sources.
     */
    constructor(
        bytes32 _queryId,
        uint8 _decimals,
        address _primarySource,
        address _backupSource,
        address _admin,
        uint256 _minPauseDuration,
        uint256 _configChangeDelay,
        uint256 _challengeThresholdBps,
        uint256[2] memory _transitionDelaysSeconds,
        uint256 _maxDataAge
    ) {
        if (_queryId == bytes32(0)) revert InvalidQueryId();
        if (_decimals > 77) revert InvalidDecimals();
        if (_admin == address(0)) revert InvalidAdmin();
        if (_configChangeDelay == 0) revert InvalidConfigChangeDelay();
        if (_challengeThresholdBps == 0 || _challengeThresholdBps >= 10000) revert InvalidChallengeThreshold();
        if (_transitionDelaysSeconds[0] == 0) revert InvalidChallengeDelay();
        if (_transitionDelaysSeconds[1] == 0) revert InvalidRecoveryDelay();
        // Validate once so the millisecond conversion is safe on every read.
        if (_maxDataAge == 0 || _maxDataAge > type(uint256).max / 1000) revert InvalidMaxAge();

        queryId = _queryId;
        decimals = _decimals;
        _checkSourceCompatibility(_primarySource, _queryId, _decimals);
        _checkSourceCompatibility(_backupSource, _queryId, _decimals);
        primarySource = IPriceSource(_primarySource);
        backupSource = IPriceSource(_backupSource);
        admin = _admin;
        minPauseDuration = _minPauseDuration;
        CONFIG_CHANGE_DELAY = _configChangeDelay;
        challengeThresholdBps = _challengeThresholdBps;
        CHALLENGE_DELAY_SECONDS = _transitionDelaysSeconds[0];
        RECOVERY_DELAY_SECONDS = _transitionDelaysSeconds[1];
        MAX_DATA_AGE = _maxDataAge;
        mode = Mode.PRIMARY;
    }

    // State-changing functions

    /**
     * @notice Immediately grants pauser membership; callable only by the admin.
     * @dev Membership grants no authority to manage other pausers or unpause.
     * @param _pauser Nonzero address not already in the pauser set.
     */
    function addPauser(address _pauser) external {
        if (msg.sender != admin) revert NotAdmin();
        if (_pauser == address(0)) revert InvalidPauser();
        if (isPauser[_pauser]) revert AlreadyPauser();

        isPauser[_pauser] = true;
        emit PauserAdded(_pauser);
    }

    /**
     * @notice Cancels the pending admin change; current admin only, in either pause state.
     */
    function cancelAdminChange() external {
        if (msg.sender != admin) revert NotAdmin();
        address proposedAdmin = pendingAdmin;
        if (proposedAdmin == address(0)) revert NoPendingAdminChange();
        pendingAdmin = address(0);
        adminProposedAt = 0;
        emit AdminChangeCancelled(proposedAdmin);
    }

    /**
     * @notice Anyone may cancel a pending primary challenge when deviation has resolved.
     * @dev No waiting period or pause restriction. Missing or broken source data cannot
     * establish resolution, so failures preserve the original challenge and its clock.
     */
    function cancelChallenge() external {
        if (mode != Mode.PRIMARY) revert NotPrimaryMode();
        if (!challengePending) revert NoPendingChallenge();
        bool deviating = _readDeviation();
        if (deviating) revert StillDeviating();

        challengePending = false;
        challengeRequestedAt = 0;
        emit ChallengeCancelled(msg.sender);
    }

    /**
     * @notice Cancels the threshold proposal without affecting transition requests; current admin only.
     */
    function cancelChallengeThresholdChange() external {
        if (msg.sender != admin) revert NotAdmin();
        uint256 proposedThreshold = pendingChallengeThresholdBps;
        if (proposedThreshold == 0) revert NoPendingChallengeThresholdChange();
        pendingChallengeThresholdBps = 0;
        challengeThresholdProposedAt = 0;
        emit ChallengeThresholdChangeCancelled(proposedThreshold);
    }

    /**
     * @notice Cancels a pending duration change without affecting the current pause; admin only.
     */
    function cancelMinPauseDurationChange() external {
        if (msg.sender != admin) revert NotAdmin();
        if (!minPauseDurationChangePending) revert NoPendingMinPauseDurationChange();
        uint256 proposedDuration = pendingMinPauseDuration;
        pendingMinPauseDuration = 0;
        minPauseDurationProposedAt = 0;
        minPauseDurationChangePending = false;
        emit MinPauseDurationChangeCancelled(proposedDuration);
    }

    /**
     * @notice Anyone may cancel a pending recovery when deviation returns.
     * @dev No delay or pause restriction. Failed assessments revert without clearing state.
     * Transient deviation does not reset the clock unless cancellation is submitted.
     */
    function cancelRecovery() external {
        if (mode != Mode.BACKUP) revert NotBackupMode();
        if (!recoveryPending) revert NoPendingRecovery();
        bool deviating = _readDeviation();
        if (!deviating) revert RecoveryStillAllowed();

        recoveryPending = false;
        recoveryRequestedAt = 0;
        emit RecoveryCancelled(msg.sender);
    }

    /**
     * @notice Cancels the pending pair proposal; admin only, including while paused.
     * @dev Does not consult proposed dependencies, which may have stopped working.
     */
    function cancelSourcesChange() external {
        if (msg.sender != admin) revert NotAdmin();
        address proposedPrimary = pendingPrimarySource;
        address proposedBackup = pendingBackupSource;
        if (proposedPrimary == address(0)) revert NoPendingSourcesChange();
        pendingPrimarySource = address(0);
        pendingBackupSource = address(0);
        sourcesProposedAt = 0;
        emit SourcesChangeCancelled(proposedPrimary, proposedBackup);
    }

    /**
     * @notice Transfers authority after the full notice; executed by the outgoing admin.
     * @dev Equality is sufficient. Does not change pause, sources, other proposal clocks,
     * transition requests or separately granted pauser memberships. No recipient call occurs.
     */
    function executeAdminChange() external {
        if (msg.sender != admin) revert NotAdmin();
        address proposedAdmin = pendingAdmin;
        if (proposedAdmin == address(0)) revert NoPendingAdminChange();
        if (block.timestamp - adminProposedAt < CONFIG_CHANGE_DELAY) revert ConfigChangeDelayNotElapsed();
        address previousAdmin = admin;
        admin = proposedAdmin;
        pendingAdmin = address(0);
        adminProposedAt = 0;
        emit AdminChanged(previousAdmin, proposedAdmin);
    }

    /**
     * @notice Anyone may select backup after the challenge delay if deviation is re-established.
     * @dev Equality permits execution. Pause and its clock survive the switch.
     * Both sources must be usable at execution; a failing backup prevents selection.
     * Request and execution checks do not prove continuous deviation between calls.
     */
    function executeChallenge() external {
        if (mode != Mode.PRIMARY) revert NotPrimaryMode();
        if (!challengePending) revert NoPendingChallenge();
        if (block.timestamp - challengeRequestedAt < CHALLENGE_DELAY_SECONDS) revert ChallengeDelayNotElapsed();
        bool deviating = _readDeviation();
        if (!deviating) revert NotDeviating();

        challengePending = false;
        challengeRequestedAt = 0;
        mode = Mode.BACKUP;
        emit ChallengeExecuted(msg.sender);
    }

    /**
     * @notice Applies the pending threshold after the shared notice; current admin only.
     * @dev Invalidates transition timers accumulated under the previous comparison policy.
     * Does not read sources or change mode, pause, its clock, or other configuration proposals.
     */
    function executeChallengeThresholdChange() external {
        if (msg.sender != admin) revert NotAdmin();
        uint256 proposedThreshold = pendingChallengeThresholdBps;
        if (proposedThreshold == 0) revert NoPendingChallengeThresholdChange();
        if (block.timestamp - challengeThresholdProposedAt < CONFIG_CHANGE_DELAY) revert ConfigChangeDelayNotElapsed();
        uint256 previousThreshold = challengeThresholdBps;
        challengeThresholdBps = proposedThreshold;
        pendingChallengeThresholdBps = 0;
        challengeThresholdProposedAt = 0;
        _invalidatePendingTransitions();
        emit ChallengeThresholdChanged(previousThreshold, proposedThreshold);
    }

    /**
     * @notice Applies the pending duration after the shared notice period; current admin only.
     * @dev Applies immediately to an active pause without changing pausedAt or unpausing.
     * Zero removes the elapsed-time wait, but not admin authority or the pending-source block.
     * Preserves all other proposals, transition requests, source state and pauser memberships.
     */
    function executeMinPauseDurationChange() external {
        if (msg.sender != admin) revert NotAdmin();
        if (!minPauseDurationChangePending) revert NoPendingMinPauseDurationChange();
        if (block.timestamp - minPauseDurationProposedAt < CONFIG_CHANGE_DELAY) revert ConfigChangeDelayNotElapsed();
        uint256 previousDuration = minPauseDuration;
        uint256 proposedDuration = pendingMinPauseDuration;
        minPauseDuration = proposedDuration;
        pendingMinPauseDuration = 0;
        minPauseDurationProposedAt = 0;
        minPauseDurationChangePending = false;
        emit MinPauseDurationChanged(previousDuration, proposedDuration);
    }

    /**
     * @notice Anyone may return to primary after the recovery delay if deviation is still resolved.
     * @dev Equality permits execution; failed assessments preserve the pending timer.
     * Pause survives the switch. Request/execution checks do not prove continuous agreement.
     */
    function executeRecovery() external {
        if (mode != Mode.BACKUP) revert NotBackupMode();
        if (!recoveryPending) revert NoPendingRecovery();
        if (block.timestamp - recoveryRequestedAt < RECOVERY_DELAY_SECONDS) revert RecoveryDelayNotElapsed();
        bool deviating = _readDeviation();
        if (deviating) revert RecoveryNotAllowed();

        recoveryPending = false;
        recoveryRequestedAt = 0;
        mode = Mode.PRIMARY;
        emit RecoveryExecuted(msg.sender);
    }

    /**
     * @notice Replaces both sources atomically after notice; admin only and paused.
     * @dev Rechecks metadata without reading prices. Invalidates transition requests,
     * preserves mode/pause clock and immutable delays/maximum age, and never consults the old sources.
     */
    function executeSourcesChange() external {
        if (msg.sender != admin) revert NotAdmin();
        address proposedPrimary = pendingPrimarySource;
        address proposedBackup = pendingBackupSource;
        if (proposedPrimary == address(0)) revert NoPendingSourcesChange();
        if (!paused) revert NotPaused();
        if (block.timestamp - sourcesProposedAt < CONFIG_CHANGE_DELAY) revert ConfigChangeDelayNotElapsed();
        _checkSourceCompatibility(proposedPrimary, queryId, decimals);
        _checkSourceCompatibility(proposedBackup, queryId, decimals);
        address previousPrimary = address(primarySource);
        address previousBackup = address(backupSource);
        primarySource = IPriceSource(proposedPrimary);
        backupSource = IPriceSource(proposedBackup);
        _invalidatePendingTransitions();
        pendingPrimarySource = address(0);
        pendingBackupSource = address(0);
        sourcesProposedAt = 0;
        emit SourcesChanged(previousPrimary, previousBackup, proposedPrimary, proposedBackup);
    }

    /**
     * @notice Immediately blocks consumer reads; callable by the admin or an active pauser.
     * @dev Repeated calls revert so a pauser cannot extend the current pause's clock.
     * Source mode and elapsed-time checks are independent of pause state.
     */
    function pause() external {
        if (msg.sender != admin && !isPauser[msg.sender]) revert NotAuthorizedToPause();
        if (paused) revert AlreadyPaused();

        paused = true;
        pausedAt = block.timestamp;
        emit Paused(msg.sender);
    }

    /**
     * @notice Announces a nonzero replacement admin; current admin only, in either pause state.
     * @dev No recipient acceptance or liveness check: a throwaway address is permitted.
     * Cancel an existing proposal before reproposing and starting a new notice period.
     */
    function proposeAdminChange(address _newAdmin) external {
        if (msg.sender != admin) revert NotAdmin();
        if (pendingAdmin != address(0)) revert AdminChangePending();
        if (_newAdmin == address(0)) revert InvalidAdmin();
        if (_newAdmin == admin) revert AdminUnchanged();
        pendingAdmin = _newAdmin;
        adminProposedAt = block.timestamp;
        emit AdminChangeProposed(_newAdmin, block.timestamp);
    }

    /**
     * @notice Proposes a new deviation threshold in basis points; current admin only.
     * @dev The active threshold governs transitions until execution. Zero means no proposal.
     */
    function proposeChallengeThresholdChange(uint256 _newThresholdBps) external {
        if (msg.sender != admin) revert NotAdmin();
        if (pendingChallengeThresholdBps != 0) revert ChallengeThresholdChangePending();
        if (_newThresholdBps == 0 || _newThresholdBps >= 10000) revert InvalidChallengeThreshold();
        if (_newThresholdBps == challengeThresholdBps) revert ChallengeThresholdUnchanged();
        pendingChallengeThresholdBps = _newThresholdBps;
        challengeThresholdProposedAt = block.timestamp;
        emit ChallengeThresholdChangeProposed(_newThresholdBps, block.timestamp);
    }

    /**
     * @notice Proposes a new minimum pause duration in seconds; current admin only.
     * @dev Zero is valid. Until execution, the current duration still governs every pause.
     */
    function proposeMinPauseDurationChange(uint256 _newDuration) external {
        if (msg.sender != admin) revert NotAdmin();
        if (minPauseDurationChangePending) revert MinPauseDurationChangePending();
        if (_newDuration == minPauseDuration) revert MinPauseDurationUnchanged();
        pendingMinPauseDuration = _newDuration;
        minPauseDurationProposedAt = block.timestamp;
        minPauseDurationChangePending = true;
        emit MinPauseDurationChangeProposed(_newDuration, block.timestamp);
    }

    /**
     * @notice Announces a replacement source pair; admin only, whether paused or unpaused.
     * @dev May retain one current source. Cancel any existing proposal before replacing it.
     * Empty history is allowed. Metadata does not prove trust, readiness, or timing suitability.
     * Admins must reassess source timing against this Shepherd's immutable transition delays.
     */
    function proposeSourcesChange(address _newPrimary, address _newBackup) external {
        if (msg.sender != admin) revert NotAdmin();
        if (pendingPrimarySource != address(0)) revert SourcesChangePending();
        if (_newPrimary == address(primarySource) && _newBackup == address(backupSource)) revert SourcesUnchanged();
        _checkSourceCompatibility(_newPrimary, queryId, decimals);
        _checkSourceCompatibility(_newBackup, queryId, decimals);
        pendingPrimarySource = _newPrimary;
        pendingBackupSource = _newBackup;
        sourcesProposedAt = block.timestamp;
        emit SourcesChangeProposed(_newPrimary, _newBackup, block.timestamp);
    }

    /**
     * @notice Immediately revokes pauser membership; callable only by the admin.
     * @dev Removing the admin from this set does not revoke its independent role.
     * @param _pauser Nonzero address currently in the pauser set.
     */
    function removePauser(address _pauser) external {
        if (msg.sender != admin) revert NotAdmin();
        if (_pauser == address(0)) revert InvalidPauser();
        if (!isPauser[_pauser]) revert NotPauser();

        isPauser[_pauser] = false;
        emit PauserRemoved(_pauser);
    }

    /**
     * @notice Anyone may request a challenge in primary mode when deviation is established.
     * @dev Pause does not block source comparisons. Duplicate requests cannot restart the timer.
     * A pending challenge does not halt reads or prove continuous deviation.
     */
    function requestChallenge() external {
        if (mode != Mode.PRIMARY) revert NotPrimaryMode();
        if (challengePending) revert ChallengeAlreadyPending();
        bool deviating = _readDeviation();
        if (!deviating) revert NotDeviating();

        challengePending = true;
        challengeRequestedAt = block.timestamp;
        emit ChallengeRequested(msg.sender, block.timestamp);
    }

    /**
     * @notice Anyone may request recovery in backup mode when deviation has resolved.
     * @dev Duplicate requests cannot reset the clock. Source comparisons remain available while paused.
     */
    function requestRecovery() external {
        if (mode != Mode.BACKUP) revert NotBackupMode();
        if (recoveryPending) revert RecoveryAlreadyPending();
        bool deviating = _readDeviation();
        if (deviating) revert RecoveryNotAllowed();

        recoveryPending = true;
        recoveryRequestedAt = block.timestamp;
        emit RecoveryRequested(msg.sender, block.timestamp);
    }

    /**
     * @notice Restores consumer reads after the minimum pause duration; admin only.
     * @dev Uses the current duration, including updates executed during this pause.
     * Equality is sufficient, and zero allows unpause with no elapsed time; EVM seconds.
     * A pending source-pair proposal must be executed or cancelled first.
     */
    function unpause() external {
        if (msg.sender != admin) revert NotAdmin();
        if (!paused) revert NotPaused();
        if (pendingPrimarySource != address(0)) revert SourcesChangePending();
        if (block.timestamp - pausedAt < minPauseDuration) revert PauseDurationNotElapsed();

        paused = false;
        pausedAt = 0;
        emit Unpaused(msg.sender);
    }

    // Getter functions

    /**
     * @notice Returns only the selected source's price and original millisecond timestamp.
     * @dev Paused or unusable reads revert without switching or consulting the other source.
     * Age equality is accepted; a TWAP endpoint does not bound contributor age.
     */
    function getCurrentValue() external view override returns (uint256 value, uint256 aggregateTimestamp) {
        return _readSelectedSource();
    }

    /**
     * @inheritdoc ITellorShepherd
     */
    function latestRoundData() external view override returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        (uint256 value, uint256 timestampMs) = _readSelectedSource();
        if (value > uint256(type(int256).max)) revert SignedPriceOverflow();
        return (0, int256(value), 0, timestampMs / 1000, 0);
    }

    // Internal functions

    /**
     * @dev Compatibility is not authenticity. Price availability is deliberately not probed.
     */
    function _checkSourceCompatibility(address _source, bytes32 _queryId, uint8 _decimals) internal view {
        if (_source.code.length == 0) revert SourceHasNoCode();
        if (IPriceSource(_source).queryId() != _queryId) revert SourceQueryIdMismatch();
        if (IPriceSource(_source).decimals() != _decimals) revert SourceDecimalsMismatch();
    }

    /**
     * @dev Changed sources or comparison policy require fresh assessment and transition timers.
     * Called only after configuration checks succeed; never reads source data.
     */
    function _invalidatePendingTransitions() internal {
        if (challengePending) {
            challengePending = false;
            challengeRequestedAt = 0;
            emit ChallengeInvalidated();
        }
        if (recoveryPending) {
            recoveryPending = false;
            recoveryRequestedAt = 0;
            emit RecoveryInvalidated();
        }
    }

    /**
     * @dev Compares the same primary and backup observations used by consumers, independent of pause.
     * Failures propagate; they never count as agreement or authorize a transition.
     */
    function _readDeviation() internal view returns (bool) {
        (uint256 primaryValue,) = _readSource(primarySource);
        (uint256 value,) = _readSource(backupSource);
        uint256 difference = value > primaryValue ? value - primaryValue : primaryValue - value;
        // Exactly floor(reference * threshold / 10000), without an overflowing product.
        // Integer difference > this floor is equivalent to the strict rational comparison.
        uint256 allowedDifference = (primaryValue / 10000) * challengeThresholdBps
            + ((primaryValue % 10000) * challengeThresholdBps) / 10000;
        return difference > allowedDifference;
    }

    /**
     * @dev Shared consumer policy; validates original milliseconds before any output conversion.
     */
    function _readSelectedSource() internal view returns (uint256 value, uint256 timestampMs) {
        if (paused) revert ShepherdPaused();
        return _readSource(mode == Mode.PRIMARY ? primarySource : backupSource);
    }

    /**
     * @dev Both sources share the same maximum age; compare without rounding observation milliseconds.
     */
    function _readSource(IPriceSource _source) internal view returns (uint256 value, uint256 timestampMs) {
        (value, timestampMs) = _source.getCurrentValue();
        if (value == 0) revert ZeroValue();
        uint256 nowMs = block.timestamp * 1000;
        if (timestampMs == 0 || timestampMs > nowMs) revert InvalidTimestamp();
        if (nowMs - timestampMs > MAX_DATA_AGE * 1000) revert StalePrice();
    }
}
