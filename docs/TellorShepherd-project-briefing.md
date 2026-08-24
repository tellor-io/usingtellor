# TellorShepherd: Project Briefing and Design Record

## Purpose and status

This is a self-contained handoff document for discussing and designing TellorShepherd. It records:

- the product’s purpose;
- where it sits in the Tellor oracle stack;
- the security and operational assumptions behind it;
- intended production usage;
- decisions made during the current design discussion;
- the behavior of the Solidity prototype currently in the repository;
- differences between that prototype and the intended design;
- and questions that remain open.

Last synthesized: July 23, 2026.

The intended audience currently includes protocol developers, protocol governance and risk teams, auditors, operators/custodians, and end users. More focused documentation can be derived for each audience later.

This document is not an audit, finalized specification, or claim that the intended design has been implemented. Sections labeled **current implementation** describe the inspected work-in-progress Solidity code. Sections labeled **intended design** or **open question** describe product decisions or proposals that may still require implementation, testing, and review.

When using this document as context for another discussion, treat the **Decided design points** section as the current product direction, the **Current TellorShepherd Solidity prototype** section as a description of inspected code rather than target behavior, and the **Open design and implementation questions** section as unresolved.

## Executive summary

TellorShepherd is a standard, consumer-controlled, per-price-feed safety contract for production users of Tellor oracle data. It sits between a shared TellorDataBank and a protocol-specific oracle adaptor.

Tellor’s bridge can prove that a value was validly attested by the Tellor Layer validator set. That does not guarantee that every consumer protocol should immediately act on the value. For example, a compromised Layer validator supermajority could attest malicious values that remain cryptographically valid from the EVM bridge’s perspective. The Tellor community might later socially recover or fork Layer and slash the attacker, but that recovery cannot reverse liquidations, borrowing, redemptions, or other actions that an EVM consumer already executed.

TellorShepherd gives each consumer its own final protection boundary. Its key mechanisms are:

- a delay between onchain data submission and eligibility for consumption;
- independent monitoring and fast emergency pause authorities;
- a price-deviation circuit breaker during normal Tellor operation;
- a temporary, delayed override mode for incident recovery or orderly unwind;
- delayed changes to sensitive configuration and operating mode;
- and protocol-specific control over who may advance the accepted oracle value.

The intended standard recommendation is that **every production Tellor price-feed integration using this product stack should use a Shepherd**. Sophisticated users remain free to deploy a different DataBank or build a different Tellor-consumption system, but that is outside the standard product path.

## Product definition

### What TellorShepherd is

TellorShepherd is:

- a standard Tellor consumer-security product;
- one contract instance per consumer protocol per price-feed query ID;
- a delayed curator of values already stored in a TellorDataBank;
- a stateful cache of the last value accepted for that consumer;
- a consumer-controlled circuit breaker and emergency operating boundary;
- and the source used by a protocol-specific UserAdaptor.

### What TellorShepherd is not

TellorShepherd is not:

- the Tellor oracle chain;
- a bridge or light client;
- a replacement for DataBridge signature verification;
- a replacement for TellorDataBank’s shared acceptance filters;
- an independent source of objective price truth;
- a substitute for monitoring and incident response;
- a universal adaptor for every protocol interface;
- a guarantee that an accepted price is economically correct;
- or a long-term centralized oracle.

Override mode is intended as a temporary release valve, not as a permanent replacement for Tellor.

### When it should be used

The intended recommendation is to use TellorShepherd for every production Tellor price-feed integration built on the standard TellorDataBank + TellorShepherd stack.

The current concept is specifically price-feed oriented: values are positive/nonzero numeric prices, the prototype decodes a `uint256`, and the safety logic includes percentage price-deviation checks. Arbitrary non-price Tellor data may require different curation logic.

It may not be the appropriate direct solution for:

- test environments that deliberately use an insecure testing bank such as TellorLab;
- arbitrary non-price query types;
- protocols that cannot tolerate delayed data and have designed another safety model;
- or advanced consumers that deliberately implement and audit a different DataBank/consumer stack.

## The intended Tellor stack

```text
Tellor Layer
  - data is reported, aggregated, and disputed
  - validators attest to aggregate reports and related metadata
        |
        v
TellorDataBridge on the destination EVM chain
  - cryptographically verifies Layer validator attestations
        |
        v
Relayer
  - gathers reports, metadata, validator sets, and signatures
  - submits them to the shared TellorDataBank
        |
        v
Shared TellorDataBank
  - invokes the DataBridge for verification
  - applies shared ordering, freshness, and consensus/fallback filters
  - stores historical data for many query IDs and consumers
        |
        v
Per-consumer, per-feed TellorShepherd
  - delays consumer acceptance
  - maintains the consumer's accepted value
  - applies consumer-specific safety controls and emergency modes
        |
        v
Protocol-specific UserAdaptor
  - exposes the interface expected by the consuming protocol
  - handles units, decimals, staleness, and protocol-specific checks
        |
        v
Consumer protocol
  - for example, a Morpho market or vault
```

### Tellor Layer

Tellor Layer is the decentralized oracle chain. Data reporters submit values; values are aggregated and can be disputed. Validators attest to aggregate reports and associated metadata as snapshots of Layer state. Layer is intended to be permissionless and not controlled by a single price publisher.

### TellorDataBridge

TellorDataBridge is a deterministic Solidity bridge from Tellor Layer to an EVM chain. It verifies validator signatures and validator-set information. At least the configured validator-power threshold must sign relevant bridge data.

The DataBridge establishes provenance and attestation validity. It does not determine whether a validly attested value is safe for a particular lending market, stablecoin, or other application to consume at a particular time.

### Relayer

The relayer is an offchain client that:

