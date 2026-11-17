# Shepherd guide

Shepherd has two source slots, `primarySource` and `backupSource`, and one selected mode. Each source implements `getCurrentValue()` and `decimals()`. Shepherd selects or refuses source data; it does not rescale prices or supply an administrator-written price.

## Configure an instance

The direct constructor takes:

```text
(description, decimals, primarySource, backupSource, admin,
 minPauseDuration, configChangeDelay, challengeThresholdBps,
 [challengeDelaySeconds, recoveryDelaySeconds], maxDataAge, isPausable)
```

The factory's `Configuration` uses the same names, with separate `challengeDelaySeconds` and `recoveryDelaySeconds` fields. See the [deployment example](../README.md#deployment-composition-illustrative-not-production-calibration).

| Setting | Meaning and constraint |
| --- | --- |
| `description` | Display label set at deployment; may be empty. It does not verify asset identity. |
| `decimals` | Fixed raw-price precision, 0–77. Both sources must report the same precision. |
| Source addresses | Must contain code and expose matching decimals. Available prices are not required at deployment or replacement. |
| `admin` | Nonzero address controlling administrative operations. |
| `minPauseDuration` | Mutable seconds, including zero. |
| `configChangeDelay` | Positive fixed notice in seconds for source, admin, pause-duration, and threshold updates. |
| `challengeThresholdBps` | Mutable deviation threshold, 1–9999 basis points. |
| Challenge/recovery delays | Independent positive fixed waits in seconds. They are not checked against reader timing. |
| `maxDataAge` | Fixed seconds, from 1 through `floor(type(uint256).max / 1000)`. Exposed as `MAX_DATA_AGE()`. |
| `isPausable` | Fixed flag enabling explicit pausing. It cannot be changed later. |

Deployers and admins must establish that both sources represent the intended quote units per whole base unit. Query IDs may differ or be absent. Matching precision, labels, or factory membership does not prove compatible assets, price truth, or independence.

## Consumer reads

`getCurrentValue()` returns the raw unsigned price and original Unix timestamp in **milliseconds**. It reads only the selected source. Pause, a caught source failure, zero price, zero/future timestamp, or excessive age prevents a successful read. Age exactly equal to `MAX_DATA_AGE` is accepted; one millisecond beyond it is rejected. No read automatically switches sources or renews a timestamp.

`latestRoundData()` uses the same read checks, then returns a signed price and `updatedAt = timestampMs / 1000`. Prices above `int256.max` revert with `SignedPriceOverflow` on this surface; native unsigned reads still support them. `roundId`, `startedAt`, and `answeredInRound` are zero sentinels. There is no historical `getRoundData()` support.

`validateSource(address)` checks an arbitrary candidate's code, precision, and current native-read usability. Anyone can call it, even while paused. It returns the original unsigned price and millisecond timestamp without selecting or registering the candidate. It does not enforce the signed-price bound or prove future availability or price truth.

Malformed successful ABI responses can revert outside the read's catch clause. See [known limitations](AUDIT-HANDOFF.md#known-limitations).

## Challenge and recovery

All request, execute, and cancel functions are permissionless and work while paused. Challenge moves PRIMARY to BACKUP; recovery moves BACKUP to PRIMARY.

| Direction | Required at request and execution |
| --- | --- |
| Challenge | Backup usable, and primary unusable or prices deviating. |
| Recovery | Primary usable, and backup unusable or prices agreeing. |

When both sources are usable, deviation means `abs(backup - primary) * 10000 > primary * challengeThresholdBps`, implemented with overflow-safe arithmetic. Exact threshold equality counts as agreement. If either source is unusable, the eligibility rules above apply without comparing prices.

Execution requires the full direction-specific delay; equality passes. These are checks at request and execution, not proof that the condition held continuously. A change in the reason for eligibility does not restart the timer. A request cannot overwrite an existing request; cancel and request again to start a fresh wait. Cancellation requires that direction's eligibility to be false.

Both sources unusable prevents either switch and permits cancellation. Switching preserves pause state and its clock. Pending transitions do not stop otherwise valid consumer reads.

## Pause and unpause

With `isPausable = true`, the admin and registered pausers may pause immediately. Only the current admin may unpause. The admin manages pausers through `addPauser` and `removePauser`; being admin does not create a permanent pauser membership.

Unpause requires:

```text
unpause(expectedMode, expectedPrimary, expectedBackup)
```

Read and review the selected mode and both source addresses at a common block, then include those values in the signed transaction. Mode `0` is PRIMARY; `1` is BACKUP. If selection differs at execution, the transaction reverts with `UnexpectedState`. Fetching fresh getters and echoing them inside the execution batch defeats this review guard.

The instance must be paused, have no pending source replacement, and have waited at least the current `minPauseDuration`. Unpause does not check price availability. The selection guard does not bind prices, other proposals, transition timers, or intervening changes that restore the same selection; review those separately. Later permissionless transitions remain possible.

With `isPausable = false`, even an authorized pause call fails. Pauser membership and pause-duration settings remain manageable but have no operational effect. Source replacement executes while live. Non-pausable does not guarantee available prices.

## Delayed administration

