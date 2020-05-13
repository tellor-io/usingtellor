pragma solidity ^0.5.0;

import "../Optimistic.sol";
/**
* @title Reader
* This contracts is a pretend contract using Tellor that compares two time values
*/
contract TestContract is Optimistic {
    uint256 public startDateTime;
    uint256 public endDateTime;
    uint256 public startValue;
    uint256 public endValue;
    bool public longWins;
    bool public contractEnded;
    event ContractSettled(uint256 _svalue, uint256 _evalue);
    /**
    * @dev This constructor function is used to pass variables to the optimistic contract's constructor
    * and the function is blank
    * @param _tellorContract address for UserContract
    * @param _disputeFeeRequired the fee to dispute the optimistic price(price sumbitted by known trusted party)
    * @param _disputePeriod is the time frame a value can be disputed after being imputed
    * @param _requestId are the requests Id's on the Tellor System corresponding to the data types used on this contract.
    * @param _granularity is the amount of decimals desired on the requested value
    */
    constructor(address payable _tellorContract, uint256 _disputeFeeRequired, uint256 _disputePeriod, uint256 _requestId, uint256 _granularity)
        public
        Optimistic(_tellorContract, _disputeFeeRequired, _disputePeriod, _requestId, _granularity)
    {}

    /**
    * @dev creates a start(now) and end time(now + duration specified) for testing a contract start and end period
    * @param _duration in seconds
    */
    function setContractDetails(uint256 _duration) external {
        startDateTime = now - (now % granularity);
        endDateTime = now - (now % granularity) + _duration;
    }

    /**
    * @dev testing function that settles the contract by getting the first undisputed value after the startDateTime
    * and the first undisputed value after the end time of the contract and settleling(payin off) it.
    */
    function settleContracts() external {
        bool _didGet;
        uint256 _time;
        (_didGet, startValue, _time) = getFirstUndisputedValueAfter(startDateTime);
        if (_didGet) {
            (_didGet, endValue, _time) = getFirstUndisputedValueAfter(endDateTime);
            if (_didGet) {
                if (endValue > startValue) {
                    longWins = true;
                }
                contractEnded = true;
                emit ContractSettled(startValue, endValue);
            }
        }
    }
}
