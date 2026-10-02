// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @title ITellorDataBank
 * @notice Interface for TellorDataBank contract
 */
interface ITellorDataBank {
    // Structs
    struct AggregateData {
        bytes value;
        uint256 power;
        uint256 aggregateTimestamp;
        uint256 attestationTimestamp;
        uint256 relayTimestamp;
    }

    /**
     * @dev A preceding reference, not the current candidate price. All times are milliseconds.
     * Prices are held from each observation until the next; the end observation has zero weight.
     * Only stored observations contribute; signed predecessor links do not define intervals.
     * Relayers may omit reports, so this reference does not reconstruct all Layer history.
     */
    struct TwapData {
        uint256 value;
        uint256 startIndex;
        uint256 endIndex;
        uint256 startTimestamp;
        uint256 endTimestamp;
        uint256 observationCount; // Positive-duration contributors: endIndex - startIndex.
    }

    // Getter functions

    /**
     * @dev returns the aggregate data for a given query ID and index
     * @param _queryId the query ID to get the aggregate data for
     * @param _index the index of the aggregate data to get
     * @return _aggregateData the aggregate data
     */
    function getAggregateByIndex(bytes32 _queryId, uint256 _index) external view returns (AggregateData memory _aggregateData);

    /**
     * @dev returns the total number of aggregate values
     * @param _queryId the query ID to get the aggregate value count for
     * @return number of aggregate values stored
     */
    function getAggregateValueCount(bytes32 _queryId) external view returns (uint256);

    /**
     * @dev returns the current aggregate data for a given query ID
     * @param _queryId the query ID to get the current aggregate data for
     * @return _aggregateData the current aggregate data
     */
    function getCurrentAggregateData(bytes32 _queryId) external view returns (AggregateData memory _aggregateData);

    /**
     * @dev returns the newest stored relay whose EVM relay time is strictly before `_timestamp`
     * @param _queryId the query ID to search
     * @param _timestamp EVM timestamp cutoff in seconds; eligible relays satisfy relayTimestamp < _timestamp
     * @return _found whether a matching relay exists
     * @return _aggregateData the matching relay, or an empty struct if not found
     */
    function getRelayBefore(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bool _found, AggregateData memory _aggregateData);

    /**
     * @notice Returns a wider-interval TWAP ending at the newest relay strictly before a cutoff.
     * @dev Select end using relayTimestamp < _relayCutoffSeconds. Select start as the newest
     * observation with aggregateTimestamp <= end.aggregateTimestamp - _minWindowMs.
     * Weight preceding prices over [start.aggregateTimestamp, end.aggregateTimestamp),
     * divide by that full duration, and round down. Do not interpolate or extend to the cutoff.
     * The endpoint and all newer prices contribute no weight. Actual coverage is >= the minimum.
     * A zero minimum window is invalid and must revert. Missing end/start history (including
     * an end timestamp smaller than the minimum window) returns false and an empty struct.
     * Availability means a reference can be computed, not that its quality is acceptable:
     * consumers must assess contributor count and actual coverage separately.
     * Internal gaps are neither reported nor screened; one held price may dominate the interval.
     * A previousTimestamp mismatch neither splits the interval nor makes the reference unavailable.
     * Stored prices are positive uint192-range first words; aggregate timestamps fit uint64.
     * @param _queryId Feed whose history supplies the reference.
     * @param _relayCutoffSeconds Exclusive EVM relay-time cutoff in seconds.
     * @param _minWindowMs Positive minimum aggregate-time duration in milliseconds.
     * @return _available Whether the requested reference can be computed.
     * @return _twap Reference value and coverage metadata; never a substitute current price.
     */
    function getTwapBefore(bytes32 _queryId, uint256 _relayCutoffSeconds, uint256 _minWindowMs)
        external
        view
        returns (bool _available, TwapData memory _twap);
}
