# Tellor DataBridge

[TellorDataBridge.sol](TellorDataBridge.sol) verifies signed oracle attestations against a stored validator checkpoint. It proves that enough voting power from that checkpoint signed the supplied data. It does not prove the reported price is true or enforce Shepherd's freshness policy.

## Deploy and initialize

The constructor takes `(guardian, validatorSetHashDomainSeparator)`. The guardian must be nonzero. The deploying address then calls `init` once:

```text
init(powerThreshold, validatorTimestamp, unbondingPeriod, validatorSetCheckpoint)
```

The threshold and unbonding period must be positive. The validator timestamp uses Unix milliseconds and cannot be in the future; the unbonding period uses seconds. The deployer is responsible for a correct checkpoint and safe threshold.

The bridge stores `lastValidatorSetCheckpoint`, `powerThreshold`, `validatorTimestamp`, and `unbondingPeriod`. It does **not** store the validator array. Callers supply validators and aligned signatures; the bridge hashes the array and checks it against the stored checkpoint.

## Checkpoints and signatures

A checkpoint is the Keccak-256 hash of ABI-encoded domain separator, voting-power threshold, validator timestamp, and validator-set hash. The validator-set hash is `keccak256(abi.encode(validators))`, where each validator contains an address and uint256 power.

The constructor supplies the checkpoint domain separator; the contract does not derive it from the EVM chain ID. The repository's helper uses the bytes32 encoding of `"checkpoint"` for `tellor-1` and `keccak256(abi.encode("checkpoint", tellorChainId))` for other Layer chain IDs. Choose the separator to match the signing chain.

Signatures authenticate the **SHA-256 hash** of the relevant Keccak-256 digest. Verification skips empty signatures and stops once accumulated signed power reaches the configured threshold. Validator and signature order must match. The contract enforces that threshold; it does not independently calculate a two-thirds ratio or require a five-percent validator-set change.

## Update validators

Anyone may submit an update authorized by the current validator set:

```solidity
function updateValidatorSet(
    bytes32 _newValidatorSetHash,
    uint64 _newPowerThreshold,
    uint256 _newValidatorTimestamp,
    Validator[] calldata _currentValidatorSet,
    Signature[] calldata _sigs
) external;
```

The current threshold authorizes the proposed checkpoint; the new positive threshold applies after success. The timestamp may equal the current timestamp, but cannot go backward or exceed current block time in milliseconds.

## Verify reports

`verifyOracleData(attestData, currentValidatorSet, sigs)` is an external view call. It returns no value on success and reverts on failed verification. It does not store the report.

The signed digest includes the fixed `"tellorCurrentAttestation"` domain, query ID, raw value, report timestamp, aggregate power, previous/next timestamps, current validator checkpoint, attestation timestamp, and last consensus timestamp. See [ITellorDataBridge](../interfaces/ITellorDataBridge.sol) for the complete structs.

The bridge authenticates these fields; DataBank and consumers apply their own admission, timing, and price policies. This contract does not query Layer for a report's current dispute status or automatically revoke an already signed attestation.

## Staleness and guardian reset

Signature verification accepts elapsed whole seconds **up to and including** `unbondingPeriod`; greater age reverts. Elapsed time is `block.timestamp - validatorTimestamp / 1000`.

The guardian can call `guardianResetValidatorSet` once that elapsed time is **at least** the unbonding period. At exact equality, both signature verification and guardian reset are allowed. Reset requires a positive threshold and a strictly newer, nonfuture validator timestamp. It installs the supplied checkpoint without validator signatures, so the guardian is a trusted recovery authority.

For the surrounding reader and consumer policies, see the [Shepherd guide](../../docs/SHEPHERD.md) and [audit handoff](../../docs/AUDIT-HANDOFF.md).