1. observes Layer;
2. gathers an aggregate report, attestation metadata, validator-set data, and signatures;
3. and submits those materials to TellorDataBank on the consumer EVM chain.

Relayers submit directly to the DataBank, which invokes the DataBridge during verification. The design goal is to remove as much profitable relayer optionality as practical. In particular, a relayer should not be able to select an advantageous older price from a broad valid history merely because that price benefits a downstream action.

The consumer may run its own relayer for liveness and observability, but it should not have to trust a single relayer for correctness.

### Shared TellorDataBank

TellorDataBank is the shared verification-policy and storage layer. Many users and feeds are expected to use a single deployed DataBank.

This shared model is based on the product assumption that most consumer protocols do not want to understand and independently implement all nuances of:

- Layer aggregation;
- validator attestations;
- consensus versus optimistic data;
- report ordering;
- report and attestation freshness;
- relayer selection;
- and fallback behavior for feeds with different levels of reporter support.

The intended DataBank pattern is **consensus with optimistic fallback**:

- consensus-supported data is preferred when available;
- less-supported data may be accepted only after an optimistic/dispute period and with sufficient report power;
- temporal and ordering filters constrain which values can be stored;
- and the full accepted history is available to downstream Shepherds.

This is intended to support both widely reported blue-chip feeds and less-supported price feeds without making each consumer build a separate bank.

#### Current DataBank prototype behavior

The inspected `TellorDataBank.sol`:

- has immutable constructor parameters for maximum report age, maximum attestation age, and optimistic delay;
- calls `TellorDataBridge.verifyOracleData(...)`;
- rejects reports older than `MAX_DATA_AGE`;
- rejects attestations older than `MAX_ATTESTATION_AGE`;
- requires aggregate timestamps to increase monotonically per query ID;
- rejects a report timestamp in the future;
- applies additional checks when the report timestamp is not the last consensus timestamp;
- requires an optimistic report to have waited at least `OPTIMISTIC_DELAY`;
- requires optimistic report power greater than half of the DataBridge’s configured `powerThreshold`;
- stores value, power, aggregate timestamp, attestation timestamp, and EVM relay timestamp;
- and provides a binary-search lookup for the newest record relayed before a supplied EVM timestamp.

The last power rule should be described exactly. It is not necessarily “more than half of all Layer power.” It is:

```text
aggregatePower > dataBridge.powerThreshold() / 2
```

If the DataBridge threshold represents approximately two-thirds of total power, this lower bound is approximately one-third of total power.

The currently discussed production intentions are approximately:

- `MAX_ATTESTATION_AGE`: 3 minutes;
- `OPTIMISTIC_DELAY`: 30 minutes.

These are design intentions, not deployed facts. DataBank constructor parameters and exact filter behavior become fixed and auditable for a particular deployment. Development tests currently use other values, including a 10-minute attestation age and a 12-hour optimistic delay; those test constants are not production recommendations.

The final production value for `MAX_DATA_AGE` and the exact production filter set remain to be determined.

Consumers will be encouraged to use Tellor’s published DataBank deployments. They may instead use another deployed DataBank or write a different implementation, but then they assume responsibility for that different policy layer.

### Per-consumer TellorShepherd

Many users can share a DataBank, but they should not share one global Shepherd configuration. Each consumer deploys a Shepherd for each relevant price-feed query ID because consumers differ in:

- response time;
- tolerance for delayed or stale data;
- acceptable price movement;
- governance and emergency authorities;
- keeper design;
- liquidation and solvency requirements;
- fallback behavior;
- and incident procedures.

The Shepherd’s `queryId` should be immutable. This prevents configuration drift between the intended feed and the data selected from the DataBank.

### Protocol-specific UserAdaptor

The UserAdaptor translates Shepherd data into the exact interface and units required by a consumer protocol.

For a Morpho integration, the intended pattern is:

- a keeper periodically calls Shepherd’s state-changing `retrieveData()`;
- the adaptor’s read-only `price()` function reads the cached value from `currentValue()`/`getCurrentValue()`;
- the adaptor converts decimals and returns Morpho’s required price scale;
- and the adaptor reverts or follows explicitly defined consumer behavior if the cached data is too old or otherwise invalid.

Required adaptor responsibilities currently include:

- enforce a maximum data age;
- reject zero/non-positive values where the feed semantics require a positive price;
- convert and validate decimals and units;
- interpret the immutable query ID’s base asset, quote asset, and encoding correctly;
- and expose the consumer protocol’s required interface.

The consumer protocol remains responsible for deciding what happens when data is stale, paused, or otherwise unavailable. Fallback sources, liquidation behavior, unwind behavior, and shutdown behavior are not universal Shepherd decisions.

## Security motivation

### Economic-security example

Assume the total TRB staked on Tellor Layer is worth $1 million, while a protocol uses Tellor to secure a $20 million lending market. An attacker who obtains and stakes enough TRB to control at least two-thirds of validator power may be able to force malicious attestations through the Layer validator set.

The Tellor community could detect the attack, socially fork Layer, exclude or slash the attacker, and restore the oracle chain. That protects the future chain state. It does not retroactively undo a malicious value already bridged to EVM and consumed by a lending protocol.

The Shepherd’s delay makes a relayed value visible before it becomes eligible for that consumer. The consumer’s monitors can compare it to primary market sources and pause the Shepherd before the value is accepted. This also reduces the economic incentive to compromise Layer: control of Layer does not automatically produce immediate control over all downstream value.

### Why the social layer is insufficient by itself

Layer recovery and consumer recovery operate on different timelines and systems:

- Layer’s social layer can decide which Layer history the community recognizes.
- TellorDataBridge verifies the signatures and validator-set state it was given according to its deterministic rules.
- An EVM consumer may execute irreversible or economically final actions before social coordination completes.