Only the **current admin** may propose, cancel, or execute these operations. All use `CONFIG_CHANGE_DELAY`, with independent proposal clocks and execution allowed at exact delay equality. Pending proposals cannot be overwritten; cancel and repropose to restart notice. No-op proposals are rejected.

| Change | Methods | Effect on execution |
| --- | --- | --- |
| Sources | `proposeSourcesChange`, `cancelSourcesChange`, `executeSourcesChange` | Atomically replace the pair; preserve mode and pause; clear transition requests/timers. |
| Admin | `proposeAdminChange`, `cancelAdminChange`, `executeAdminChange` | Transfer authority; preserve other proposals, selection, and clocks. The outgoing admin executes; the recipient does not accept. |
| Pause duration | `proposeMinPauseDurationChange`, `cancelMinPauseDurationChange`, `executeMinPauseDurationChange` | Apply the new duration immediately, including to an ongoing pause, without resetting `pausedAt`. |
| Threshold | `proposeChallengeThresholdChange`, `cancelChallengeThresholdChange`, `executeChallengeThresholdChange` | Apply the new threshold and clear transition requests/timers, even if current prices still qualify. |

Source replacement requires pause only on pausable instances. It rechecks code and precision at proposal and execution; one source may remain unchanged. Neither cancellation nor execution needs the old sources to work. Failed execution preserves the old pair and proposal. Replacement never renews observations or changes fixed delays, precision, description, or maximum age.

Pause duration accepts any uint256, including zero. Decreasing it may allow immediate unpause; increasing it may extend an active pause. Execution never unpauses automatically. `minPauseDurationChangePending` distinguishes a pending zero from no proposal. Threshold uses `pendingChallengeThresholdBps == 0` for no proposal because zero is invalid policy.

Pending admin, duration, and threshold changes do not block unpause; pending source changes do. Proposals survive admin transfer with their original clocks. Explicit pauser memberships survive too. Any nonzero new admin is permitted, including an address that cannot act; selecting such an address can permanently disable administration.

## Tellor readers and DataBank

`TellorSpotSource` and `TellorTwapSource` bind a bank, query ID, precision, and relay-read delay. The TWAP also fixes its window in milliseconds. Spot permits zero delay; TWAP requires positive delay and window.

Both select relays strictly before `block.timestamp - RELAY_READ_DELAY`. Even a zero-delay spot read excludes the current timestamp's relays. No eligible report means no data. Successful reads retain original aggregate timestamps.

TWAP holds each stored price until the next aggregate timestamp and averages over the actual interval, at least the requested window. The endpoint price has zero weight. Sparse relays, long-held prices, and intervals longer than the window are accepted; a fresh endpoint does not prove fresh contributors or complete sampling.

DataBank construction is `(dataBridge, optimisticDelay, maxAttestationAge, maxDataAge)`, all positive immutable seconds. These are separate from Shepherd's settings. DataBank age limits are exclusive and use whole seconds; optimistic maturity accepts equality. Shepherd independently checks full milliseconds. Deployers must choose dispute-safe admission timing and ensure sources can mature before Shepherd refuses them as stale.

`StreamBackupOracle` is a standalone trusted-streamer example, not a Shepherd dependency or recovery authority. Its admin can appoint streamers, including itself; their price truth is trusted. Submission timestamps do not establish underlying observation freshness.

## Consumer integration

Shepherd provides a Chainlink-compatible latest-read subset, not the full historical interface. Consumers impose their own precision and arithmetic limits beyond Shepherd's 0–77 decimal range.

For the pinned stock Morpho V2 consumer, use distinct collateral/USD and loan/USD Shepherds with the same quote unit. This example assumes 18 collateral token decimals and 6 loan token decimals:

```js
// Inside an async deployment function; these are ethers contract factories/instances.
const morphoOracle = await MorphoChainlinkOracleV2.deploy(
  ethers.ZeroAddress, 1, collateralShepherd.target, ethers.ZeroAddress, 18,
  ethers.ZeroAddress, 1, loanShepherd.target, ethers.ZeroAddress, 6
);
const eulerOracle = await ChainlinkOracle.deploy(baseAsset, quoteAsset, shepherd.target, 3600);
```

Morpho V2 composes the raw feeds into a smallest-token-unit ratio scaled by 1e36. It does not check timestamps, query IDs, round IDs, or cross-feed skew; each Shepherd supplies its own freshness refusal. Individually fresh but differently timed observations may be combined.

The pinned Euler consumer uses one base/quote feed, supports direct/inverse quotes, and adds its own `maxStaleness` of 60 seconds through 72 hours. A stricter limit can refuse a Shepherd-accepted report. With equal integer-second limits, flooring the timestamp creates no boundary disagreement: `1000*t - m <= 1000*L` is equivalent to `t - floor(m/1000) <= L` after validating that `m` is not in the future.

The custom sibling adapters differ from these stock consumers. Both require trusted-factory membership. Custom Morpho additionally rejects identical collateral/loan Shepherd addresses and enforces a positive cross-feed skew limit. Different addresses do not prove independent data. Use each adapter repository's constructor and scaling rules; the stock examples above are not custom-adapter constructors.
