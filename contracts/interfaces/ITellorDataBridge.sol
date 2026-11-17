// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

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
 * @title ITellorDataBridge
 * @notice Read and attestation-verification interface for TellorDataBridge.
 */
interface ITellorDataBridge {
    // Getter functions

    /**
     * @notice Returns the guardian authorized to reset a stale validator set.
     * @return Guardian address.
     */
    function guardian() external view returns (address);

    /**
     * @notice Returns the configured voting power required to approve operations.
     * @return Current voting-power threshold; this getter does not establish a ratio of total power.
     */
    function powerThreshold() external view returns (uint256);

    /**
     * @notice Returns the validator-set staleness period.
     * @return Staleness period in EVM seconds.
     */
    function unbondingPeriod() external view returns (uint256);

    /**
     * @notice Returns the timestamp committed by the current validator checkpoint.
     * @return Validator-set timestamp in Unix milliseconds.
     */
    function validatorTimestamp() external view returns (uint256);

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
    ) external view;
}