Consumer-side delay and pause are therefore part of the end-to-end security model, not optional operational polish.

## Threat model

### Threats Shepherd is intended to mitigate

| Threat | Intended Shepherd/DataBank response |
|---|---|
| Compromised Layer supermajority | A malicious but validly attested relay is visible during the consumption delay; monitoring should trigger a pause before acceptance. |
| Compromised or failed one-third causing loss of Layer liveness | The consumer can stop using stale normal data and may temporarily enter override mode or unwind. |
| Erroneous Tellor report | Consumer monitoring compares relays to exchanges/primary sources and pauses when the value is not considered true. |
| Malicious relayer | DataBank ordering, freshness, consensus/fallback, and relay-selection filters are the primary defense; Shepherd adds a consumer delay and final pause boundary. |
| Tellor governance compromise | The consumer can pause its own oracle boundary rather than automatically continuing to consume affected data. |
| DataBank bug or unsuitable behavior | The consumer can pause and, if there is enough warning, use a delayed DataBank migration. The standard model otherwise assumes the selected DataBank has no exploitable bug. |
| Sudden erroneous or manipulated price | A deviation threshold relative to the consumer’s last accepted value can prevent one large jump from being accepted. |
| Keeper failure | The adaptor’s maximum-age check makes stale cached data unusable rather than silently treating it as fresh. |
| Override pipeline incident | Override submissions are delayed and remain subject to the same independent pause control. |

### Threats not eliminated

#### Compromised admin

The admin is a critical trust assumption. It is expected to be a slow, high-security protocol multisig. Delays make malicious changes observable and allow intervention where an intervention path exists, but complete admin compromise cannot be fully neutralized by Shepherd.

#### Compromised overrider

If any authorized overrider can submit a value, compromise of one overrider permits submission of a bad override value. Multiple independent overrider EOAs improve availability but do not create quorum security.

The defenses are:

- override values are delayed;
- independent monitors observe every submission;
- independent pausers can halt all reads;
- and a protocol may appoint a quorum-verifying contract as its overrider.

That external overrider contract could implement a proposal/signature workflow in which one or more reporting processes propose a value and other processes independently verify and sign it.

#### Compromised pauser

A compromised pauser can cause loss of liveness by pausing. It should not be able to unpause, change data, enter override mode, or modify parameters.

#### Failed monitoring or response

A delay does not protect a consumer unless:

- the value is observed before it matures;
- monitors identify that it is bad or high-risk;
- a pauser remains available;
- and the pause transaction is included before consumption.

The delay should be sized to the complete detection-and-response process, not only to automated alert latency.

#### Legitimate extreme price movement

A true rapid market move can exceed the deviation limit and leave the Shepherd on an older value. This is an intentional safety-versus-liveness trade-off. The adaptor’s freshness rule must eventually prevent indefinite use of that old value.

#### Gradual or staircase manipulation

A per-update deviation bound does not prove correctness. A sequence of individually small accepted movements can move the cached price a long distance. Restricting `retrieveData()` callers limits who can advance this sequence, while monitoring and delay remain the primary defenses.

If a consumer intentionally makes retrieval permissionless, it accepts a weaker boundary against staircase advancement.

#### Market manipulation generally

The deviation threshold may reduce damage from a sudden manipulated or erroneous value, but it is not a complete market-manipulation defense. Shepherd has no independent source of truth. The monitoring system must compare Tellor values to suitable exchanges and primary/reference sources.

#### Consumer integration errors

Shepherd cannot repair:

- incorrect decimals;
- a mistaken understanding of the query;
- an unsafe freshness threshold;
- unsafe liquidation or fallback logic;
- or protocol code that ignores adaptor failures.

## Core assumptions

The standard product relies on the following assumptions:

- TellorDataBridge correctly verifies validator attestations and validator-set state.
- The selected TellorDataBank implements its documented filters correctly and has no exploitable bug, or monitoring and pause/migration occur before a bug harms the consumer.
- EVM `block.timestamp` is sufficiently reliable for delay and override-observation semantics.
- The consumer operates independent monitoring against appropriate primary/reference markets.
- At least one honest pauser can act within the configured delay.
- The admin multisig remains secure and operational.
- Authorized normal-mode updaters/keepers remain operational.
- Override mode is temporary and is backed by an operational process appropriate to its risk.
- The UserAdaptor correctly enforces freshness, positive-value, unit, and interface rules.
- The consumer explicitly defines behavior when the oracle is paused, stale, or unavailable.

## Intended Shepherd design

### Two independent state dimensions

The clean state model has two independent dimensions:

1. **Data-source mode**
   - `NORMAL`: use delayed TellorDataBank data.
   - `OVERRIDE`: use delayed override submissions only.

2. **Pause flag**
   - `UNPAUSED`: reads and authorized updates are allowed.
   - `PAUSED`: no oracle value can be read or consumed, regardless of source mode.

This means “paused” is not an alternative data source. A Shepherd can be paused in either normal or override mode.

| Mode | Pause flag | Read behavior |
|---|---|---|
| Normal | Unpaused | Return cached normal Tellor value; authorized retrieval may accept a newer eligible DataBank value. |
| Normal | Paused | No value may be read or consumed. |
| Override | Unpaused | Return cached eligible override value only; ignore TellorDataBank values. |
| Override | Paused | No value may be read or consumed, but authorized overriders may continue submitting values. |

### Intended roles

#### Admin

There is one admin address. It should normally be a slow, high-security protocol multisig.

The admin is responsible for infrequent actions such as:

