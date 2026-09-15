// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IBackupOracle} from "../interfaces/IBackupOracle.sol";
import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";
import {ITellorShepherd} from "../interfaces/ITellorShepherd.sol";

/**
 * @title TellorShepherd
 * @notice A view-first safety layer for one Tellor SpotPrice query.
 * @dev Reads use a delayed DataBank relay. A persistent TWAP deviation can be
 *      challenged permissionlessly; after the delay, a still-deviant feed
 *      switches to the constructor-set backup oracle until that oracle says
 *      it is safe to return.
 */
contract TellorShepherd is ITellorShepherd {
    uint256 public constant BPS_DENOMINATOR = 10_000;

    struct Parameters {
        // EVM-time seconds.
        uint256 relayConsumptionDelay;
        // Tellor aggregate-time milliseconds.
        uint256 twapWindow;
        uint256 minTwapCoverage;
        uint256 maxTwapCoverage;
        uint256 minTwapObservations;
        uint256 deviationThresholdBps;
        uint256 challengeDelay;
        uint256 unpauseDelay;
        uint256 dataBankChangeDelay;
        uint256 roleChangeDelay;
        uint256 adminTransferDelay;
    }

    ITellorDataBank public dataBank;
    IBackupOracle public immutable backupOracle;
    address public admin;
    bytes32 public immutable queryId;

    uint256 public immutable RELAY_CONSUMPTION_DELAY; // EVM-time seconds
    // The following three values use Tellor aggregate-time milliseconds.
    uint256 public immutable TWAP_WINDOW;
    uint256 public immutable MIN_TWAP_COVERAGE;
    uint256 public immutable MAX_TWAP_COVERAGE;
    uint256 public immutable MIN_TWAP_OBSERVATIONS;
    uint256 public immutable DEVIATION_THRESHOLD_BPS;
    uint256 public immutable CHALLENGE_DELAY;
    uint256 public immutable UNPAUSE_DELAY;
    uint256 public immutable DATA_BANK_CHANGE_DELAY;
    uint256 public immutable ROLE_CHANGE_DELAY;
    uint256 public immutable ADMIN_TRANSFER_DELAY;

    bool public paused;
    bool public usingBackup;
    uint256 public challengeStartTime;

    mapping(address => bool) public pausers;
    mapping(address => uint256) public pauserAdditionProposalTime;

    uint256 public unpauseProposalTime;
    address public proposedDataBank;
    uint256 public dataBankProposalTime;
    address public proposedAdmin;
    uint256 public adminTransferProposalTime;

    error InvalidConfiguration();
    error NotAdmin();
    error NotPauser();
    error ShepherdPaused();
    error PriceUnavailable(Status status);
    error InvalidProposal();
    error DelayNotPassed();
    error ChallengeNotRequired();
    error ChallengePending();
    error NoChallenge();
    error UsingBackup();
    error BackupNotReady();
    error BackupReadyToReturn();

    event Paused(address indexed account);
    event Unpaused();
    event UnpauseProposed(uint256 executableAt);
    event UnpauseCancelled();

    event ChallengeOpened(address indexed challenger, uint256 executableAt);
    event ChallengeCleared(address indexed account);
    event ChallengeExecuted(
        address indexed account,
        uint256 candidateValue,
        uint256 twap,
        uint256 deviationBps
    );
    event ReturnedToPrimary(address indexed account);

    event PauserAdditionProposed(address indexed account, uint256 executableAt);
    event PauserAdded(address indexed account);
    event PauserRemoved(address indexed account);

    event DataBankChangeProposed(
        address indexed proposedDataBank,
        uint256 executableAt
    );
    event DataBankChangeCancelled();
    event DataBankChanged(
        address indexed oldDataBank,
        address indexed newDataBank
    );
    event AdminTransferProposed(
        address indexed proposedAdmin,
        uint256 executableAt
    );
    event AdminTransferCancelled();
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    constructor(
        address _dataBank,
        address _admin,
        address _backupOracle,
        bytes32 _queryId,
        Parameters memory _parameters,
        address[] memory _pausers
    ) {
        if (
            _dataBank == address(0) ||
            _dataBank.code.length == 0 ||
            _admin == address(0) ||
            _backupOracle == address(0) ||
            _queryId == bytes32(0) ||
            _parameters.twapWindow == 0 ||
            _parameters.minTwapCoverage == 0 ||
            _parameters.minTwapCoverage > _parameters.twapWindow ||
            _parameters.maxTwapCoverage < _parameters.twapWindow ||
            _parameters.minTwapObservations < 2 ||
            _parameters.deviationThresholdBps == 0 ||
            _parameters.deviationThresholdBps > BPS_DENOMINATOR
        ) revert InvalidConfiguration();

        dataBank = ITellorDataBank(_dataBank);
        backupOracle = IBackupOracle(_backupOracle);
        admin = _admin;
        queryId = _queryId;

        RELAY_CONSUMPTION_DELAY = _parameters.relayConsumptionDelay;
        TWAP_WINDOW = _parameters.twapWindow;
        MIN_TWAP_COVERAGE = _parameters.minTwapCoverage;
        MAX_TWAP_COVERAGE = _parameters.maxTwapCoverage;
        MIN_TWAP_OBSERVATIONS = _parameters.minTwapObservations;
        DEVIATION_THRESHOLD_BPS = _parameters.deviationThresholdBps;
        CHALLENGE_DELAY = _parameters.challengeDelay;
        UNPAUSE_DELAY = _parameters.unpauseDelay;
        DATA_BANK_CHANGE_DELAY = _parameters.dataBankChangeDelay;
        ROLE_CHANGE_DELAY = _parameters.roleChangeDelay;
        ADMIN_TRANSFER_DELAY = _parameters.adminTransferDelay;

        for (uint256 i; i < _pausers.length; ++i) {
            _addInitialRole(_pausers[i], pausers);
            emit PauserAdded(_pausers[i]);
        }
    }

    // ---------------------------------------------------------------------
    // Price reads
    // ---------------------------------------------------------------------

    function getCurrentValue()
        external
        view
        override
        returns (uint256 _value, uint256 _aggregateTimestamp)
    {
        if (paused) revert ShepherdPaused();

        if (usingBackup) {
            return backupOracle.getCurrentValue();
        }

        PricePreview memory _preview = _previewNormalValue();
        if (
            _preview.status != Status.NORMAL &&
            _preview.status != Status.DEVIATING
        ) {
            revert PriceUnavailable(_preview.status);
        }
        return (
            _preview.candidateValue,
            _preview.candidateAggregateTimestamp
        );
    }

    function previewValue()
        external
        view
        override
        returns (PricePreview memory _preview)
    {
        if (paused) {
            _preview.status = Status.PAUSED;
            return _preview;
        }

        if (usingBackup) {
            (
                uint256 _value,
                uint256 _timestamp
            ) = backupOracle.getCurrentValue();
            _preview.status = Status.BACKUP;
            _preview.candidateValue = _value;
            _preview.candidateAggregateTimestamp = _timestamp;
            return _preview;
        }

        _preview = _previewNormalValue();
        if (challengeStartTime != 0) {
            _preview.status = Status.CHALLENGING;
        }
    }

    // ---------------------------------------------------------------------
    // Challenge
    // ---------------------------------------------------------------------

    /**
     * @notice Starts the challenge delay when the delayed relay exceeds the TWAP threshold.
     * @dev Reads continue to return the delayed DataBank relay until `executeChallenge`.
     */
    function challenge() external {
        if (usingBackup) revert UsingBackup();
        if (challengeStartTime != 0) revert ChallengePending();
        if (_previewNormalValue().status != Status.DEVIATING) {
            revert ChallengeNotRequired();
        }

        challengeStartTime = block.timestamp;
        emit ChallengeOpened(msg.sender, block.timestamp + CHALLENGE_DELAY);
    }

    /**
     * @notice Completes a matured challenge. Switches to the backup oracle if still deviant.
     */
    function executeChallenge() external {
        if (usingBackup) revert UsingBackup();
        if (challengeStartTime == 0) revert NoChallenge();
        if (block.timestamp < challengeStartTime + CHALLENGE_DELAY) {
            revert DelayNotPassed();
        }

        PricePreview memory _preview = _previewNormalValue();
        if (_preview.status != Status.DEVIATING) {
            delete challengeStartTime;
            emit ChallengeCleared(msg.sender);
            return;
        }

        backupOracle.getCurrentValue();
        if (backupOracle.readyToReturn()) revert BackupReadyToReturn();
        usingBackup = true;
        delete challengeStartTime;
        emit ChallengeExecuted(
            msg.sender,
            _preview.candidateValue,
            _preview.twap,
            _preview.deviationBps
        );
    }

    /**
     * @notice Returns to delayed Tellor data once the backup oracle signals it is safe.
     */
    function returnToPrimary() external {
        if (!usingBackup) revert InvalidProposal();
        if (!backupOracle.readyToReturn()) revert BackupNotReady();

        usingBackup = false;
        emit ReturnedToPrimary(msg.sender);
    }

    // ---------------------------------------------------------------------
    // Pause controls
    // ---------------------------------------------------------------------

    function pause() external {
        if (msg.sender != admin && !pausers[msg.sender]) revert NotPauser();
        if (paused) revert InvalidProposal();

        paused = true;
        delete unpauseProposalTime;
        emit Paused(msg.sender);
    }

    function proposeUnpause() external onlyAdmin {
        if (!paused || unpauseProposalTime != 0) revert InvalidProposal();
        unpauseProposalTime = block.timestamp;
        emit UnpauseProposed(block.timestamp + UNPAUSE_DELAY);
    }

    function cancelUnpause() external onlyAdmin {
        if (unpauseProposalTime == 0) revert InvalidProposal();
        delete unpauseProposalTime;
        emit UnpauseCancelled();
    }

    function executeUnpause() external onlyAdmin {
        if (!paused || unpauseProposalTime == 0) revert InvalidProposal();
        if (block.timestamp < unpauseProposalTime + UNPAUSE_DELAY) {
            revert DelayNotPassed();
        }

        paused = false;
        delete unpauseProposalTime;
        emit Unpaused();
    }

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    function proposePauser(address _account) external onlyAdmin {
        _proposeRole(_account, pauserAdditionProposalTime, pausers);
        emit PauserAdditionProposed(
            _account,
            block.timestamp + ROLE_CHANGE_DELAY
        );
    }

    function executePauser(address _account) external {
        _executeRole(_account, pauserAdditionProposalTime, pausers);
        emit PauserAdded(_account);
    }

    function removePauser(address _account) external onlyAdmin {
        if (!pausers[_account]) revert InvalidProposal();
        pausers[_account] = false;
        emit PauserRemoved(_account);
    }

    // ---------------------------------------------------------------------
    // DataBank and admin changes
    // ---------------------------------------------------------------------

    function proposeDataBank(address _newDataBank) external onlyAdmin {
        if (
            proposedDataBank != address(0) ||
            _newDataBank == address(0) ||
            _newDataBank.code.length == 0 ||
            _newDataBank == address(dataBank)
        ) revert InvalidProposal();

        proposedDataBank = _newDataBank;
        dataBankProposalTime = block.timestamp;
        emit DataBankChangeProposed(
            _newDataBank,
            block.timestamp + DATA_BANK_CHANGE_DELAY
        );
    }

    function cancelDataBankChange() external onlyAdmin {
        if (proposedDataBank == address(0)) revert InvalidProposal();
        delete proposedDataBank;
        delete dataBankProposalTime;
        emit DataBankChangeCancelled();
    }

    function executeDataBankChange() external onlyAdmin {
        if (proposedDataBank == address(0)) revert InvalidProposal();
        if (block.timestamp < dataBankProposalTime + DATA_BANK_CHANGE_DELAY) {
            revert DelayNotPassed();
        }
        if (!paused) revert ShepherdPaused();

        address _oldDataBank = address(dataBank);
        dataBank = ITellorDataBank(proposedDataBank);
        delete proposedDataBank;
        delete dataBankProposalTime;
        emit DataBankChanged(_oldDataBank, address(dataBank));
    }

    function proposeAdmin(address _newAdmin) external onlyAdmin {
        if (_newAdmin == address(0) || proposedAdmin != address(0)) {
            revert InvalidProposal();
        }
        proposedAdmin = _newAdmin;
        adminTransferProposalTime = block.timestamp;
        emit AdminTransferProposed(
            _newAdmin,
            block.timestamp + ADMIN_TRANSFER_DELAY
        );
    }

    function cancelAdminTransfer() external onlyAdmin {
        if (proposedAdmin == address(0)) revert InvalidProposal();
        delete proposedAdmin;
        delete adminTransferProposalTime;
        emit AdminTransferCancelled();
    }

    function acceptAdmin() external {
        if (msg.sender != proposedAdmin) revert NotAdmin();
        if (
            block.timestamp <
            adminTransferProposalTime + ADMIN_TRANSFER_DELAY
        ) revert DelayNotPassed();

        address _oldAdmin = admin;
        admin = msg.sender;
        delete proposedAdmin;
        delete adminTransferProposalTime;
        emit AdminTransferred(_oldAdmin, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Internal price evaluation
    // ---------------------------------------------------------------------

    function _previewNormalValue()
        internal
        view
        returns (PricePreview memory _preview)
    {
        if (block.timestamp <= RELAY_CONSUMPTION_DELAY) return _preview;

        (
            bool _found,
            uint256 _index,
            ITellorDataBank.AggregateData memory _data,
            ITellorDataBank.TwapData memory _twap
        ) = dataBank.getRelayWithTwapBefore(
                queryId,
                block.timestamp - RELAY_CONSUMPTION_DELAY,
                TWAP_WINDOW
            );

        if (!_found) return _preview;
        return _evaluate(_index, _data, _twap);
    }

    function _evaluate(
        uint256 _index,
        ITellorDataBank.AggregateData memory _data,
        ITellorDataBank.TwapData memory _twap
    ) internal view returns (PricePreview memory _preview) {
        _preview.candidateIndex = _index;
        _preview.candidateAggregateTimestamp = _data.aggregateTimestamp;
        _preview.candidateRelayTimestamp = _data.relayTimestamp;
        _preview.twap = _twap.price;
        _preview.twapStartTimestamp = _twap.startAggregateTimestamp;
        _preview.twapEndTimestamp = _twap.endAggregateTimestamp;
        _preview.observationCount = _twap.observationCount;

        uint256 _maxSpotPrice = dataBank.MAX_SPOT_PRICE();
        if (
            _data.value.length != 32 ||
            _twap.price == 0 ||
            _twap.price > _maxSpotPrice
        ) {
            _preview.status = Status.INVALID_PRICE;
            return _preview;
        }
        _preview.candidateValue = abi.decode(_data.value, (uint256));
        if (
            _preview.candidateValue == 0 ||
            _preview.candidateValue > _maxSpotPrice
        ) {
            _preview.status = Status.INVALID_PRICE;
            return _preview;
        }

        uint256 _coverage =
            _twap.endAggregateTimestamp -
            _twap.startAggregateTimestamp;
        if (
            _coverage < MIN_TWAP_COVERAGE ||
            _coverage > MAX_TWAP_COVERAGE ||
            _twap.observationCount < MIN_TWAP_OBSERVATIONS
        ) {
            _preview.status = Status.INVALID_COVERAGE;
            return _preview;
        }

        _preview.deviationBps = _calculateDeviationBps(
            _preview.candidateValue,
            _twap.price
        );
        _preview.status = _preview.deviationBps > DEVIATION_THRESHOLD_BPS
            ? Status.DEVIATING
            : Status.NORMAL;
    }

    function _calculateDeviationBps(uint256 _value, uint256 _reference)
        internal
        pure
        returns (uint256)
    {
        uint256 _difference = _value > _reference
            ? _value - _reference
            : _reference - _value;
        if (_difference > type(uint256).max / BPS_DENOMINATOR) {
            return type(uint256).max;
        }
        return (_difference * BPS_DENOMINATOR) / _reference;
    }

    // ---------------------------------------------------------------------
    // Internal administration
    // ---------------------------------------------------------------------

    function _addInitialRole(
        address _account,
        mapping(address => bool) storage _role
    ) internal {
        if (_account == address(0)) revert InvalidConfiguration();
        _role[_account] = true;
    }

    function _proposeRole(
        address _account,
        mapping(address => uint256) storage _proposalTime,
        mapping(address => bool) storage _role
    ) internal {
        if (
            _account == address(0) ||
            _role[_account] ||
            _proposalTime[_account] != 0
        ) revert InvalidProposal();
        _proposalTime[_account] = block.timestamp;
    }

    function _executeRole(
        address _account,
        mapping(address => uint256) storage _proposalTime,
        mapping(address => bool) storage _role
    ) internal {
        uint256 _proposedAt = _proposalTime[_account];
        if (_proposedAt == 0) revert InvalidProposal();
        if (block.timestamp < _proposedAt + ROLE_CHANGE_DELAY) {
            revert DelayNotPassed();
        }
        _role[_account] = true;
        delete _proposalTime[_account];
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }
}
