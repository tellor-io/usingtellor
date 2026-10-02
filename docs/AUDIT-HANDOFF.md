# Shepherd audit handoff

## Scope

Paths are relative to the named repository. Include imported interfaces and libraries in review.

| Repository | Contracts |
|---|---|
| `usingtellor` | `contracts/databank/{TellorShepherd,TellorShepherdFactory,TellorDataBank}.sol`; `contracts/examples/StreamBackupOracle.sol`; `contracts/interfaces/*.sol` |
| `usingtellor` — primary attestation dependency | `contracts/bridge/{TellorDataBridge,ECDSA}.sol` |
| `morpho-tellor-adapter` | `src/{MorphoTellorOracle,TellorOracleFactory}.sol`; `src/interfaces/*.sol`; `src/libraries/FullMath.sol` and its accompanying license |
| `euler-tellor-adapter` | `src/TellorOracle.sol`; `src/interfaces/ITellorShepherd.sol`; imported code from `lib/euler-price-oracle` and its dependencies |

Euler scope is a single feed with direct/inverse quotes and equal bid/ask. Integration tests exercise the oracle contracts, not complete Morpho market or Euler vault transactions. Test doubles and harnesses are supporting evidence, not deployable scope.

## Build and test

Requires Node.js/npm and Foundry (`forge`). Keep the three repositories as siblings, or set `MORPHO_ADAPTER_ROOT` and `EULER_ADAPTER_ROOT` to their checkout paths.

- Shepherd: Solidity 0.8.19, optimizer disabled, no via-IR (`hardhat.config.js`).
- Morpho: Solidity 0.8.20, optimizer enabled with 200 runs, via-IR enabled.
- Euler: Solidity 0.8.20, optimizer enabled with 200 runs, no via-IR.

Use the adaptor repositories' `foundry.toml` files and the npm lockfile. In a fresh Euler checkout, initialize dependencies with `git submodule update --init --recursive`.

From `usingtellor`:

```sh
npm ci
npx --no-install hardhat test
npm run test:morpho
npm run test:euler
```

The integration commands build each adaptor before loading its bytecode. Run `forge test` from each adaptor repository for its native tests.

Local validation: 226 Hardhat tests, 31 Morpho integration tests, and 17 Euler integration tests pass. Native `forge test` runs crash in the installed nightly Foundry build. Morpho reports a `forge-std` revision mismatch; Euler has dependency files present but its submodule is uninitialized, and automatic registration fails under the local sandbox. Fresh-checkout reproduction remains unverified.

## Invariants and trust assumptions

- Shepherd selects or refuses source data; its roles cannot supply a numeric price override. Primary reads select the newest relay strictly older than the relay-delay cutoff. Both paths preserve the source's millisecond timestamp.
- Pause blocks both read paths. Source switches preserve pause. Only admin can unpause, after the minimum duration and with neither source replacement pending.
- Deviation and missing TWAP coverage do not halt ordinary primary reads. Challenge request/execution require deviation; execution also requires the delay. Recovery requires backup permission at request and delayed execution. Neither flow proves continuous conditions between calls.
- Source replacement is admin-only, delayed, and executed while paused. Successful replacement clears pending challenge/recovery timers. Backup construction checks code only; migration additionally requires a decodable `getCurrentValue(queryId)` response at proposal and execution, without validating price, timestamp, or recovery permission.
- TWAP weights stored relays, not complete Layer history. Relayer omission and long gaps can bias it. A compromised Layer supermajority can corrupt both primary values and their reference; timely monitoring and pause remain essential.
- `StreamBackupOracle` trusts authorized streamers to author prices and its admin to appoint them, dispute reports, and permit recovery. Timestamps record submission, not underlying observation freshness. Recovery permission persists through primary migration. Reads inspect at most 32 mature reports after the maturity lookup and may refuse despite older usable data.
- Adaptors enforce freshness, timestamp validity, scaling, and (for Morpho) cross-feed skew. They cannot detect a backup lying about observation freshness. Both sources must share price meaning and decimals.
- Shepherd's admin can replace either source after notice; there is no pauser veto. Factory registration proves deployment provenance, not safe settings, source trust, or the nominated admin's consent.

