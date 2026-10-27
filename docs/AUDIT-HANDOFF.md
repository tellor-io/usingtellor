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

Local validation after removing the minimum pause duration: 270 Hardhat tests, 31 custom Morpho integration tests, 17 Euler integration tests, and 6 direct Morpho V2 integration tests pass. The direct V2 suite builds unmodified `morpho-blue-oracles` at `9d2a0b66589d0669c52e47310af8eb804facf97e` with its submodules and Solidity 0.8.21. Run `MORPHO_CHAINLINK_ROOT=/path/to/morpho-blue-oracles npm run test:morpho-chainlink` separately. Native `forge test --offline` now passes 27 Morpho tests and 26 Euler tests, including fuzz coverage and the Euler deployment-script test. The custom Morpho adaptor reports a `forge-std` revision mismatch; Euler has dependency files present but its submodule is uninitialized, and automatic registration fails under the local sandbox. Fresh-checkout reproduction of those adaptors remains unverified.

## Invariants and trust assumptions

- Shepherd selects or refuses source data; its roles cannot supply a numeric price override. Primary reads select the newest relay strictly older than the relay-delay cutoff. Both sources preserve their millisecond timestamps through `getCurrentValue()` and share its zero/future/maximum-age checks. Exact age equality is accepted, with no rounding before validation.
- Pause blocks both read paths. Source switches preserve pause. Only admin can unpause, immediately and with neither source replacement pending. `pausedAt` records the current pause for monitoring; it imposes no waiting period.
- Deviation and missing TWAP coverage do not halt ordinary primary reads. Challenge request requires deviation and saves the reference and challenged aggregate timestamp. Resolution selects backup only on a newer report inside that frozen band during the permitted window; expiry clears the request without source calls. Recovery requires backup permission at request and delayed execution. Neither flow proves continuous conditions between calls.
- Source replacement is admin-only, delayed, and executed while paused. Successful replacement clears pending challenge/recovery timers. Backup construction checks code only; migration additionally requires a decodable `getCurrentValue(queryId)` response at proposal and execution, without validating price, timestamp, or recovery permission.
- TWAP weights stored relays, not complete Layer history. Relayer omission and long gaps can bias it. A compromised Layer supermajority can corrupt both primary values and their reference; timely monitoring and pause remain essential.
- `StreamBackupOracle` trusts authorized streamers to author prices and its admin to appoint them, dispute reports, and permit recovery. Timestamps record submission, not underlying observation freshness. Recovery permission persists through primary migration. Reads inspect at most 32 mature reports after the maturity lookup and may refuse despite older usable data.
- Shepherd enforces deployment-configured freshness for both consumer APIs; the custom adaptors delegate timestamp validity and age checks to Shepherd and perform scaling. They require this freshness-enforcing Shepherd version; their constructors, factory settings/events, and deployment scripts no longer accept an independent maximum age. The custom Morpho adaptor also checks cross-feed skew. Neither Shepherd nor adaptors detect a backup lying about observation freshness. Both sources must share price meaning and the configured immutable decimals.
- Shepherd's admin can replace either source after notice; there is no pauser veto. Factory registration proves deployment provenance, not safe settings, source trust, or the nominated admin's consent.

## Challenge resolution

`resolveChallenge()` replaces `executeChallenge()` and `cancelChallenge()`. The constructor requires
`ceil(TWAP_WINDOW_MS / 1000) <= CHALLENGE_DELAY_SECONDS < RELAY_READ_DELAY`.
Let `C` be the challenge request time, `D` the challenge delay, and `R` the relay read delay:

| Resolution time / evidence | Result |
|---|---|
| Before `C + D` | Revert, preserving the request. |
| From `C + D` through `C + R`, inclusive; newer aggregate inside the saved band | Clear all challenge state, select backup, emit `ChallengeExecuted`. Threshold equality is inside. |
| Same window; no newer aggregate, outside-band price, or invalid evidence | Revert, preserving the original timer and reference. |
| Strictly after `C + R` | Clear all challenge state, remain on primary, emit `ChallengeExpired`; do not call either source. |

The frozen reference prevents TWAP drift from being mistaken for a return to the original band.
An outside-band report leaves time for a later return, rather than cancelling at the earliest resolution time.
DataBank's strictly increasing aggregate timestamps identify newer reports; a new relay timestamp alone is insufficient.
Source migrations clear the saved evidence as well as the timer. Resolution and expiry preserve pause and its clock.

Expiry requires a transaction and is measured from the request, not the challenged report's relay time.
Preventing outlier consumption still requires a timely challenge, a relayed return, and resolution before that report matures.
Pause remains the main defense; sustained moves continue on primary. Backup readiness remains necessary for liveness,
and recovery permission must not allow the challenged outlier to be served on return to primary.
The resolver does not prove manipulation, continuous recovery, or independent price truth.

## Shared consumer read policy

Both external read methods call `_getCurrentValue()`. `latestRoundData()` then checks the positive `int256` range and floors source timestamps to seconds for `startedAt` and `updatedAt`. Round IDs are zero sentinels; historical Chainlink rounds are unsupported. This provides the two selectors used by Morpho V2 without an extra wrapper or duplicated read policy. Morpho V2 does not inspect timestamps or enforce cross-feed skew. Diagnostic and transition calls remain independent of consumer freshness, including unconditional challenge expiry.

`MAX_PRICE_AGE` is immutable, positive seconds, bounded so multiplication by 1000 cannot overflow. A short limit can prevent mature observations from ever being read; deployment configuration must account for all source and relay delays. No fallback is attempted on stale selected data. `StreamBackupOracle` timestamps still describe trusted-streamer submission, not verified market observation time.

The constructor now accepts the same named `TellorShepherd.Configuration` struct as the factory, including `maxPriceAge` and `decimals`. This avoids the Solidity 0.8.19 constructor stack limit without changing compiler settings. Deployment callers must update their arguments. Refresh packaged artifacts before release; they remain excluded from incremental rebuild changes.

## Rebuild checkpoint

The shared-read and adaptor cleanup are committed in the current workspace. The next AGENT-WRITES increment removes the minimum pause duration, its configuration field, and its errors. It retains `pausedAt` for monitoring, admin-only unpause, both pending-source guards, and delayed source execution while paused. Tests cover zero elapsed time, repeated pauses, authority, and migration/transition interactions. Implementation and validation are complete; human review, comprehension, and commit are pending. Changes are unstaged in `usingtellor` only.

Approved follow-ups, not yet implemented: admin-only threshold propose/cancel/execute with deployment-set `THRESHOLD_CHANGE_DELAY` and a per-challenge threshold snapshot; strict `RELAY_READ_DELAY - CHALLENGE_DELAY_SECONDS > 60 seconds`. Source migration remains solely the admin's decision, with no independent veto.