- proposing and executing data-source-mode changes;
- adding and removing pausers;
- adding and removing overriders;
- configuring authorized `retrieveData()` callers;
- enabling or disabling permissionless retrieval;
- changing the DataBank through a delayed process;
- changing the price-deviation threshold through a delayed process;
- and transferring the admin role through a delayed, two-step process.

The admin should not be the only party capable of emergency pause, and it should not be required to publish every override update.

#### Pausers

There may be multiple pauser addresses.

Any pauser may pause immediately. Pausers exist so monitoring operators or narrowly scoped hot keys can react more quickly than an M-of-N governance multisig.

Pausers cannot:

- unpause;
- change configuration;
- publish override data;
- change mode;
- or change roles.

Adding a pauser should be delayed. Removing a pauser should be immediate. This makes installation of a new hot authority observable while allowing rapid removal of a compromised one.

#### Overriders

There may be multiple overrider addresses.

Overriders may submit new price values only after override mode has been executed. They may submit while the Shepherd is paused, allowing values to mature during incident response. They cannot activate override mode themselves.

Adding an overrider should be delayed. Removing an overrider should be immediate.

A designated overrider may be:

- a purpose-specific EOA/process;
- a multisig capable of the required cadence;
- or a contract that verifies a threshold of offchain/onchain reporters.

#### Authorized retrieval callers

The admin can maintain a set of addresses permitted to call the state-changing `retrieveData()` function.

The admin can also configure retrieval as open to all addresses. This provides integration flexibility, but it changes the security properties of the last-consumed-value deviation check because anyone can advance accepted state.

The intended Morpho pattern is to authorize a keeper/updater address. The Morpho adaptor remains read-only and reads Shepherd’s cached value.

The timing rules for adding/removing authorized retrieval callers and enabling permissionless retrieval remain to be finalized. Security-sensitive expansion of retrieval authority should probably be delayed; emergency removal should probably be immediate.

### Parameters and important state

The intended design requires, at minimum, concepts equivalent to:

- configured `dataBank`;
- immutable `queryId`;
- one shared consumption `DELAY` for normal DataBank relays and override submissions;
- normal-mode `priceChangeThresholdBps`;
- an unpause delay;
- a DataBank-change delay;
- a threshold-change delay;
- an override-entry delay;
- an override-exit/recovery delay;
- role-addition delays;
- an admin-transfer delay;
- current mode;
- pause flag;
- last consumed value;
- last consumed observation/aggregate timestamp;
- last consumed EVM submission/relay timestamp;
- override submission history;
- role sets;
- and retrieval access-control configuration.

Exact parameter names, which values are immutable, and whether some administrative delays can share one constant remain design questions.

## Normal-mode data flow

The intended normal flow is:

1. A relayer submits Tellor data to the shared DataBank.
2. The DataBank invokes the DataBridge, applies its filters, and stores the record with `relayTimestamp = block.timestamp`.
3. The record is immediately visible to monitoring, but is not yet eligible for the consumer’s Shepherd.
4. The consumer’s monitor compares the relayed value to exchanges and other primary/reference sources.
5. After the shared Shepherd `DELAY`, an authorized caller invokes `retrieveData()`.
6. Shepherd requests the newest DataBank record relayed before the delay cutoff.
7. Shepherd confirms that the candidate is newer than its accepted state, nonempty, decodable, and within the normal price-deviation threshold.
8. If accepted, Shepherd updates its cached current value and timestamps.
9. The UserAdaptor’s read-only function reads that cached value, checks freshness and positivity, converts units, and exposes it to the consumer protocol.

If no newer eligible value exists, the cached value remains unchanged. If a candidate fails the deviation check, the cached value also remains unchanged. The adaptor’s maximum-age rule ensures that an indefinitely unchanged cache eventually becomes unusable.

Whether failed retrieval should silently return the cached value, emit a rejection event, or revert is still a specification detail. An explicit event would improve monitoring even if cached fallback is retained.

## Pause and unpause

### Pause

Any authorized pauser should be able to pause immediately.

While paused:

- no current oracle value can be read;
- no normal or override value can be consumed into active state;
- override submissions may still be stored if override mode is active;
- pending administrative proposals may remain visible;
- and consumer protocol behavior is determined by its adaptor/integration.

Pausing should clear or invalidate any pending unpause so a previous unpause proposal cannot be executed immediately after a new incident.

### Unpause

Unpause should be controlled by the admin and delayed. The delay gives monitors time to verify that the incident is resolved and to pause again/cancel if conditions remain unsafe.

The exact cancellation authority and whether a pauser may cancel a pending unpause remain to be finalized. Allowing pausers to cancel—but not execute—an unpause may be a useful safety property.

## Override-mode entry

Override mode exists for temporary liveness or orderly unwind when the normal Tellor path is broken, compromised, or too risky to use.

Decisions made so far:

- only the admin may propose and execute override mode;
- override mode must be proposed while the Shepherd is paused;
- entry uses a propose/wait/execute process;
- overriders cannot submit before override mode is executed;
- the admin must provide the first override value when executing entry;
- and that first value is delayed before consumption, like every later override value.

A likely operational sequence is:

1. A pauser pauses because normal Tellor data or infrastructure is unsafe.
2. The admin proposes override mode while paused.
3. The override-entry delay passes while monitoring and governance evaluate the response.
4. The admin executes override mode and supplies the first override price.
5. Shepherd records the first override value with the current EVM `block.timestamp`.
6. The first value waits the shared `DELAY`.
7. The admin follows the delayed unpause process.
8. Once unpaused and once an override value is eligible, authorized retrieval can accept override data.

Whether execution of override entry must also occur while paused, and exactly how override-entry and unpause delays may overlap, remain to be specified.

## Override data flow

### Submission

