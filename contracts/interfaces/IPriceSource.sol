// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

/**
 * @author Tellor Inc.
 * @title IPriceSource
 * @notice Protocol-neutral reader for one fixed base/quote feed.
 * @dev Feed identity, base/quote direction, and precision must remain immutable.
 * Readers normalize prices to quote units per whole base unit, scaled by 10 ** decimals().
 * Interchangeable primary and backup sources must agree on that meaning and decimals().
 * Source-specific query identifiers may differ; this interface does not expose or check them.
 */
interface IPriceSource {
    /**
     * @notice Returns a raw price and its source timestamp; availability failures may revert.
     * @dev Successful reads may return zero prices or zero/future timestamps. Callers must
     * validate usability and age; Shepherd treats invalid returned data differently from a failed call.
     * Implementations must document the timestamp's source meaning (for example, TWAP interval end or
     * spot observation time). It must never be renewed merely by reading or switching
     * sources. A TWAP endpoint does not establish freshness of every contributor.
     * No maximum age is specified here.
     * @return _value Quote units per whole base unit, scaled by the declared decimals.
     * @return _timestampMs Source timestamp in milliseconds, with the documented meaning.
     */
    function getCurrentValue() external view returns (uint256 _value, uint256 _timestampMs);

    /**
     * @notice Returns the immutable number of decimal places used to scale prices.
     * @return Decimal places used to scale raw source prices.
     */
    function decimals() external view returns (uint8);
}
