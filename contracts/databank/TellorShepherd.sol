// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";
import {ITellorShepherd} from "../interfaces/ITellorShepherd.sol";

/**
 * @title TellorShepherd
 * @notice Per-feed Tellor safety layer with TWAP primary and delayed spot backup.
 * @dev Freshness checks belong to adaptors. Adaptor integration and release
 * validation remain incomplete. This version is not ready for consumer deployment.
 */
contract TellorShepherd is ITellorShepherd {
    // Immutables
    bytes32 public immutable override queryId;
    uint256 public immutable CHALLENGE_DELAY_SECONDS;
    uint256 public immutable CHALLENGE_THRESHOLD_BPS;
    uint256 public immutable DATA_BANK_CHANGE_DELAY;
    uint256 public immutable MIN_PAUSE_DURATION;
    uint256 public immutable RECOVERY_DELAY_SECONDS;
    uint256 public immutable RELAY_READ_DELAY;
    uint256 public immutable TWAP_WINDOW_MS;

    // Storage
    // Both modes share this bank, replaced only through delayed, paused migration.
    ITellorDataBank public dataBank;
    address public admin;
    address public pendingDataBank;
    uint256 public challengeRequestedAt;
    uint256 public dataBankProposedAt;
    uint256 public pausedAt;
    uint256 public recoveryRequestedAt;
    bool public challengePending;
    bool public paused;
    bool public recoveryPending;
    Mode public mode;

    // Additional operational keys; the admin's pause authority is independent.
    mapping(address => bool) public isPauser;

    // Enums
    enum Mode {
        PRIMARY,
        BACKUP
    }

    // Constructor

    /**
     * @notice Binds the feed, shared bank, administrator, and timing configuration.
     * @dev Code presence does not establish source compatibility or trustworthiness.
     * No existing feed history is required at deployment.
     * @param _queryId Nonzero Tellor query ID, fixed for this instance.
     * @param _dataBank Initial deployed DataBank contract.
     * @param _admin Nonzero administrator, independent of the deployment caller.
     * @param _relayReadDelay Positive delay in seconds, measured from EVM relay time.
     * @param _minPauseDuration Positive minimum uninterrupted pause duration in seconds.
     * @param _dataBankChangeDelay Positive notice period for replacing the bank, in seconds.
     * @param _twapWindowMs Positive minimum TWAP duration in aggregate milliseconds.
     * @param _challengeThresholdBps Strict symmetric deviation threshold, from 1 to 9999 bps.
     * @param _transitionDelaysSeconds Challenge and recovery waits in seconds, respectively.
     * Challenge wait must cover the rounded-up TWAP window; recovery wait must be positive.
     */
    constructor(
        bytes32 _queryId,
        address _dataBank,
        address _admin,
        uint256 _relayReadDelay,
        uint256 _minPauseDuration,
        uint256 _dataBankChangeDelay,
        uint256 _twapWindowMs,
        uint256 _challengeThresholdBps,
        uint256[2] memory _transitionDelaysSeconds
    ) {
        if (_queryId == bytes32(0)) revert InvalidQueryId();
        if (_dataBank.code.length == 0) revert DataBankHasNoCode();
        if (_admin == address(0)) revert InvalidAdmin();
        if (_relayReadDelay == 0) revert InvalidRelayReadDelay();
        if (_minPauseDuration == 0) revert InvalidMinPauseDuration();
        if (_dataBankChangeDelay == 0) revert InvalidDataBankChangeDelay();
        if (_twapWindowMs == 0) revert InvalidTwapWindow();

        if (_challengeThresholdBps == 0 || _challengeThresholdBps >= 10000) revert InvalidChallengeThreshold();
        // Division plus remainder avoids overflowing when converting the window to seconds.
        uint256 minimumChallengeDelay = _twapWindowMs / 1000;
        if (_twapWindowMs % 1000 != 0) minimumChallengeDelay += 1;
        if (_transitionDelaysSeconds[0] < minimumChallengeDelay) revert InvalidChallengeDelay();

        if (_transitionDelaysSeconds[1] == 0) revert InvalidRecoveryDelay();

        queryId = _queryId;
        dataBank = ITellorDataBank(_dataBank);
        admin = _admin;
        RELAY_READ_DELAY = _relayReadDelay;
        MIN_PAUSE_DURATION = _minPauseDuration;
        DATA_BANK_CHANGE_DELAY = _dataBankChangeDelay;
        TWAP_WINDOW_MS = _twapWindowMs;
        CHALLENGE_THRESHOLD_BPS = _challengeThresholdBps;
        CHALLENGE_DELAY_SECONDS = _transitionDelaysSeconds[0];
        RECOVERY_DELAY_SECONDS = _transitionDelaysSeconds[1];
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
     * @notice Anyone may cancel a pending primary challenge when deviation has resolved.
     * @dev No waiting period or pause restriction. Missing or broken diagnostics cannot
     * establish resolution, so failures preserve the original challenge and its clock.
     */
    function cancelChallenge() external {
        if (mode != Mode.PRIMARY) revert NotPrimaryMode();
        if (!challengePending) revert NoPendingChallenge();
        (bool available, bool deviating) = _readDeviation();
        if (!available) revert DiagnosticUnavailable();
        if (deviating) revert StillDeviating();

        challengePending = false;
        challengeRequestedAt = 0;
        emit ChallengeCancelled(msg.sender);
    }

    /**
     * @notice Cancels the pending bank proposal; admin only, including while paused.
     * @dev Cancellation does not consult the proposed bank, which may have stopped working.
     */
    function cancelDataBankChange() external {
        if (msg.sender != admin) revert NotAdmin();
        address proposedBank = pendingDataBank;
        if (proposedBank == address(0)) revert NoPendingDataBankChange();

        pendingDataBank = address(0);
        dataBankProposedAt = 0;
        emit DataBankChangeCancelled(proposedBank);
    }

    /**
     * @notice Anyone may cancel a pending recovery when deviation returns.
     * @dev No delay or pause restriction. Failed assessments revert without clearing state.
     * Transient deviation does not reset the clock unless cancellation is submitted.
     */
    function cancelRecovery() external {
        if (mode != Mode.BACKUP) revert NotBackupMode();
        if (!recoveryPending) revert NoPendingRecovery();
        (bool available, bool deviating) = _readDeviation();
        if (!available) revert DiagnosticUnavailable();
        if (!deviating) revert RecoveryStillAllowed();

        recoveryPending = false;
        recoveryRequestedAt = 0;
        emit RecoveryCancelled(msg.sender);
    }

    /**
     * @notice Anyone may select backup after the challenge delay if deviation is re-established.
     * @dev Equality permits execution. Pause and its clock survive the switch.
     * Backup availability does not gate selection; failed backup reads subsequently revert.
     * Request and execution checks do not prove continuous deviation between calls.
     */
    function executeChallenge() external {
        if (mode != Mode.PRIMARY) revert NotPrimaryMode();
        if (!challengePending) revert NoPendingChallenge();
        if (block.timestamp - challengeRequestedAt < CHALLENGE_DELAY_SECONDS) revert ChallengeDelayNotElapsed();
        (bool available, bool deviating) = _readDeviation();
        if (!available) revert DiagnosticUnavailable();
        if (!deviating) revert NotDeviating();

        challengePending = false;
        challengeRequestedAt = 0;
        mode = Mode.BACKUP;
        emit ChallengeExecuted(msg.sender);
    }

    /**
     * @notice Executes a pending bank change after its notice period; admin only and paused.
     * @dev Equality permits execution. Rechecks compatibility, invalidates transition requests, and preserves mode and pause clock.
     */
    function executeDataBankChange() external {
        if (msg.sender != admin) revert NotAdmin();
        address proposedBank = pendingDataBank;
        if (proposedBank == address(0)) revert NoPendingDataBankChange();
        if (!paused) revert NotPaused();
        if (block.timestamp - dataBankProposedAt < DATA_BANK_CHANGE_DELAY) revert DataBankChangeDelayNotElapsed();
        _checkDataBankCompatibility(proposedBank);

        address previousBank = address(dataBank);
        dataBank = ITellorDataBank(proposedBank);
        _invalidatePendingTransitions();
        pendingDataBank = address(0);
        dataBankProposedAt = 0;
        emit DataBankChanged(previousBank, proposedBank);
    }

    /**
     * @notice Anyone may return to TWAP after the recovery delay if deviation is still resolved.
     * @dev Equality permits execution; failed assessments preserve the pending timer.
     * Pause survives the switch. Request/execution checks do not prove continuous agreement.
     */
    function executeRecovery() external {
        if (mode != Mode.BACKUP) revert NotBackupMode();
        if (!recoveryPending) revert NoPendingRecovery();
        if (block.timestamp - recoveryRequestedAt < RECOVERY_DELAY_SECONDS) revert RecoveryDelayNotElapsed();
        (bool available, bool deviating) = _readDeviation();
        if (!available) revert DiagnosticUnavailable();
        if (deviating) revert RecoveryNotAllowed();

        recoveryPending = false;
        recoveryRequestedAt = 0;
        mode = Mode.PRIMARY;
        emit RecoveryExecuted(msg.sender);
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
     * @notice Announces a replacement bank; admin only, whether paused or unpaused.
     * @dev Cancel an existing proposal before replacing it so every target gets fresh notice.
     * Empty history is allowed. Compatibility does not establish source trust or read readiness.
     * @param _newDataBank Deployed bank distinct from the current bank.
     */
    function proposeDataBankChange(address _newDataBank) external {
        if (msg.sender != admin) revert NotAdmin();
        if (pendingDataBank != address(0)) revert DataBankChangePending();
        if (_newDataBank == address(dataBank)) revert DataBankUnchanged();
        _checkDataBankCompatibility(_newDataBank);

        pendingDataBank = _newDataBank;
        dataBankProposedAt = block.timestamp;
        emit DataBankChangeProposed(_newDataBank, block.timestamp);
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
     * @dev Pause does not block diagnostics. Duplicate requests cannot restart the timer.
     * A pending challenge does not halt reads or prove continuous deviation.
     */
    function requestChallenge() external {
        if (mode != Mode.PRIMARY) revert NotPrimaryMode();
        if (challengePending) revert ChallengeAlreadyPending();
        (bool available, bool deviating) = _readDeviation();
        if (!available) revert DiagnosticUnavailable();
        if (!deviating) revert NotDeviating();

        challengePending = true;
        challengeRequestedAt = block.timestamp;
        emit ChallengeRequested(msg.sender, block.timestamp);
    }

    /**
     * @notice Anyone may request recovery in spot mode when deviation has resolved.
     * @dev Duplicate requests cannot reset the clock. Diagnostics remain available while paused.
     */
    function requestRecovery() external {
        if (mode != Mode.BACKUP) revert NotBackupMode();
        if (recoveryPending) revert RecoveryAlreadyPending();
        (bool available, bool deviating) = _readDeviation();
        if (!available) revert DiagnosticUnavailable();
        if (deviating) revert RecoveryNotAllowed();

        recoveryPending = true;
        recoveryRequestedAt = block.timestamp;
        emit RecoveryRequested(msg.sender, block.timestamp);
    }

    /**
     * @notice Restores consumer reads after the minimum pause duration; admin only.
     * @dev Equality is sufficient. Elapsed time is measured in EVM seconds.
     * A pending bank proposal must be executed or cancelled first.
     */
    function unpause() external {
        if (msg.sender != admin) revert NotAdmin();
        if (!paused) revert NotPaused();
        if (pendingDataBank != address(0)) revert DataBankChangePending();
        if (block.timestamp - pausedAt < MIN_PAUSE_DURATION) revert PauseDurationNotElapsed();

        paused = false;
        pausedAt = 0;
        emit Unpaused(msg.sender);
    }

    // Getter functions

    /**
     * @notice Returns the bank's TWAP in primary mode or delayed spot in backup mode.
     * @dev Both use relayTimestamp < block.timestamp - RELAY_READ_DELAY. The TWAP endpoint
     * contributes no price weight. Missing history or invalid data reverts without switching
     * modes. Freshness belongs to adaptors; endpoint age does not bound contributor age.
     * @return value The selected source's nonzero value.
     * @return aggregateTimestamp The unchanged source timestamp in milliseconds.
     */
    function getCurrentValue() external view override returns (uint256 value, uint256 aggregateTimestamp) {
        if (paused) revert ShepherdPaused();
        if (mode == Mode.BACKUP) return _readBackup();
        (bool available, ITellorDataBank.TwapData memory twap) = _readTwapReference();
        if (!available) revert NoTwapData();
        return (twap.value, twap.endTimestamp);
    }

    // Internal functions

    /**
     * @dev Exercises both read ABIs without requiring history or applying read eligibility.
     * A reverting call or undecodable response rejects the target; failures propagate.
     */
    function _checkDataBankCompatibility(address _bank) internal view {
        if (_bank.code.length == 0) revert DataBankHasNoCode();
        ITellorDataBank(_bank).getRelayBefore(queryId, block.timestamp);
        ITellorDataBank(_bank).getTwapBefore(queryId, block.timestamp, TWAP_WINDOW_MS);
    }

    /// @dev A changed dependency requires fresh assessment and a fresh transition timer.
    /// Called only after migration checks succeed; never consults the replaced sources.
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
     * @dev Selects the newest mature spot report without consulting TWAP or falling back.
     * Preserves aggregate milliseconds; trailing payload bytes are accepted.
     * Consumer pause enforcement belongs to the read entry point.
     */
    function _readBackup() internal view returns (uint256 value, uint256 timestamp) {
        uint256 cutoff = block.timestamp - RELAY_READ_DELAY;
        (bool found, ITellorDataBank.AggregateData memory record) = dataBank.getRelayBefore(queryId, cutoff);
        if (!found) revert NoMatureData();
        if (record.value.length < 32) revert InvalidValueLength();
        value = abi.decode(record.value, (uint256));
        if (value == 0) revert ZeroValue();
        return (value, record.aggregateTimestamp);
    }

    /**
     * @dev Shared challenge/recovery diagnostic, independent of pause and consumer reads.
     * Missing reference history is not evidence of resolved deviation. Broken dependencies revert.
     * Inspect the latest candidate immediately, even when its relay is not yet consumable.
     */
    function _readDeviation() internal view returns (bool available, bool deviating) {
        ITellorDataBank.TwapData memory twap;
        (available, twap) = _readTwapReference();
        if (!available) return (false, false);

        ITellorDataBank.AggregateData memory candidate = dataBank.getCurrentAggregateData(queryId);
        if (candidate.value.length < 32) revert InvalidValueLength();
        uint256 value = abi.decode(candidate.value, (uint256));
        if (value == 0) revert ZeroValue();
        uint256 difference = value > twap.value ? value - twap.value : twap.value - value;
        // Exactly floor(reference * threshold / 10000), without an overflowing product.
        // threshold < 10000 bounds the total by reference; the remainder product is < 1e8.
        // Integer difference > this floor is equivalent to the strict rational comparison.
        uint256 allowedDifference = (twap.value / 10000) * CHALLENGE_THRESHOLD_BPS
            + ((twap.value % 10000) * CHALLENGE_THRESHOLD_BPS) / 10000;
        return (true, difference > allowedDifference);
    }

    /**
     * @dev Validates the delayed TWAP used by primary reads and transition diagnostics.
     * Missing history returns unavailable; malformed responses and dependency failures revert.
     * A two-record interval with one contributing price is sufficient. No maximum duration,
     * age, or gap policy is applied. Consistency checks do not authenticate a malicious bank's math.
     */
    function _readTwapReference() internal view returns (bool available, ITellorDataBank.TwapData memory twap) {
        uint256 cutoff = block.timestamp - RELAY_READ_DELAY;
        (available, twap) = dataBank.getTwapBefore(queryId, cutoff, TWAP_WINDOW_MS);
        if (!available) {
            // Never expose an unavailable dependency's payload as a usable reference.
            ITellorDataBank.TwapData memory empty;
            return (false, empty);
        }
        if (twap.value == 0 || twap.startIndex >= twap.endIndex
            || twap.startTimestamp >= twap.endTimestamp) revert InvalidTwapReference();
        if (twap.observationCount != twap.endIndex - twap.startIndex
            || twap.endTimestamp - twap.startTimestamp < TWAP_WINDOW_MS) revert InvalidTwapReference();

        ITellorDataBank.AggregateData memory start = dataBank.getAggregateByIndex(queryId, twap.startIndex);
        ITellorDataBank.AggregateData memory end = dataBank.getAggregateByIndex(queryId, twap.endIndex);
        (bool found, ITellorDataBank.AggregateData memory selectedEnd) = dataBank.getRelayBefore(queryId, cutoff);
        if (!found || start.aggregateTimestamp != twap.startTimestamp
            || end.aggregateTimestamp != twap.endTimestamp
            || selectedEnd.aggregateTimestamp != twap.endTimestamp
            || selectedEnd.relayTimestamp != end.relayTimestamp
            || end.relayTimestamp >= cutoff) revert InvalidTwapReference();
    }

}
