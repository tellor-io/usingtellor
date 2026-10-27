// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IBackupOracle} from "../interfaces/IBackupOracle.sol";
import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";
import {ITellorShepherd} from "../interfaces/ITellorShepherd.sol";

/**
 * @title TellorShepherd
 * @notice Per-feed Tellor safety layer with mature primary selection.
 * @dev Both consumer APIs enforce source timestamp freshness. Release validation
 * remains incomplete. This version is not ready for consumer deployment.
 */
contract TellorShepherd is ITellorShepherd {
    // Immutables
    bytes32 public immutable override queryId;
    uint8 public immutable override decimals;
    uint256 public immutable CHALLENGE_DELAY_SECONDS;
    uint256 public immutable PARAM_CHANGE_DELAY;
    uint256 public immutable MAX_PRICE_AGE;
    uint256 public immutable RECOVERY_DELAY_SECONDS;
    uint256 public immutable RELAY_READ_DELAY;
    uint256 public immutable TWAP_WINDOW_MS;

    // Storage
    // Both source addresses change only through delayed, paused migration.
    ITellorDataBank public dataBank;
    address public admin;
    address public backupOracle;
    address public pendingBackupOracle;
    address public pendingDataBank;
    uint256 public CHALLENGE_THRESHOLD_BPS;
    uint256 public pendingThresholdBps;
    uint256 public thresholdProposedAt;
    uint256 public challengeThresholdSnapshotBps;
    uint256 public backupProposedAt;
    uint256 public challengeAggregateTimestamp;
    uint256 public challengeReferenceValue;
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

    // Shared with the factory to keep deployment settings explicit and avoid constructor stack limits.
    struct Configuration {
        bytes32 queryId;
        address dataBank;
        address backupOracle;
        address admin;
        uint256 relayReadDelay;
        uint256 paramChangeDelay;
        uint256 twapWindowMs;
        uint256 challengeThresholdBps;
        uint256 challengeDelaySeconds;
        uint256 recoveryDelaySeconds;
        uint256 maxPriceAge;
        uint8 decimals;
    }

    // Constructor

    /**
     * @notice Binds the feed, initial sources, administrator, and read/transition policy.
     * @dev Code presence does not establish source compatibility or trustworthiness.
     * No existing feed history is required. Both sources must use the configured decimals;
     * values are never rescaled. Maximum source age must accommodate source and relay delays.
     * @param _configuration Nonzero query ID and admin, deployed sources, and positive durations.
     * Durations are seconds except twapWindowMs. The threshold is 1 to 9999 basis points.
     * Challenge wait must be positive and leave more than 60 seconds before the relay delay.
     */
    constructor(Configuration memory _configuration) {
        if (_configuration.queryId == bytes32(0)) revert InvalidQueryId();
        if (_configuration.dataBank.code.length == 0) revert DataBankHasNoCode();
        if (_configuration.backupOracle.code.length == 0) revert BackupOracleHasNoCode();
        if (_configuration.admin == address(0)) revert InvalidAdmin();
        if (_configuration.relayReadDelay == 0) revert InvalidRelayReadDelay();
        if (_configuration.paramChangeDelay == 0) revert InvalidParamChangeDelay();
        if (_configuration.twapWindowMs == 0) revert InvalidTwapWindow();

        if (_configuration.challengeThresholdBps == 0
            || _configuration.challengeThresholdBps >= 10000) revert InvalidChallengeThreshold();
        // Check ordering first so the resolution-window subtraction cannot underflow.
        if (_configuration.challengeDelaySeconds == 0
            || _configuration.challengeDelaySeconds >= _configuration.relayReadDelay
            || _configuration.relayReadDelay - _configuration.challengeDelaySeconds <= 60 seconds) {
            revert InvalidChallengeDelay();
        }

        if (_configuration.recoveryDelaySeconds == 0) revert InvalidRecoveryDelay();
        if (_configuration.maxPriceAge == 0
            || _configuration.maxPriceAge > type(uint256).max / 1000) revert InvalidMaxPriceAge();

        queryId = _configuration.queryId;
        dataBank = ITellorDataBank(_configuration.dataBank);
        backupOracle = _configuration.backupOracle;
        admin = _configuration.admin;
        RELAY_READ_DELAY = _configuration.relayReadDelay;
        PARAM_CHANGE_DELAY = _configuration.paramChangeDelay;
        TWAP_WINDOW_MS = _configuration.twapWindowMs;
        CHALLENGE_THRESHOLD_BPS = _configuration.challengeThresholdBps;
        CHALLENGE_DELAY_SECONDS = _configuration.challengeDelaySeconds;
        RECOVERY_DELAY_SECONDS = _configuration.recoveryDelaySeconds;
        MAX_PRICE_AGE = _configuration.maxPriceAge;
        decimals = _configuration.decimals;
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
     * @notice Cancels the backup proposal; admin only, including while paused.
     * @dev Does not call the target, so a broken backup cannot prevent cancellation.
     */
    function cancelBackupChange() external {
        if (msg.sender != admin) revert NotAdmin();
        address proposedBackup = pendingBackupOracle;
        if (proposedBackup == address(0)) revert NoPendingBackupChange();

        pendingBackupOracle = address(0);
        backupProposedAt = 0;
        emit BackupChangeCancelled(proposedBackup);
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
     * @notice Anyone may cancel a pending recovery when the backup explicitly returns false.
     * @dev No delay or pause restriction. Failed assessments revert without clearing state.
     * A transient false assessment does not reset the clock unless cancellation is submitted.
     */
    function cancelRecovery() external {
        if (mode != Mode.BACKUP) revert NotBackupMode();
        if (!recoveryPending) revert NoPendingRecovery();
        if (IBackupOracle(backupOracle).canRecover(queryId)) revert RecoveryStillAllowed();

        recoveryPending = false;
        recoveryRequestedAt = 0;
        emit RecoveryCancelled(msg.sender);
    }

    /**
     * @notice Replaces the backup after its notice period; admin only and paused.
     * @dev Equality permits execution. Invalidates transition requests; preserves mode, pause clock, and any bank proposal.
     */
    function executeBackupChange() external {
        if (msg.sender != admin) revert NotAdmin();
        address proposedBackup = pendingBackupOracle;
        if (proposedBackup == address(0)) revert NoPendingBackupChange();
        if (!paused) revert NotPaused();
        if (block.timestamp - backupProposedAt < PARAM_CHANGE_DELAY) revert BackupChangeDelayNotElapsed();
        _checkBackupCompatibility(proposedBackup);

        address previousBackup = backupOracle;
        backupOracle = proposedBackup;
        _invalidatePendingTransitions();
        pendingBackupOracle = address(0);
        backupProposedAt = 0;
        emit BackupChanged(previousBackup, proposedBackup);
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
        if (block.timestamp - dataBankProposedAt < PARAM_CHANGE_DELAY) revert DataBankChangeDelayNotElapsed();
        _checkDataBankCompatibility(proposedBank);

        address previousBank = address(dataBank);
        dataBank = ITellorDataBank(proposedBank);
        _invalidatePendingTransitions();
        pendingDataBank = address(0);
        dataBankProposedAt = 0;
        emit DataBankChanged(previousBank, proposedBank);
    }

    /**
     * @notice Anyone may return to primary after the recovery delay and a fresh approval.
     * @dev Equality permits execution; failed assessments preserve the pending timer.
     * Pause survives the switch. Primary readability is not an additional prerequisite.
     */
    function executeRecovery() external {
        if (mode != Mode.BACKUP) revert NotBackupMode();
        if (!recoveryPending) revert NoPendingRecovery();
        if (block.timestamp - recoveryRequestedAt < RECOVERY_DELAY_SECONDS) revert RecoveryDelayNotElapsed();
        if (!IBackupOracle(backupOracle).canRecover(queryId)) revert RecoveryNotAllowed();

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
     * @notice Proposes a backup replacement; admin only, paused or unpaused.
     * @dev Cancel before replacing a proposal. Requires a decodable getCurrentValue(queryId)
     * response at proposal and execution; this does not establish price truth or future availability.
     * @param _newBackupOracle Deployed backup that can currently answer the configured query.
     */
    function proposeBackupChange(address _newBackupOracle) external {
        if (msg.sender != admin) revert NotAdmin();
        if (pendingBackupOracle != address(0)) revert BackupChangePending();
        if (_newBackupOracle == backupOracle) revert BackupUnchanged();
        _checkBackupCompatibility(_newBackupOracle);

        pendingBackupOracle = _newBackupOracle;
        backupProposedAt = block.timestamp;
        emit BackupChangeProposed(_newBackupOracle, block.timestamp);
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
     * @dev Freezes the reference, threshold, and challenged aggregate timestamp. Pause does not block
     * diagnostics. Duplicate requests cannot restart the timer; pending challenges do not halt reads.
     */
    function requestChallenge() external {
        if (mode != Mode.PRIMARY) revert NotPrimaryMode();
        if (challengePending) revert ChallengeAlreadyPending();
        (bool available, bool deviating, uint256 referenceValue, uint256 aggregateTimestamp) = _readDeviation();
        if (!available) revert DiagnosticUnavailable();
        if (!deviating) revert NotDeviating();

        challengePending = true;
        challengeAggregateTimestamp = aggregateTimestamp;
        challengeReferenceValue = referenceValue;
        challengeThresholdSnapshotBps = CHALLENGE_THRESHOLD_BPS;
        challengeRequestedAt = block.timestamp;
        emit ChallengeRequested(msg.sender, block.timestamp);
    }

    /**
     * @notice Anyone may request recovery in backup mode when the backup approves the primary.
     * @dev Duplicate requests cannot reset the clock. Pause and backup price availability
     * do not gate assessment. The backup owns identifying and assessing the current primary.
     */
    function requestRecovery() external {
        if (mode != Mode.BACKUP) revert NotBackupMode();
        if (recoveryPending) revert RecoveryAlreadyPending();
        if (!IBackupOracle(backupOracle).canRecover(queryId)) revert RecoveryNotAllowed();

        recoveryPending = true;
        recoveryRequestedAt = block.timestamp;
        emit RecoveryRequested(msg.sender, block.timestamp);
    }

    /**
     * @notice Selects backup on a newer in-band report after the challenge wait, or expires the request.
     * @dev The reference and threshold are frozen at request. Exact delay equality permits switching; exact
     * read-delay equality still permits switching. After that, expiry clears state without source calls.
     * Expiry is measured from the request, not the report's relay time; timely monitoring remains essential.
     * Failed evidence preserves the request. Neither outcome changes pause or its clock.
     * Backup availability does not gate selection; failed backup reads subsequently revert.
     */
    function resolveChallenge() external {
        if (mode != Mode.PRIMARY) revert NotPrimaryMode();
        if (!challengePending) revert NoPendingChallenge();
        uint256 elapsed = block.timestamp - challengeRequestedAt;
        if (elapsed > RELAY_READ_DELAY) {
            _clearChallenge();
            emit ChallengeExpired(msg.sender);
            return;
        }
        if (elapsed < CHALLENGE_DELAY_SECONDS) revert ChallengeDelayNotElapsed();

        ITellorDataBank.AggregateData memory candidate = dataBank.getCurrentAggregateData(queryId);
        if (candidate.aggregateTimestamp <= challengeAggregateTimestamp) revert NoNewerReport();
        if (_isDeviating(candidate.value, challengeReferenceValue, challengeThresholdSnapshotBps)) revert StillDeviating();

        _clearChallenge();
        mode = Mode.BACKUP;
        emit ChallengeExecuted(msg.sender);
    }

    /**
     * @notice Restores consumer reads immediately; admin only.
     * @dev Both pending source proposals must be executed or cancelled first.
     */
    function unpause() external {
        if (msg.sender != admin) revert NotAdmin();
        if (!paused) revert NotPaused();
        if (pendingDataBank != address(0)) revert DataBankChangePending();
        if (pendingBackupOracle != address(0)) revert BackupChangePending();

        paused = false;
        pausedAt = 0;
        emit Unpaused(msg.sender);
    }

    /// @notice Proposes a threshold of 1–9999 bps; admin only, paused or unpaused.
    /// @dev Cancel before replacing a proposal. Existing challenges retain their saved threshold.
    function proposeThresholdChange(uint256 _newThresholdBps) external {
        if (msg.sender != admin) revert NotAdmin();
        if (pendingThresholdBps != 0) revert ThresholdChangePending();
        if (_newThresholdBps == 0 || _newThresholdBps >= 10000) revert InvalidChallengeThreshold();
        if (_newThresholdBps == CHALLENGE_THRESHOLD_BPS) revert ThresholdUnchanged();

        pendingThresholdBps = _newThresholdBps;
        thresholdProposedAt = block.timestamp;
        emit ThresholdChangeProposed(_newThresholdBps, block.timestamp);
    }

    /// @notice Cancels a threshold proposal immediately; admin only, paused or unpaused.
    function cancelThresholdChange() external {
        if (msg.sender != admin) revert NotAdmin();
        uint256 proposedThreshold = pendingThresholdBps;
        if (proposedThreshold == 0) revert NoPendingThresholdChange();

        pendingThresholdBps = 0;
        thresholdProposedAt = 0;
        emit ThresholdChangeCancelled(proposedThreshold);
    }

    /// @notice Applies a threshold after the shared notice period; admin only, paused or unpaused.
    /// @dev Does not change pending challenges, source proposals, recovery, or pause state.
    function executeThresholdChange() external {
        if (msg.sender != admin) revert NotAdmin();
        uint256 proposedThreshold = pendingThresholdBps;
        if (proposedThreshold == 0) revert NoPendingThresholdChange();
        if (block.timestamp - thresholdProposedAt < PARAM_CHANGE_DELAY) revert ThresholdChangeDelayNotElapsed();

        uint256 previousThreshold = CHALLENGE_THRESHOLD_BPS;
        CHALLENGE_THRESHOLD_BPS = proposedThreshold;
        pendingThresholdBps = 0;
        thresholdProposedAt = 0;
        emit ThresholdChanged(previousThreshold, proposedThreshold);
    }

    // Getter functions

    /**
     * @notice Returns the selected source's value and fresh timestamp, unless paused.
     * @dev Primary eligibility is strict: relayTimestamp < block.timestamp - RELAY_READ_DELAY.
     * Primary payloads need one ABI word; trailing bytes are accepted. Backup reads have no
     * Shepherd maturity delay and do not consult the primary. Invalid values or dependency
     * failures revert without substituting another source. Zero, future, and stale timestamps
     * revert. Age is checked in milliseconds; exact MAX_PRICE_AGE equality is allowed.
     * @return value The selected source's nonzero value.
     * @return aggregateTimestamp The unchanged source timestamp in milliseconds.
     */
    function getCurrentValue() external view override returns (uint256 value, uint256 aggregateTimestamp) {
        return _getCurrentValue();
    }

    /**
     * @notice Latest-price feed interface for consumers such as MorphoChainlinkOracleV2.
     * @dev Uses the same read policy as getCurrentValue; also requires an int256 price.
     * Timestamps are source milliseconds floored to seconds, never the current read time.
     * Round identifiers are zero sentinels: historical Chainlink rounds are not supported.
     */
    function latestRoundData() external view override returns (
        uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
    ) {
        (uint256 value, uint256 timestamp) = _getCurrentValue();
        if (value > uint256(type(int256).max)) revert PriceOutOfRange();
        uint256 timestampSeconds = timestamp / 1000;
        return (0, int256(value), timestampSeconds, timestampSeconds, 0);
    }

    // Internal functions

    /**
     * @dev Requires a successful, decodable getCurrentValue(queryId) response.
     * Does not validate price, timestamp, or recovery permission; unreadable targets are rejected.
     * A reverting call or undecodable response rejects the target; failures propagate.
     */
    function _checkBackupCompatibility(address _backup) internal view {
        if (_backup.code.length == 0) revert BackupHasNoCode();
        IBackupOracle(_backup).getCurrentValue(queryId);
    }

    /**
     * @dev Exercises the lookup ABI without requiring history or applying read eligibility.
     * A reverting call or undecodable response rejects the target; failures propagate.
     */
    function _checkDataBankCompatibility(address _bank) internal view {
        if (_bank.code.length == 0) revert DataBankHasNoCode();
        ITellorDataBank(_bank).getRelayBefore(queryId, block.timestamp);
    }

    /// @dev Clear the evidence together with its timer on resolution, expiry, or source migration.
    function _clearChallenge() internal {
        challengePending = false;
        challengeAggregateTimestamp = 0;
        challengeReferenceValue = 0;
        challengeThresholdSnapshotBps = 0;
        challengeRequestedAt = 0;
    }

    /// @dev Shared source selection, pause, value, and freshness policy for both consumer APIs.
    function _getCurrentValue() internal view returns (uint256 value, uint256 aggregateTimestamp) {
        if (paused) revert ShepherdPaused();
        if (mode == Mode.BACKUP) {
            (value, aggregateTimestamp) = _readBackup();
        } else {
            uint256 cutoff = block.timestamp - RELAY_READ_DELAY;
            (bool found, ITellorDataBank.AggregateData memory record) = dataBank.getRelayBefore(queryId, cutoff);
            if (!found) revert NoMatureData();
            if (record.value.length < 32) revert InvalidValueLength();
            value = abi.decode(record.value, (uint256));
            if (value == 0) revert ZeroValue();
            aggregateTimestamp = record.aggregateTimestamp;
        }
        uint256 nowMs = block.timestamp * 1000;
        if (aggregateTimestamp == 0 || aggregateTimestamp > nowMs) revert InvalidTimestamp();
        if (nowMs - aggregateTimestamp > MAX_PRICE_AGE * 1000) revert StalePrice();
    }

    /// @dev A changed dependency requires fresh assessment and a fresh transition timer.
    /// Called only after migration checks succeed; never consults the replaced sources.
    function _invalidatePendingTransitions() internal {
        if (challengePending) {
            _clearChallenge();
            emit ChallengeInvalidated();
        }
        if (recoveryPending) {
            recoveryPending = false;
            recoveryRequestedAt = 0;
            emit RecoveryInvalidated();
        }
    }

    function _isDeviating(bytes memory _value, uint256 _reference, uint256 _thresholdBps) internal pure returns (bool) {
        if (_value.length < 32) revert InvalidValueLength();
        uint256 value = abi.decode(_value, (uint256));
        if (value == 0) revert ZeroValue();
        uint256 difference = value > _reference ? value - _reference : _reference - value;
        // Exactly floor(reference * threshold / 10000), without an overflowing product.
        // Integer difference > this floor is equivalent to the strict rational comparison.
        uint256 allowedDifference = (_reference / 10000) * _thresholdBps
            + ((_reference % 10000) * _thresholdBps) / 10000;
        return difference > allowedDifference;
    }

    /**
     * @dev Reads the configured backup without substituting another source on failure.
     * Observation eligibility belongs to the backup. Preserve its millisecond timestamp.
     * Consumer pause and timestamp checks belong to _getCurrentValue, not this source helper.
     */
    function _readBackup() internal view returns (uint256 value, uint256 timestamp) {
        (value, timestamp) = IBackupOracle(backupOracle).getCurrentValue(queryId);
        if (value == 0) revert ZeroValue();
    }

    /**
     * @dev Request diagnostic and evidence snapshot; independent of pause and consumer reads.
     * Missing reference history is not evidence of resolved deviation. Broken dependencies revert.
     * Inspect the latest candidate immediately, even when its relay is not yet consumable.
     */
    function _readDeviation() internal view returns (
        bool available, bool deviating, uint256 referenceValue, uint256 aggregateTimestamp
    ) {
        ITellorDataBank.TwapData memory twap;
        (available, twap) = _readTwapReference();
        if (!available) return (false, false, 0, 0);

        ITellorDataBank.AggregateData memory candidate = dataBank.getCurrentAggregateData(queryId);
        return (true, _isDeviating(candidate.value, twap.value, CHALLENGE_THRESHOLD_BPS), twap.value, candidate.aggregateTimestamp);
    }

    /**
     * @dev Reads a diagnostic reference independently of consumer reads and pause state.
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
