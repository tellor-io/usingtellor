// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.19;

import { ECDSA } from "./ECDSA.sol";

struct OracleAttestationData {
    bytes32 queryId;
    ReportData report;
    uint256 attestationTimestamp; // Validator attestation time in Unix milliseconds.
}

struct ReportData {
    bytes value;
    uint256 timestamp; // Report aggregate time in Unix milliseconds.
    uint256 aggregatePower;
    uint256 previousTimestamp;
    uint256 nextTimestamp;
    uint256 lastConsensusTimestamp;
}

struct Signature {
    uint8 v;
    bytes32 r;
    bytes32 s;
}

struct Validator {
    address addr;
    uint256 power;
}

/**
 * @author Tellor Inc.
 * @title TellorDataBridge
 * @notice Verifies Tellor Layer attestations and validator-set updates on the EVM.
 * @dev Signatures must meet the configured voting-power threshold for the current validator set.
 * This contract does not independently calculate or enforce a two-thirds ratio of total power.
 */
contract TellorDataBridge is ECDSA {
    // Storage
    address public guardian; // Able to reset the validator set only if the validator set becomes stale.
    bytes32 public lastValidatorSetCheckpoint; // Domain-separated commitment to the latest validator set.
    uint256 public powerThreshold; // Voting power required to submit a new update.
    uint256 public unbondingPeriod; // Unbonding duration in EVM seconds.
    uint256 public validatorTimestamp; // Validator-set timestamp in Unix milliseconds.
    address public deployer; // Address that deployed the contract.
    bool public initialized; // True if the contract is initialized.
    uint256 public constant MS_PER_SECOND = 1000; // factor to convert milliseconds to seconds
    // "tellorCurrentAttestation"
    bytes32 public constant NEW_REPORT_ATTESTATION_DOMAIN_SEPARATOR =
        0x74656c6c6f7243757272656e744174746573746174696f6e0000000000000000;
    // For tellor mainnet, this is "0x636865636b706f696e7400000000000000000000000000000000000000000000".
    // Otherwise, we take the tellor chain id as a string, and the validator set domain separator is
    // keccak256(abi.encode("checkpoint", TELLOR_CHAIN_ID)). This differentiates between different networks.
    bytes32 public immutable VALIDATOR_SET_HASH_DOMAIN_SEPARATOR;

    // Events
    event GuardianResetValidatorSet(
        uint256 _powerThreshold,
        uint256 _validatorTimestamp,
        bytes32 _validatorSetCheckpoint
    );
    event ValidatorSetUpdated(uint256 _powerThreshold, uint256 _validatorTimestamp, bytes32 _validatorSetHash);

    // Errors
    error AlreadyInitialized();
    error InsufficientVotingPower();
    error InvalidGuardian();
    error InvalidPowerThreshold();
    error InvalidSignature();
    error InvalidUnbondingPeriod();
    error MalformedCurrentValidatorSet();
    error NotDeployer();
    error NotGuardian();
    error StaleValidatorSet();
    error SuppliedValidatorSetInvalid();
    error ValidatorSetNotStale();
    error ValidatorTimestampInFuture();
    error ValidatorTimestampMustIncrease();

    // Constructor

    /**
     * @notice Binds the guardian and validator-set domain separator; initialization is separate.
     * @param _guardian Nonzero guardian authorized to reset a stale validator set.
     * @param _validatorSetHashDomainSeparator Domain separator included in every validator-set checkpoint.
     */
    constructor(address _guardian, bytes32 _validatorSetHashDomainSeparator) {
        if (_guardian == address(0)) {
            revert InvalidGuardian();
        }
        guardian = _guardian;
        deployer = msg.sender;
        VALIDATOR_SET_HASH_DOMAIN_SEPARATOR = _validatorSetHashDomainSeparator;
    }

    /**
     * @notice Initializes the bridge once; callable only by the deployer.
     * @param _powerThreshold Positive initial voting power required to approve operations.
     * @param _validatorTimestamp Initial validator-set timestamp in Unix milliseconds, no later than the current block time.
     * @param _unbondingPeriod Positive validator-set staleness period in EVM seconds.
     * @param _validatorSetCheckpoint Initial domain-separated commitment to the validator set, threshold and timestamp.
     */
    function init(
        uint256 _powerThreshold,
        uint256 _validatorTimestamp,
        uint256 _unbondingPeriod,
        bytes32 _validatorSetCheckpoint
    ) external {
        if (msg.sender != deployer) {
            revert NotDeployer();
        }
        if (initialized) {
            revert AlreadyInitialized();
        }
        if (_powerThreshold == 0) {
            revert InvalidPowerThreshold();
        }
        if (_validatorTimestamp > block.timestamp * MS_PER_SECOND) {
            revert ValidatorTimestampInFuture();
        }
        if (_unbondingPeriod == 0) {
            revert InvalidUnbondingPeriod();
        }
        initialized = true;
        powerThreshold = _powerThreshold;
        validatorTimestamp = _validatorTimestamp;
        unbondingPeriod = _unbondingPeriod;
        lastValidatorSetCheckpoint = _validatorSetCheckpoint;
    }

    // State-changing functions

    /**
     * @notice Resets a stale validator set; callable only by the guardian.
     * @dev Reset is permitted when elapsed whole seconds reach the unbonding period.
     * @param _powerThreshold Positive replacement voting-power threshold.
     * @param _validatorTimestamp Replacement timestamp in Unix milliseconds, strictly newer than the current one and not in the future.
     * @param _validatorSetCheckpoint Replacement domain-separated commitment to the validator set, threshold and timestamp.
     */
    function guardianResetValidatorSet(
        uint256 _powerThreshold,
        uint256 _validatorTimestamp,
        bytes32 _validatorSetCheckpoint
    ) external {
        if (msg.sender != guardian) {
            revert NotGuardian();
        }
        if (block.timestamp - (validatorTimestamp / MS_PER_SECOND) < unbondingPeriod) {
            revert ValidatorSetNotStale();
        }
        if (_validatorTimestamp <= validatorTimestamp) {
            revert ValidatorTimestampMustIncrease();
        }
        if (_validatorTimestamp > block.timestamp * MS_PER_SECOND) {
            revert ValidatorTimestampInFuture();
        }
        if (_powerThreshold == 0) {
            revert InvalidPowerThreshold();
        }
        powerThreshold = _powerThreshold;
        validatorTimestamp = _validatorTimestamp;
        lastValidatorSetCheckpoint = _validatorSetCheckpoint;
        emit GuardianResetValidatorSet(_powerThreshold, _validatorTimestamp, _validatorSetCheckpoint);
    }

    /**
     * @notice Installs a new validator checkpoint authorized by the current validator set.
     * @dev Signatures must meet the current powerThreshold; the proposed threshold applies after the update.
     * @param _newValidatorSetHash Hash of the proposed validator set.
     * @param _newPowerThreshold Positive voting-power threshold to install for subsequent operations.
     * @param _newValidatorTimestamp Proposed timestamp in Unix milliseconds; equality with the current timestamp is allowed, but future times are rejected.
     * @param _currentValidatorSet Current validators matching the stored checkpoint, ordered to match the signatures.
     * @param _sigs Signatures over the proposed checkpoint, aligned with _currentValidatorSet.
     */
    function updateValidatorSet(
        bytes32 _newValidatorSetHash,
        uint64 _newPowerThreshold,
        uint256 _newValidatorTimestamp,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) external {
        if (_currentValidatorSet.length != _sigs.length) {
            revert MalformedCurrentValidatorSet();
        }
        if (_newValidatorTimestamp < validatorTimestamp) {
            revert ValidatorTimestampMustIncrease();
        }
        if (_newValidatorTimestamp > block.timestamp * MS_PER_SECOND) {
            revert ValidatorTimestampInFuture();
        }
        if (_newPowerThreshold == 0) {
            revert InvalidPowerThreshold();
        }
        // Check that the supplied current validator set matches the saved checkpoint.
        bytes32 _currentValidatorSetHash = keccak256(abi.encode(_currentValidatorSet));
        if (
            _domainSeparateValidatorSetHash(powerThreshold, validatorTimestamp, _currentValidatorSetHash) !=
            lastValidatorSetCheckpoint
        ) {
            revert SuppliedValidatorSetInvalid();
        }

        bytes32 _newCheckpoint = _domainSeparateValidatorSetHash(
            _newPowerThreshold,
            _newValidatorTimestamp,
            _newValidatorSetHash
        );
        _checkValidatorSignatures(_currentValidatorSet, _sigs, _newCheckpoint, powerThreshold);
        lastValidatorSetCheckpoint = _newCheckpoint;
        powerThreshold = _newPowerThreshold;
        validatorTimestamp = _newValidatorTimestamp;
        emit ValidatorSetUpdated(_newPowerThreshold, _newValidatorTimestamp, _newValidatorSetHash);
    }

    // Getter functions

    /**
     * @notice Verifies an oracle attestation against the current validator checkpoint and voting-power threshold.
     * @dev Reverts on invalid verification; successful calls return no value and do not store the report.
     * @param _attestData Oracle report and attestation fields included in the signed digest.
     * @param _currentValidatorSet Current validators matching the stored checkpoint, ordered to match the signatures.
     * @param _sigs Attestation signatures aligned with _currentValidatorSet.
     */
    function verifyOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata _currentValidatorSet,
        Signature[] calldata _sigs
    ) external view {
        if (_currentValidatorSet.length != _sigs.length) {
            revert MalformedCurrentValidatorSet();
        }
        // Check that the supplied current validator set matches the saved checkpoint.
        if (
            _domainSeparateValidatorSetHash(
                powerThreshold,
                validatorTimestamp,
                keccak256(abi.encode(_currentValidatorSet))
            ) != lastValidatorSetCheckpoint
        ) {
            revert SuppliedValidatorSetInvalid();
        }
        bytes32 _dataDigest = keccak256(
            abi.encode(
                NEW_REPORT_ATTESTATION_DOMAIN_SEPARATOR,
                _attestData.queryId,
                _attestData.report.value,
                _attestData.report.timestamp,
                _attestData.report.aggregatePower,
                _attestData.report.previousTimestamp,
                _attestData.report.nextTimestamp,
                lastValidatorSetCheckpoint,
                _attestData.attestationTimestamp,
                _attestData.report.lastConsensusTimestamp
            )
        );
        _checkValidatorSignatures(_currentValidatorSet, _sigs, _dataDigest, powerThreshold);
    }

    // Internal functions

    /**
     * @dev Requires a nonstale validator set and enough signed voting power for the supplied digest.
     * Signatures must align with validators. Empty signatures are skipped; verification stops once the threshold is met.
     * Staleness uses whole seconds and accepts equality with the unbonding period.
     * @param _currentValidators Current validators and their voting powers.
     * @param _sigs Signatures aligned with _currentValidators.
     * @param _digest Digest whose signatures are checked.
     * @param _powerThreshold Minimum cumulative signed voting power required.
     */
    function _checkValidatorSignatures(
        // The current validator set and their powers
        Validator[] calldata _currentValidators,
        Signature[] calldata _sigs,
        bytes32 _digest,
        uint256 _powerThreshold
    ) internal view {
        if (block.timestamp - (validatorTimestamp / MS_PER_SECOND) > unbondingPeriod) {
            revert StaleValidatorSet();
        }
        uint256 _cumulativePower = 0;
        for (uint256 _i = 0; _i < _currentValidators.length; _i++) {
            // If the signature is nil, then it's not present so continue.
            if (_sigs[_i].r == 0 && _sigs[_i].s == 0 && _sigs[_i].v == 0) {
                continue;
            }
            // Check that the current validator has signed off on the hash.
            if (!_verifySig(_currentValidators[_i].addr, _digest, _sigs[_i])) {
                revert InvalidSignature();
            }
            _cumulativePower += _currentValidators[_i].power;
            // Break early to avoid wasting gas.
            if (_cumulativePower >= _powerThreshold) {
                break;
            }
        }
        if (_cumulativePower < _powerThreshold) {
            revert InsufficientVotingPower();
        }
    }

    /**
     * @dev Commits to the domain separator, voting-power threshold, timestamp and validator-set hash.
     * @param _powerThreshold Voting-power threshold included in the checkpoint.
     * @param _validatorTimestamp Validator-set timestamp in Unix milliseconds.
     * @param _validatorSetHash Hash of the validator set.
     * @return Domain-separated validator checkpoint.
     */
    function _domainSeparateValidatorSetHash(
        uint256 _powerThreshold,
        uint256 _validatorTimestamp,
        bytes32 _validatorSetHash
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(VALIDATOR_SET_HASH_DOMAIN_SEPARATOR, _powerThreshold, _validatorTimestamp, _validatorSetHash)
            );
    }

    /**
     * @dev Applies SHA-256 to the supplied digest, then recovers and compares the signer.
     * Recovery errors revert with InvalidSignature; a different recovered signer returns false.
     * @param _signer Expected signer address.
     * @param _digest Digest to hash with SHA-256 before signature recovery.
     * @param _sig Signature to verify.
     * @return True if recovery succeeds and matches _signer.
     */
    function _verifySig(address _signer, bytes32 _digest, Signature calldata _sig) internal pure returns (bool) {
        _digest = sha256(abi.encodePacked(_digest));
        (address _recovered, RecoverError _error, ) = tryRecover(_digest, _sig.v, _sig.r, _sig.s);
        if (_error != RecoverError.NoError) {
            revert InvalidSignature();
        }
        return _signer == _recovered;
    }
}