While override mode is active, any authorized overrider may submit a numeric price. Override submission is allowed even while paused. The feed is expected to represent a positive/nonzero price, but whether Shepherd itself rejects zero or leaves that check exclusively to the UserAdaptor remains open.

The overrider does **not** provide a timestamp. Shepherd records `block.timestamp` automatically and treats it as the override observation/submission timestamp. This prevents the overrider from supplying a future timestamp or arbitrary historical timestamp, but it assumes the submitted price was observed close to the onchain transaction time.

Each submission should record at least:

- price value;
- EVM observation/submission timestamp;
- submitting overrider;
- and a sequence/index.

### Delay and selection

Override submissions use the same `DELAY` as normal DataBank relays.

The Shepherd must retain enough history to select the **newest eligible override submission** whose EVM submission timestamp is older than the delay cutoff. Values are always delayed before they can be accepted.

A single replaceable pending-value slot is insufficient. If frequent submissions continually replace that slot, no value may ever mature. An indexed history plus binary search, or an equivalent pending/current structure, is needed.

Storage-growth, authorized-overrider spam, pruning, and retrieval-gas behavior remain implementation considerations.

### Acceptance and reads

Override values are not subject to the normal price-deviation limit. This prevents the normal circuit breaker from blocking necessary emergency repricing.

However:

- only an authorized retrieval caller may advance the consumed override value unless retrieval is explicitly permissionless;
- override submissions remain visible during the delay;
- pausers may halt all reads before a bad override becomes eligible;
- and the UserAdaptor still applies its maximum-age and positive-value checks.

When unpaused in override mode:

- `retrieveData()` selects and caches the newest eligible override value;
- the read-only current-value function returns only the cached override value;
- and normal TellorDataBank values are ignored.

## Returning from override to normal mode

Returning to Tellor should use a deliberate propose/wait/execute recovery flow. Unlike entry into override mode, proposing or executing the return does not currently need to require a pause. Pause is reserved for situations where all consumption is considered unsafe.

Decisions made so far:

1. The admin proposes return to normal mode.
2. A recovery delay passes before execution.
3. A candidate Tellor value must have passed the ordinary relay-consumption delay.
4. The candidate Tellor aggregate timestamp must be newer than the last consumed override timestamp after normalizing timestamp units.
5. The candidate Tellor value must be within the same `priceChangeThresholdBps` used during ordinary normal-mode operation, measured against the last consumed override value.
6. Pausers retain the ability to halt all consumption if the proposed recovery looks unsafe.

Tellor aggregate timestamps are represented in milliseconds, while EVM `block.timestamp` and override timestamps are in seconds. The comparison must explicitly normalize units, for example:

```text
tellorAggregateTimestamp / 1000 > lastConsumedOverrideTimestamp
```

Using the same deviation threshold keeps configuration simpler and is sufficient unless a future consumer wants different recovery risk.

An important implementation detail remains to be decided: execution of the return should probably atomically validate and cache the selected Tellor recovery value. If mode changes first and the value is only accepted by a later `retrieveData()` call, the contract needs precisely defined behavior for the interval between those actions.

The system also needs defined behavior if a new override value is consumed after return-to-normal has been proposed. The recovery comparison should use the last override value actually consumed at execution time, not a stale proposal-time snapshot, unless the proposal is invalidated by later override updates.

## Price-deviation circuit breaker

### Intended rule

During normal Tellor operation, a new candidate is compared with the last value consumed by that Shepherd:

```text
absolute(candidate - lastConsumedValue) / lastConsumedValue
    <= priceChangeThresholdBps / 10,000
```

The first accepted value needs a separate initialization rule because there is no prior value.

When leaving override mode, the returning Tellor candidate is compared with the last consumed override value using the same threshold.

Override-to-override updates do not use this threshold.

### Why compare with the last consumed value

Comparing a candidate only with the immediately preceding DataBank relay would be weak. Two or more consecutive malicious relays could each be near the prior malicious value and make the final value look acceptable.

The last-consumed anchor ties the bound to state the consumer explicitly accepted. It also makes the behavior dependent on retrieval cadence and retrieval authority.

### Retrieval-authority implications

If retrieval is permissionless, an attacker may be able to wait for a series of small malicious values to mature and call `retrieveData()` after each one, walking the accepted value while staying under the per-update threshold.

Restricting retrieval to consumer-authorized updaters makes this harder and better aligns “last consumed” with actual protocol operations. It does not replace monitoring: a compromised updater or publicly callable integration path may still advance values.

Consumers that enable permissionless retrieval should explicitly acknowledge this trade-off.

### Why a comparison window is not currently selected

A possible alternative is a `PRICE_DEVIATION_COMPARISON_WINDOW` that compares a candidate with an accepted value from a fixed amount of time earlier. This can cap cumulative movement over a window and reduce dependence on call frequency.

It also introduces:

- additional history and lookup logic;
- behavior when no suitable historical anchor exists;
- another risk parameter;
- and a greater chance of rejecting a legitimate sustained trend.

For the simple standard design, the current direction is to compare against the last consumed value and treat the consumption delay plus monitoring/pause as the primary security controls. A time-window bound can be reconsidered if concrete simulations show that it materially improves a target integration.

### Choosing a threshold

Price variance should not be expected to decline merely because more time passes. In a simplified random-return model, variance grows with elapsed time and typical absolute movement grows roughly with the square root of elapsed time. Crypto markets also exhibit jumps and volatility clustering.

No static deviation threshold guarantees both correctness and liveness. A threshold that blocks attacks may also block a real crash or rally.

Parameter guidance should:

