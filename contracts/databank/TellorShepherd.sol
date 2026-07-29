// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {ITellorDataBank} from "../interfaces/ITellorDataBank.sol";

/// @notice Per-consumer delayed oracle cache for one immutable Tellor query ID.
contract TellorShepherd {
    struct OverrideSubmission {
        uint256 value;
        uint256 timestamp;
    }

    ITellorDataBank public dataBank;
    address public admin;
    bytes32 public immutable queryId;
    uint256 public immutable RELAY_CONSUMPTION_DELAY;
    uint256 public immutable UNPAUSE_DELAY;
    uint256 public immutable DATA_BANK_CHANGE_DELAY;
    uint256 public immutable THRESHOLD_CHANGE_DELAY;
    uint256 public immutable OVERRIDE_ENTRY_DELAY;
    uint256 public immutable OVERRIDE_EXIT_DELAY;
    uint256 public immutable ROLE_CHANGE_DELAY;
    uint256 public immutable ADMIN_TRANSFER_DELAY;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    uint256 public lastReturnedValue;
    uint256 public lastReturnedTimestamp;
    uint256 public lastRelayTimestamp;
    uint256 public lastTellorAggregateTimestamp;
    uint256 public priceChangeThresholdBps;
    bool public paused;
    bool public overrideActive;
    bool public permissionlessRetrieval;
    mapping(address => bool) public pausers;
    mapping(address => bool) public overriders;
    mapping(address => bool) public retrievalCallers;
    mapping(address => uint256) public pauserAdditionProposalTime;
    mapping(address => uint256) public overriderAdditionProposalTime;
    OverrideSubmission[] private overrideSubmissions;

    uint256 public unpauseProposalTime;
    address public proposedDataBank;
    uint256 public dataBankProposalTime;
    uint256 public proposedPriceChangeThresholdBps;
    uint256 public thresholdProposalTime;
    uint256 public overrideEntryProposalTime;
    uint256 public overrideExitProposalTime;
    address public proposedAdmin;
    uint256 public adminTransferProposalTime;

    event OracleUpdated(
        uint256 value,
        uint256 aggregateTimestamp,
        uint256 relayTimestamp
    );
    event OverrideSubmitted(
        uint256 value,
        uint256 timestamp,
        address indexed submitter
    );
    event OverrideEntered(uint256 value, uint256 timestamp);
    event OverrideExited(
        uint256 value,
        uint256 aggregateTimestamp,
        uint256 relayTimestamp
    );
    event Paused(address indexed pauser);
    event Unpaused();
    event UnpauseProposed();
    event UnpauseCancelled();
    event PauserAdditionProposed(address indexed account);
    event PauserAdded(address indexed account);
    event PauserRemoved(address indexed account);
    event OverriderAdditionProposed(address indexed account);
    event OverriderAdded(address indexed account);
    event OverriderRemoved(address indexed account);
    event RetrievalCallerSet(address indexed account, bool allowed);
    event PermissionlessRetrievalSet(bool enabled);
    event OverrideEntryProposed();
    event OverrideEntryCancelled();
    event OverrideExitProposed();
    event OverrideExitCancelled();
    event AdminTransferProposed(address indexed proposedAdmin);
    event AdminTransferCancelled();
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event DataBankChangeProposed(address indexed proposedDataBank);
    event DataBankChangeCancelled();
    event DataBankChangeExecuted(
        address indexed oldDataBank,
        address indexed newDataBank
    );
    event PriceChangeThresholdChangeProposed(uint256 proposedThresholdBps);
    event PriceChangeThresholdChangeCancelled();
    event PriceChangeThresholdChangeExecuted(
        uint256 oldThresholdBps,
        uint256 newThresholdBps
    );

    constructor(
        address _dataBank,
        address _admin,
        bytes32 _queryId,
        uint256 _threshold,
        uint256 _delay,
        uint256 _unpauseDelay,
        uint256 _dataBankDelay,
        uint256 _thresholdDelay,
        uint256 _overrideEntryDelay,
        uint256 _overrideExitDelay,
        uint256 _roleDelay,
        uint256 _adminDelay,
        address[] memory _pausers,
        address[] memory _overriders,
        address[] memory _retrievers,
        bool _permissionless
    ) {
        require(
            _dataBank != address(0) && _dataBank.code.length > 0,
            "Shepherd: invalid DataBank"
        );
        require(_admin != address(0), "Shepherd: invalid admin");
        require(_threshold <= BPS_DENOMINATOR, "Shepherd: invalid threshold");
        dataBank = ITellorDataBank(_dataBank);
        admin = _admin;
        queryId = _queryId;
        priceChangeThresholdBps = _threshold;
        RELAY_CONSUMPTION_DELAY = _delay;
        UNPAUSE_DELAY = _unpauseDelay;
        DATA_BANK_CHANGE_DELAY = _dataBankDelay;
        THRESHOLD_CHANGE_DELAY = _thresholdDelay;
        OVERRIDE_ENTRY_DELAY = _overrideEntryDelay;
        OVERRIDE_EXIT_DELAY = _overrideExitDelay;
        ROLE_CHANGE_DELAY = _roleDelay;
        ADMIN_TRANSFER_DELAY = _adminDelay;
        permissionlessRetrieval = _permissionless;
        for (uint256 i; i < _pausers.length; i++) {
            require(_pausers[i] != address(0), "Shepherd: zero pauser");
            pausers[_pausers[i]] = true;
            emit PauserAdded(_pausers[i]);
        }
        for (uint256 i; i < _overriders.length; i++) {
            require(_overriders[i] != address(0), "Shepherd: zero overrider");
            overriders[_overriders[i]] = true;
            emit OverriderAdded(_overriders[i]);
        }
        for (uint256 i; i < _retrievers.length; i++) {
            require(_retrievers[i] != address(0), "Shepherd: zero retriever");
            retrievalCallers[_retrievers[i]] = true;
            emit RetrievalCallerSet(_retrievers[i], true);
        }
    }

    function retrieveData() external returns (uint256, uint256) {
        require(!paused, "Shepherd: paused");
        _onlyRetriever();
        if (overrideActive) return _consumeNewestOverride();
        return _retrieveTellor(false);
    }

    function getCurrentValue() external view returns (uint256, uint256) {
        require(!paused, "Shepherd: paused");
        require(lastReturnedTimestamp != 0, "Shepherd: no value");
        return (lastReturnedValue, lastReturnedTimestamp);
    }

    function overrideSubmissionCount() external view returns (uint256) {
        return overrideSubmissions.length;
    }

    function getOverrideSubmission(
        uint256 i
    ) external view returns (OverrideSubmission memory) {
        return overrideSubmissions[i];
    }

    function pause() external {
        require(
            pausers[msg.sender] || msg.sender == admin,
            "Shepherd: not pauser"
        );
        require(!paused, "Shepherd: already paused");
        paused = true;
        delete unpauseProposalTime;
        emit Paused(msg.sender);
    }

    function proposeUnpause() external onlyAdmin {
        require(
            paused && unpauseProposalTime == 0,
            "Shepherd: invalid unpause proposal"
        );
        unpauseProposalTime = block.timestamp;
        emit UnpauseProposed();
    }

    function cancelUnpause() external onlyAdmin {
        require(unpauseProposalTime != 0, "Shepherd: no unpause proposal");
        delete unpauseProposalTime;
        emit UnpauseCancelled();
    }

    function executeUnpause() external onlyAdmin {
        require(
            paused && unpauseProposalTime != 0,
            "Shepherd: no unpause proposal"
        );
        require(
            block.timestamp >= unpauseProposalTime + UNPAUSE_DELAY,
            "Shepherd: unpause delay"
        );
        paused = false;
        delete unpauseProposalTime;
        emit Unpaused();
    }

    function proposePauser(address a) external onlyAdmin {
        _proposeRole(
            a,
            pauserAdditionProposalTime,
            pausers,
            "Shepherd: pauser exists"
        );
        emit PauserAdditionProposed(a);
    }

    function executePauser(address a) external {
        _executeRole(a, pauserAdditionProposalTime, pausers);
        emit PauserAdded(a);
    }

    function removePauser(address a) external onlyAdmin {
        require(pausers[a], "Shepherd: not pauser");
        pausers[a] = false;
        emit PauserRemoved(a);
    }

    function proposeOverrider(address a) external onlyAdmin {
        _proposeRole(
            a,
            overriderAdditionProposalTime,
            overriders,
            "Shepherd: overrider exists"
        );
        emit OverriderAdditionProposed(a);
    }

    function executeOverrider(address a) external {
        _executeRole(a, overriderAdditionProposalTime, overriders);
        emit OverriderAdded(a);
    }

    function removeOverrider(address a) external onlyAdmin {
        require(overriders[a], "Shepherd: not overrider");
        overriders[a] = false;
        emit OverriderRemoved(a);
    }

    function setRetrievalCaller(address a, bool allowed) external onlyAdmin {
        require(a != address(0), "Shepherd: zero retriever");
        retrievalCallers[a] = allowed;
        emit RetrievalCallerSet(a, allowed);
    }

    function setPermissionlessRetrieval(bool enabled) external onlyAdmin {
        permissionlessRetrieval = enabled;
        emit PermissionlessRetrievalSet(enabled);
    }

    function proposeOverrideEntry() external onlyAdmin {
        require(
            paused && !overrideActive && overrideEntryProposalTime == 0,
            "Shepherd: invalid override entry"
        );
        overrideEntryProposalTime = block.timestamp;
        emit OverrideEntryProposed();
    }

    function cancelOverrideEntry() external onlyAdmin {
        require(
            overrideEntryProposalTime != 0,
            "Shepherd: no override entry proposal"
        );
        delete overrideEntryProposalTime;
        emit OverrideEntryCancelled();
    }

    function executeOverrideEntry(uint256 value) external onlyAdmin {
        require(
            paused && !overrideActive && overrideEntryProposalTime != 0,
            "Shepherd: invalid override entry"
        );
        require(
            block.timestamp >= overrideEntryProposalTime + OVERRIDE_ENTRY_DELAY,
            "Shepherd: override entry delay"
        );
        overrideActive = true;
        delete overrideEntryProposalTime;
        _submitOverride(value);
        emit OverrideEntered(value, block.timestamp);
    }

    function submitOverride(uint256 value) external {
        require(overrideActive, "Shepherd: override inactive");
        require(overriders[msg.sender], "Shepherd: not overrider");
        _submitOverride(value);
    }

    function proposeOverrideExit() external onlyAdmin {
        require(
            overrideActive && overrideExitProposalTime == 0,
            "Shepherd: invalid override exit"
        );
        overrideExitProposalTime = block.timestamp;
        emit OverrideExitProposed();
    }

    function cancelOverrideExit() external onlyAdmin {
        require(
            overrideExitProposalTime != 0,
            "Shepherd: no override exit proposal"
        );
        delete overrideExitProposalTime;
        emit OverrideExitCancelled();
    }

    function executeOverrideExit() external onlyAdmin {
        require(
            overrideActive && overrideExitProposalTime != 0,
            "Shepherd: invalid override exit"
        );
        require(
            block.timestamp >= overrideExitProposalTime + OVERRIDE_EXIT_DELAY,
            "Shepherd: override exit delay"
        );
        (uint256 v, uint256 t) = _retrieveTellor(true);
        overrideActive = false;
        delete overrideExitProposalTime;
        emit OverrideExited(v, t, lastRelayTimestamp);
    }

    function proposeAdmin(address a) external onlyAdmin {
        require(
            a != address(0) && proposedAdmin == address(0),
            "Shepherd: invalid admin proposal"
        );
        proposedAdmin = a;
        adminTransferProposalTime = block.timestamp;
        emit AdminTransferProposed(a);
    }

    function cancelAdminTransfer() external onlyAdmin {
        require(proposedAdmin != address(0), "Shepherd: no admin proposal");
        delete proposedAdmin;
        delete adminTransferProposalTime;
        emit AdminTransferCancelled();
    }

    function acceptAdmin() external {
        require(msg.sender == proposedAdmin, "Shepherd: not proposed admin");
        require(
            block.timestamp >= adminTransferProposalTime + ADMIN_TRANSFER_DELAY,
            "Shepherd: admin transfer delay"
        );
        address old = admin;
        admin = msg.sender;
        delete proposedAdmin;
        delete adminTransferProposalTime;
        emit AdminTransferred(old, msg.sender);
    }

    function proposeDataBank(address a) external onlyAdmin {
        require(
            proposedDataBank == address(0) &&
                a != address(0) &&
                a.code.length > 0 &&
                a != address(dataBank),
            "Shepherd: invalid DataBank proposal"
        );
        proposedDataBank = a;
        dataBankProposalTime = block.timestamp;
        emit DataBankChangeProposed(a);
    }

    function cancelDataBankChange() external onlyAdmin {
        require(
            proposedDataBank != address(0),
            "Shepherd: no DataBank proposal"
        );
        delete proposedDataBank;
        delete dataBankProposalTime;
        emit DataBankChangeCancelled();
    }

    function executeDataBankChange() external onlyAdmin {
        require(
            proposedDataBank != address(0) &&
                block.timestamp >=
                dataBankProposalTime + DATA_BANK_CHANGE_DELAY,
            "Shepherd: DataBank delay"
        );
        address old = address(dataBank);
        dataBank = ITellorDataBank(proposedDataBank);
        delete proposedDataBank;
        delete dataBankProposalTime;
        emit DataBankChangeExecuted(old, address(dataBank));
    }

    function proposePriceChangeThreshold(uint256 bps) external onlyAdmin {
        require(
            thresholdProposalTime == 0 &&
                bps <= BPS_DENOMINATOR &&
                bps != priceChangeThresholdBps,
            "Shepherd: invalid threshold proposal"
        );
        proposedPriceChangeThresholdBps = bps;
        thresholdProposalTime = block.timestamp;
        emit PriceChangeThresholdChangeProposed(bps);
    }

    function cancelPriceChangeThreshold() external onlyAdmin {
        require(thresholdProposalTime != 0, "Shepherd: no threshold proposal");
        delete proposedPriceChangeThresholdBps;
        delete thresholdProposalTime;
        emit PriceChangeThresholdChangeCancelled();
    }

    function executePriceChangeThreshold() external onlyAdmin {
        require(
            thresholdProposalTime != 0 &&
                block.timestamp >=
                thresholdProposalTime + THRESHOLD_CHANGE_DELAY,
            "Shepherd: threshold delay"
        );
        uint256 old = priceChangeThresholdBps;
        priceChangeThresholdBps = proposedPriceChangeThresholdBps;
        delete proposedPriceChangeThresholdBps;
        delete thresholdProposalTime;
        emit PriceChangeThresholdChangeExecuted(old, priceChangeThresholdBps);
    }

    function _retrieveTellor(
        bool recovery
    ) internal returns (uint256, uint256) {
        (bool found, ITellorDataBank.AggregateData memory d) = dataBank
            .getRelayBefore(queryId, block.timestamp - RELAY_CONSUMPTION_DELAY);
        if (!found || d.value.length == 0) {
            if (recovery) revert("Shepherd: no recovery value");
            require(lastReturnedTimestamp != 0, "Shepherd: no Tellor value");
            return (lastReturnedValue, lastReturnedTimestamp);
        }
        if (!recovery && d.aggregateTimestamp <= lastTellorAggregateTimestamp)
            return (lastReturnedValue, lastReturnedTimestamp);
        require(
            d.relayTimestamp > lastRelayTimestamp,
            "Shepherd: relay timestamp"
        );
        uint256 value = abi.decode(d.value, (uint256));
        if (recovery)
            require(
                d.aggregateTimestamp > lastReturnedTimestamp,
                "Shepherd: recovery timestamp"
            );
        require(
            _withinThreshold(value),
            recovery
                ? "Shepherd: recovery deviation"
                : "Shepherd: price deviation"
        );
        lastReturnedValue = value;
        lastReturnedTimestamp = d.aggregateTimestamp;
        lastTellorAggregateTimestamp = d.aggregateTimestamp;
        lastRelayTimestamp = d.relayTimestamp;
        emit OracleUpdated(value, d.aggregateTimestamp, d.relayTimestamp);
        return (value, d.aggregateTimestamp);
    }

    function _consumeNewestOverride() internal returns (uint256, uint256) {
        uint256 cutoff = block.timestamp - RELAY_CONSUMPTION_DELAY;
        for (uint256 i = overrideSubmissions.length; i > 0; i--) {
            OverrideSubmission memory s = overrideSubmissions[i - 1];
            if (s.timestamp <= cutoff) {
                if (s.timestamp > lastReturnedTimestamp) {
                    lastReturnedValue = s.value;
                    lastReturnedTimestamp = s.timestamp;
                    emit OracleUpdated(s.value, s.timestamp, s.timestamp);
                }
                return (lastReturnedValue, lastReturnedTimestamp);
            }
        }
        return (lastReturnedValue, lastReturnedTimestamp);
    }

    function _submitOverride(uint256 value) internal {
        overrideSubmissions.push(OverrideSubmission(value, block.timestamp));
        emit OverrideSubmitted(value, block.timestamp, msg.sender);
    }

    function _withinThreshold(uint256 value) internal view returns (bool) {
        if (
            priceChangeThresholdBps == 0 ||
            lastReturnedTimestamp == 0 ||
            lastReturnedValue == 0
        ) return true;
        uint256 diff = value > lastReturnedValue
            ? value - lastReturnedValue
            : lastReturnedValue - value;
        return
            diff <=
            (lastReturnedValue * priceChangeThresholdBps) / BPS_DENOMINATOR;
    }

    function _proposeRole(
        address a,
        mapping(address => uint256) storage proposal,
        mapping(address => bool) storage role,
        string memory exists
    ) internal {
        require(
            a != address(0) && proposal[a] == 0,
            "Shepherd: invalid role proposal"
        );
        require(!role[a], exists);
        proposal[a] = block.timestamp;
    }

    function _executeRole(
        address a,
        mapping(address => uint256) storage proposal,
        mapping(address => bool) storage role
    ) internal {
        require(
            proposal[a] != 0 &&
                block.timestamp >= proposal[a] + ROLE_CHANGE_DELAY,
            "Shepherd: role delay"
        );
        role[a] = true;
        delete proposal[a];
    }

    function _onlyRetriever() internal view {
        require(
            permissionlessRetrieval || retrievalCallers[msg.sender],
            "Shepherd: not retriever"
        );
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Shepherd: not admin");
        _;
    }
}
