# Tellor Data Bridge

## Overview

The Tellor Data Bridge enables secure relay of oracle data from Tellor Layer to EVM-compatible chains. The bridge operates using validator attestations to prove data existence and authenticity.

### How It Works

The bridge contract is initialized with an initial validator set (addresses and powers). When reports are aggregated on the Tellor chain, validators collectively sign this data. These signatures serve as cryptographic proofs that can be verified on-chain to confirm a report's validity.

To optimize gas costs, validator set updates occur only when the validator set changes by a significant threshold (typically 5% or more). When such changes occur, validators attest to the new validator set, and these signatures are relayed to update the bridge contract.

### Key Features

- **Validator-based Security**: Relies on at least 2/3 of validator voting power for attestations
- **Guardian Safety Mechanism**: Includes a guardian role that can reset stale validator sets
- **Gas Optimization**: Validator updates only occur on significant changes
- **Comprehensive Data Proofs**: Includes multiple timestamps and power metrics for full verification 

## Validator Set Management

### Data Structures

The bridge contract tracks the Tellor validator set using these key components:

```solidity
struct Validator {
    address addr;    // validator address
    uint256 power;   // validator voting power
}
```

**Core Variables:**
- `validatorSet` - Array of all validator addresses and their powers
- `validatorSetHash` - `keccak256(abi.encode(validatorSet))`
- `lastValidatorSetCheckpoint` - Domain-separated hash containing:
  - Validator set hash
  - Validator timestamp (when set was last updated)
  - Power threshold (2/3 of total power for efficient on-chain verification)

### Domain Separation

The contract uses `VALIDATOR_SET_HASH_DOMAIN_SEPARATOR` to prevent cross-network signature reuse:
- **Tellor Mainnet**: `0x636865636b706f696e7400000000000000000000000000000000000000000000` (bytes32 encoding of "checkpoint")
- **Other Networks**: `keccak256(abi.encode("checkpoint", tellorChainId))`

### Validator Set Updates

Normal validator set updates occur through the `updateValidatorSet` function:

```solidity
function updateValidatorSet(
    bytes32 _newValidatorSetHash,
    uint64 _newPowerThreshold,
    uint256 _newValidatorTimestamp,
    Validator[] calldata _currentValidatorSet,
    Signature[] calldata _sigs
) external;
```

### Staleness Protection

A validator set becomes **stale** if the unbonding period has elapsed since the last update. When this occurs, the guardian can reset the validator set using `guardianResetValidatorSet`, providing a crucial safety mechanism for validator set recovery.

## Report Attestations

### Attestation Data Structure

Each report attestation contains comprehensive verification data:

```solidity
struct OracleAttestationData {
    bytes32 queryId;              // unique identifier for the data request
    ReportData report;            // the actual report data
    uint256 attestationTimestamp; // when validators signed the attestation
}

struct ReportData {
    bytes value;                    // the actual data value being reported
    uint256 timestamp;              // when the report was aggregated
    uint256 aggregatePower;         // total reporter power for this report
    uint256 previousTimestamp;      // timestamp of the previous report
    uint256 nextTimestamp;          // timestamp of the next report
    uint256 lastConsensusTimestamp; // timestamp of latest consensus report for this queryId
}
```

### Domain Separation for Attestations

Report attestations use `NEW_REPORT_ATTESTATION_DOMAIN_SEPARATOR` (bytes32 encoding of "tellorCurrentAttestation") to prevent signature reuse. The attestation includes the validator checkpoint to ensure the correct validator set is being used in the bridge contract.

### Data Verification

The contract provides a `verifyOracleData` function for external verification of oracle attestations without executing state changes. This enables off-chain verification and integration with other systems.

## Contract Architecture

### Guardian Role
The bridge contract includes a guardian role that can reset the validator set if it becomes stale. A validator set is considered stale if the unbonding period has elapsed since the last update. This provides a safety mechanism in case the normal validator set update process fails.

### Unbonding Period
The unbonding period is a configurable time period after which a validator set is considered stale and can be reset by the guardian. This prevents indefinite reliance on outdated validator sets while providing sufficient time for normal update processes to complete.

### Signature Verification Process
The contract uses SHA256 hashing combined with ECDSA signature verification. Tellor validators sign the SHA256 hash of domain-separated bridge data, so verifying any bridge data signatures requires hashing the data with SHA256 before signature verification.

### Time Handling
The Tellor chain represents time in milliseconds, while EVM chains use seconds. The bridge contract handles conversions using the `MS_PER_SECOND` constant (1000). This is important when working with timestamps relayed from Tellor chain.

## Tellor Chain Integration

### Validator Set Concepts
On the Tellor chain side, there are two distinct validator sets:
- **Actual Validator Set**: The current active validators on Tellor Layer
- **Bridge Validator Set**: The validator set recognized by the bridge contract

The bridge validator set is updated only when the actual validator set changes by 5% or more. When such changes occur, validators collectively endorse the new set with signatures.

### Oracle Data Attestations
Validators provide attestations for oracle reports in two scenarios:
1. **New Reports**: Automatically attested when aggregated on Tellor Layer  
2. **Historical Reports**: Attested on-demand when requested (beneficial for optimistic oracle applications)

**Important**: Once a value is contested on Tellor Layer, validators cease attestations for that value. Post-dispute, users cannot request or execute new attestation proofs for contested values.

### Gas Optimization Strategy
The official bridge validator set is sorted by validator power in descending order. This minimizes gas costs for attestation verification, as signature checking can stop once 2/3 of total validator power is reached. This sorting is enforced by the Tellor chain.