- define the maximum effective update interval, including feed cadence, relay delay, and expected keeper interval;
- examine extreme but legitimate historical movement over that interval;
- add a documented safety margin;
- test historical stress and discontinuous markets;
- model the protocol’s liquidation, insolvency, redemption, or collateral risks;
- and treat suggested ranges as starting points rather than universal safe values.

The first recommended parameter bands should be developed using concrete examples such as:

- Morpho lending markets/vaults;
- stablecoin collateral systems;
- and other real price-feed integrations.

Exact bands have not been selected.

## Keeper and read model

Shepherd separates accepting a new value from reading the cached value.

### State-changing update

`retrieveData()`:

- is state-changing;
- selects the newest eligible source value for the active mode;
- applies the mode’s acceptance rules;
- and advances the cached value.

Its caller is restricted to configured addresses unless the admin explicitly enables permissionless retrieval.

### Read-only access

The current-value function:

- is read-only;
- returns the cached value and its relevant timestamp;
- and reverts or otherwise refuses access while paused.

### Morpho example

Morpho’s oracle interface is read-only, so the intended integration is:

1. a keeper calls `retrieveData()` periodically;
2. Shepherd caches the newly accepted value;
3. Morpho calls the adaptor’s read-only `price()`;
4. the adaptor reads Shepherd’s cached current value;
5. the adaptor checks freshness and positivity;
6. the adaptor converts decimals and returns the required scale.

If the keeper fails, the cached value eventually exceeds the adaptor’s maximum age and the adaptor stops treating it as usable.

Keeper cadence is therefore part of both liveness and deviation-threshold calibration.

## Monitoring requirements

The oracle consumer’s deployer, custodian, or designated operators are responsible for monitoring. This is a required part of safe Shepherd operation.

For every relevant query ID, monitoring should:

- observe every value submitted to the configured DataBank, including values not yet eligible for Shepherd;
- decode and compare values to suitable exchanges and other primary/reference price sources;
- calculate when each relay will become Shepherd-eligible;
- alert when a value appears untrue or materially suspect;
- alert when a value exceeds or approaches the configured deviation threshold;
- alert when a candidate is rejected or the cached value does not advance;
- alert on stale Layer aggregate data;
- alert on stale DataBank relay activity;
- alert on stale Shepherd cached data;
- monitor keeper health and successful `retrieveData()` calls;
- monitor relayer health and optionally operate a relayer;
- monitor Layer disputes, validator concentration, validator liveness, governance, bridge events, and known incidents;
- monitor every override submission and its eligibility time;
- monitor role additions/removals, retrieval-access changes, parameter proposals, DataBank changes, mode proposals, admin transfers, pauses, and unpause proposals;
- and retain an operational path to an authorized pauser.

Monitoring should distinguish:

- a value being reported on Layer;
- a value being stored in the DataBank;
- a value maturing past the Shepherd delay;
- a value being consumed/cached by Shepherd;
- and a value being returned by the UserAdaptor.

These are separate events and security boundaries.

## Choosing the shared consumption delay

The same `DELAY` applies to:

- normal DataBank records, measured from their EVM relay timestamps;
- and override records, measured from their EVM submission timestamps.

Its primary purpose is to give the consumer time to detect and stop malicious or faulty data before it becomes consumable.

The delay should cover:

1. data ingestion and decoding;
2. comparison to reference sources;
3. alert generation;
4. human or automated investigation;
5. escalation to an authorized pauser;
6. transaction signing;
7. EVM transaction inclusion;
8. and a safety margin for operational failures.

A protocol that can tolerate older prices should generally choose a longer delay for a larger response window. A longer delay improves reaction time but makes the normal feed systematically older and can affect liquidation and market risk.

Override uses the same delay for simplicity and the same core reason: a compromised override submission should be visible before use.

## Incident-response flows

### Bad normal Tellor/DataBank value

1. Monitoring sees the DataBank relay immediately.
2. Monitoring compares it with primary/reference sources.
3. A pauser pauses before the relay’s Shepherd delay expires.
4. The consumer investigates Layer, relayer, bridge, DataBank, and market conditions.
5. Depending on the incident, it restores normal operation, changes DataBank after delay, enters temporary override, or begins an orderly unwind.

### Loss of normal oracle liveness

1. Monitoring detects stale reporting, relaying, or Shepherd state.
2. The adaptor’s freshness limit prevents indefinite use of old data.
3. The protocol decides whether to pause, wait for recovery, enter override, or unwind.
4. If entering override, the admin follows the paused propose/execute process.

### Temporary override operation

Override may be used to:

- continue essential operations while Tellor, bridge, DataBank, or relay issues are repaired;
- continue liquidations so a lending vault does not become insolvent;
- provide a controlled price path for users exiting positions;
- or support orderly shutdown.

It should be temporary. The protocol must document whether its override policy permits general continued operation, unwind-only operation, or both.

Overriders submit prices frequently enough to meet the adaptor’s freshness rule. Monitoring compares every submission with independent sources. Pausers can stop the override pipeline at any time.

### Recovery to Tellor

1. Monitoring establishes that the normal Tellor path appears healthy.
2. The admin proposes return to normal mode.
3. The recovery delay passes.
4. At execution, Shepherd identifies a delayed, eligible Tellor candidate.
5. It verifies that the candidate’s normalized aggregate timestamp is newer than the last consumed override timestamp.
6. It verifies that the candidate is within the ordinary deviation threshold of the last consumed override value.
7. It atomically switches and preferably caches that Tellor value.
8. Monitoring verifies continuing Tellor updates.
9. A pauser remains able to halt immediately if recovery proves unsafe.

This recovery flow does not inherently require pausing, although a protocol may pause voluntarily if conditions warrant.

## Administrative change model

The general design principle is:

- emergency restriction can be immediate;
- expansion of authority or relaxation/change of safety policy should be delayed.

Decisions made so far:

- adding pausers is delayed;
- removing pausers is immediate;
- adding overriders is delayed;
- removing overriders is immediate;
- DataBank changes are proposed and delayed;
- price-threshold changes are proposed and delayed;
- unpause is proposed and delayed;
- override entry is proposed and delayed;
- override exit is proposed and delayed;
- and admin replacement uses a delayed two-step transfer.

Still to decide:

- timing for retrieval-caller additions/removals;
- timing for enabling/disabling permissionless retrieval;
- who may cancel each pending proposal;
- whether pausers may cancel risky proposals without being able to execute them;
- whether one general administration delay or action-specific delays should be used;
- and which proposals are automatically invalidated by pause, mode change, role removal, or a newer proposal.

## Current TellorShepherd Solidity prototype

The inspected work-in-progress `contracts/databank/TellorShepherd.sol` currently has:

- one immutable admin;
- one immutable query ID;
- one configurable DataBank address;
- immutable relay-consumption, unpause, DataBank-change, and threshold-change delays;
- a configurable normal price-deviation threshold;
- cached last returned value, Layer aggregate timestamp, and DataBank relay timestamp;
- a pause flag;
- and a single-slot manual override.

### Current normal retrieval

The current `retrieveData()`:

- is permissionless;
- reverts while paused;
- returns the manual override immediately if override is active;
- otherwise calls `dataBank.getRelayBefore(queryId, block.timestamp - RELAY_CONSUMPTION_DELAY)`;
- returns the cached value if no newer eligible record exists;
- returns the cached value if the selected record has empty bytes;
- requires the relay timestamp to increase;
- decodes the value as `uint256`;
- compares it to `lastReturnedValue`;
- returns the cached value rather than reverting if the deviation check fails;
- and caches/emits the candidate when accepted.

The current code treats a zero threshold as disabling the deviation check. The first value is accepted without comparison. The constructor currently caps the threshold at 10,000 basis points (100%).

`getCurrentValue()` reverts while paused, returns the single manual override while it is active, and otherwise returns the cached normal value. It reverts if no normal value has ever been cached.

### Current pause/admin/configuration behavior

The current prototype:

- lets only the immutable admin pause;
- lets only the admin propose, cancel, and execute delayed unpause;
- lets only the admin propose, cancel, and execute delayed DataBank changes;
- and lets only the admin propose, cancel, and execute delayed threshold changes.

It has no pauser set, overrider set, authorized retrieval-caller set, permissionless-retrieval toggle, or admin-transfer mechanism.

### Current manual override behavior

The current prototype:

- lets the admin activate manual override only while paused;
- lets the admin set a single override value and caller-supplied timestamp;
- automatically activates override on first set if the contract is paused;
- allows the admin to replace the value while override remains active;
- applies no override consumption delay;
- stores no override history;
- and lets the admin clear override immediately.

Because both current read functions reject calls while paused, current override data is readable only after unpause. This happens to align with the intended principle that pause blocks all data, but the single-slot, immediate override does not implement the intended delayed override pipeline.

The current `retrieveData()` returns active manual override data without updating the normal `lastReturnedValue`/timestamp cache. It therefore does not implement the intended cross-mode recovery anchor.

### Prototype maturity warning

The Shepherd, DataBank, interface, artifacts, and tests are active uncommitted work in the inspected repository. Source and tests may be changing and may temporarily disagree. The prototype should not be treated as deployed, audited, or production-ready.

## Gap between current code and intended design

| Area | Current prototype | Intended direction |
|---|---|---|
| Admin | Immutable single address | Replaceable through delayed two-step transfer; expected multisig |
| Pause | Admin only | Multiple fast pausers; any can pause immediately |
| Pauser changes | None | Delayed addition, immediate removal |
| Override publisher | Admin only | Multiple overriders or authorized overrider contract |
| Overrider changes | None | Delayed addition, immediate removal |
| Override entry | Immediate activation while paused | Admin-only propose/wait/execute; proposal while paused; first value supplied at execution |
| Override submissions | Single replaceable slot | Historical submissions; newest eligible wins |
| Override timestamp | Caller supplied | Automatic EVM `block.timestamp` |
| Override delay | None | Same `DELAY` as normal relayed data |
| Override deviation | None | None, intentionally |
| Pause during override | Blocks reads | Blocks reads; submissions may continue while override mode is active |
| Override exit | Immediate clear | Admin propose/wait/execute with recovery checks |
| Recovery ordering | None | Tellor aggregate time must be newer than last consumed override time after unit normalization |
| Recovery deviation | None | Same normal deviation threshold, relative to last consumed override value |
| Retrieval callers | Permissionless | Admin-configured allowlist with optional permissionless mode |
| Current-value reader | Public view, blocked while paused | Same general pattern |
| Keeper model | Not enforced | Authorized keeper for Morpho-style integrations |
| Adaptor freshness | Outside contract | Required in UserAdaptor |
| DataBank migration | Delayed | Retain delayed migration |
| Threshold change | Delayed | Retain delayed change |
| Price comparison | Last consumed normal value | Last consumed value across the relevant mode transition |

## Parameter categories

### DataBank deployment parameters

These are shared and fixed for a particular immutable deployment:

- maximum data age;
- maximum attestation age;
- optimistic fallback delay;
- DataBridge address;
- and exact acceptance/filter behavior.

Current intended starting concepts include a roughly 3-minute maximum attestation age and roughly 30-minute optimistic delay, but no production deployment specification is final.

### Shepherd deployment/configuration parameters

These are consumer-specific:

- DataBank address;
- immutable query ID;
- shared normal/override consumption delay;
- price-deviation threshold;
- unpause delay;
- DataBank-change delay;
- threshold-change delay;
- override-entry delay;
- override-exit/recovery delay;
- role-addition delays;
- admin-transfer delay;
- initial admin;
- initial pausers;
- initial overriders;
- initial authorized retrieval callers;
- and whether retrieval is permissionless.

Numeric recommendations remain to be developed from concrete integrations and simulations.

### UserAdaptor parameters

These are protocol-specific:

- maximum cached-data age;
- decimal scaling;
- expected base/quote semantics;
- positive/nonzero requirements;
- consumer oracle interface;
- and behavior on stale, paused, or unavailable data.

## Decided design points

The following points are considered decided for the current design direction:

1. Shepherd is recommended for every production Tellor price-feed integration using the standard stack.
2. One Shepherd instance serves one consumer and one immutable query ID.
3. Tellor’s published shared DataBank deployments are the standard upstream source, although custom banks remain possible.
4. The normal relay-consumption delay is measured from EVM relay time.
5. The same delay applies to override submission time.
6. Pause blocks all reads in both normal and override mode.
7. Pause is independent of normal/override mode.
8. There is one admin, normally a slow protocol multisig.
9. There may be multiple fast pausers.
10. There may be multiple frequent-update overriders.
11. Adding pausers/overriders is delayed; removing them is immediate.
12. Only the admin may propose and execute override entry.
13. Override entry must be proposed while paused.
14. Overriders may submit only after override mode has executed.
15. The admin supplies the first override value at execution.
16. Override submissions use automatic EVM `block.timestamp`, not a caller-supplied timestamp.
17. Override submissions can continue while paused once override mode is active.
18. The newest eligible override submission wins.
19. Override-to-override values are not subject to the price-deviation threshold.
20. Return to normal uses a delayed propose/execute flow and does not inherently require pausing.
21. A returning Tellor value must be newer than the last consumed override value by normalized timestamp.
22. A returning Tellor value uses the ordinary deviation threshold relative to the last consumed override price.
23. Normal Tellor deviation is measured against the last consumed value.
24. `retrieveData()` callers are configurable, with an optional permissionless mode.
25. Morpho-style integrations use a keeper for retrieval and a read-only adaptor for `price()`.
26. The adaptor must check freshness to cover both oracle and keeper failure.
27. The admin is transferable through a delayed two-step process.
28. Override is temporary: it can support continued essential operation or orderly unwind, but is not the intended long-term oracle.

## Open design and implementation questions

1. Must execution of override entry still require the Shepherd to be paused, or only its proposal?
2. What is the exact relationship between override-entry delay, first-value delay, unpause proposal, and unpause execution?
3. Should return-to-normal execution atomically cache the validated Tellor recovery value?
4. Does consuming a new override value invalidate or update an already pending return-to-normal proposal?
5. What happens if no eligible or sufficiently recent Tellor value exists when return execution is attempted?
6. Should pausers be able to cancel pending unpause, mode-change, role-addition, DataBank-change, threshold-change, retrieval-access, or admin-transfer proposals?
7. What are the delays for each administrative action, and which can share one delay?
8. Are authorized retrieval-caller additions delayed and removals immediate?
9. Is enabling permissionless retrieval delayed, and can disabling it be immediate?
10. Should `retrieveData()` revert on rejected data, silently return the cache, and/or emit a detailed rejection event?
11. How should accepted state be initialized before the first normal value?
12. Must the first override value be positive/nonzero in Shepherd, or is positivity exclusively an adaptor rule?
13. How is override history stored efficiently, and is pruning necessary?
14. Is there a minimum or maximum override submission cadence?
15. Should removal of an overrider affect its already-stored, not-yet-eligible submissions?
16. Should role changes affect pending transactions/proposals created by a subsequently removed actor?
17. What exact maximum-age value should each example adaptor use?
18. What numeric threshold and delay bands should be recommended for Morpho, stablecoins, and other initial examples?
19. What is the final production TellorDataBank deployment specification?
20. Should the standard include a reference quorum-based overrider contract and reporter process?
21. Should a future version add a time-window cumulative deviation bound after simulation, or retain only last-consumed comparison?
22. What consumer behavior is expected when `currentValue()` reverts due to pause or the adaptor rejects stale data?
23. What incentives, redundancy, and failover should keeper operation use?
24. Which fields and reason codes should events expose for monitoring and incident forensics?
25. Which contracts and parameters are immutable versus delayed-changeable in the final standard?

## Suggested subjects for further discussion

Useful next discussions include:

- formalizing the two-dimensional mode/pause state machine;
- specifying exact role-management and proposal-cancellation permissions;
- designing override history and newest-eligible lookup;
- making return-to-normal atomic and unambiguous;
- modeling staircase attacks under restricted and permissionless retrieval;
- backtesting deviation thresholds and delays against real asset histories;
- defining a Morpho keeper and adaptor reference implementation;
- defining a reference quorum-based override publisher;
- writing operational monitoring and incident-response playbooks;
- and turning this briefing into an implementation specification and audit checklist.

## Sources and evidence status

This briefing was synthesized from:

- the product owner’s TellorShepherd draft and follow-up design decisions;
- the current work-in-progress `TellorShepherd.sol`, `TellorDataBank.sol`, and `ITellorDataBank.sol`;
- the current Shepherd/DataBank tests;
- and local Layer wiki material about Tellor Layer, bridge attestations, consumer verification, DataBank behavior, robust versus optimistic/edge data, and cross-chain security.

Product-owner statements and design decisions are authoritative for intent but are not proof of implementation. Current code is evidence of prototype behavior but may change. Layer wiki pages contain a mix of source-derived material and provisional documentation; deployed contract code and deployment-specific parameters should ultimately be the source of truth for production behavior.
