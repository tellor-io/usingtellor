pragma solidity ^0.5.0;

import "./UsingTellor.sol";

/**
* @title Optimistic
* This contracts allows users to use Tellor as a fallback oracle. It allows two parties to centrally 
* enter the data used to settle a contract but allows either party to dispute the data. If a dispute is
* initiated their contract will settle to Tellor's value.  
*/
contract Optimistic is UsingTellor {
    mapping(uint256 => bool) public isValue; //mapping for timestamp to bool where it's true if the value as been set
    mapping(uint256 => uint256) valuesByTimestamp; //mapping of timestamp to value
    mapping(uint256 => bool) public disputedValues; //maping of timestamp to bool where it's true if the value has been disputed

    uint256[] timestamps; //timestamps with values
    uint256 requestId;
    uint256[] disputedValuesArray;
    uint256 public granularity;
    uint256 public disputeFee; //In ETH
    uint256 public disputePeriod;
    address payable owner;//where the disputeFees get paid (that's it)

    event NewValueSet(uint256 indexed _timestamp, uint256 _value);
    event ValueDisputed(address _disputer, uint256 _timestamp, uint256 _value);
    event TellorValuePlaced(uint256 _timestamp, uint256 _value);

    /*Constructor*/
    /**
    * @dev This constructor function is used to pass variables to the UserContract's constructor and set several variables
    * the variables for the Optimistic.sol constructor come for the Reader.Constructor function.
    * @param _tellorContract address for UserContract
    * @param _disputeFeeRequired the fee to dispute the optimistic price(price sumbitted by known trusted party)
    * @param _disputePeriod is the time frame a value can be disputed after being imputed
    * @param _requestId is the requestId on the Tellor System corresponding to the data type used on this contract.
    * @param _granularity is the amount of decimals desired on the requested value
    */
    constructor(address payable _tellorContract, uint256 _disputeFeeRequired, uint256 _disputePeriod, uint256 _requestId, uint256 _granularity)
        public
        UsingTellor(_tellorContract)
    {
        disputeFee = _disputeFeeRequired;
        disputePeriod = _disputePeriod;
        granularity = _granularity;
        requestId = _requestId;
        owner = msg.sender;
    }

    /*Functions*/
    function transferOwnership(address payable _newOwner) external {
        require(msg.sender == owner, "Sender is not owner");
        owner = _newOwner;
    }

    /**
    * @dev allows contract owner, a centralized party to enter value
    * @param _timestamp is the timestamp for the value
    * @param _value is the value for the timestamp specified
    */
    function setValue(uint256 _timestamp, uint256 _value) external {
        require(msg.sender == owner, "Sender is not owner");
        require(getIsValue(_timestamp) == false, "Timestamp is already set");
        //sets timestamp
        valuesByTimestamp[_timestamp] = _value;
        //sets isValue to true once value is set
        isValue[_timestamp] = true;
        //adds timestamp to the timestamps array
        timestamps.push(_timestamp);
        //lets the network know a new timestamp and value have been added
        emit NewValueSet(_timestamp, _value);
    }

    /**
    * @dev allows user to initiate dispute on the value of the specified timestamp
    * @param _timestamp is the timestamp for the value to be disputed
    */
    function disputeOptimisticValue(uint256 _timestamp) external payable {
        require(msg.value >= disputeFee, "Value is below dispute fee");
        address(owner).transfer(msg.value);
        //require that isValue for the timestamp being disputed to exist/be true
        require(isValue[_timestamp], "Value for the timestamp being disputed doesn't exist");
        // assert disputePeriod is still open
        require(now - (now % granularity) <= _timestamp + disputePeriod, "Dispute period is closed");
        //set the disputValues for the disputed timestamp to true
        disputedValues[_timestamp] = true;
        //add the disputed timestamp to the diputedValues array
        disputedValuesArray.push(_timestamp);
        emit ValueDisputed(msg.sender, _timestamp, valuesByTimestamp[_timestamp]);
    }

    /**
    * @dev This function gets the Tellor requestIds values for the disputed timestamp.
    * @param _timestamp to get Tellor data from
    * @return uint of new value and true if it was able to get Tellor data
    */
    function getTellorValues(uint256 _timestamp) public returns (uint256 _value, bool _didGet) {
        uint256 _retrievedTimestamp;
        //Check if any is after your given timestamp
        (_didGet, _value, _retrievedTimestamp) = getDataAfter(requestId, _timestamp);
        if (_didGet) {
            uint256 _newTime = _retrievedTimestamp - (_retrievedTimestamp % granularity); //why are we using the mod granularity???
            //provides the average of the requests Ids' associated with this price feed
            valuesByTimestamp[_newTime] = _value;
            emit TellorValuePlaced(_newTime, _value);
            //if the value for the newTime does not exist, then push the value, update the isValue to true
            //otherwise if the newTime is under dsipute then update the dispute status to false
            if (isValue[_newTime] == false) {
                timestamps.push(_newTime);
                isValue[_newTime] = true;
                emit NewValueSet(_newTime, _value);
            } else if (disputedValues[_newTime] == true) {
                disputedValues[_newTime] = false;
            }
        }
    }

    /**
    * @dev Get the first undisputed value after the timestamp specified.
    * @param _timestamp to search the first undisputed value there after
    */
    function getFirstUndisputedValueAfter(uint256 _timestamp) public view returns (bool, uint256, uint256 _timestampRetrieved) {
        uint256 _count = timestamps.length;
        if (_count > 0) {
            for (uint256 i = _count; i > 0; i--) {
                if (timestamps[i - 1] >= _timestamp && disputedValues[timestamps[i - 1]] == false) {
                    _timestampRetrieved = timestamps[i - 1];
                }
            }
            if (_timestampRetrieved > 0) {
                return (true, getMyValuesByTimestamp(_timestampRetrieved), _timestampRetrieved);
            }
        }
        return (false, 0, 0);
    }

    /*Getters*/
    /**
    * @dev Getter function for the value based on the timestamp specified
    * @param _timestamp to retreive value from
    */
    function getMyValuesByTimestamp(uint256 _timestamp) public view returns (uint256 value) {
        return valuesByTimestamp[_timestamp];
    }
    /**
    * @dev Checks to if a value exists for the specifived timestamp
    * @param _timestamp to verify
    * @return ture if it exists
    */
    function getIsValue(uint256 _timestamp) public view returns (bool) {
        return isValue[_timestamp];
    }

    /**
    * @dev Getter function for latest value available
    * @return latest value available
    */
    function getCurrentValue() external view returns (uint256) {
        require(timestamps.length > 0, "Timestamps' length is 0");
        return getMyValuesByTimestamp(timestamps[timestamps.length - 1]);
    }

    /**
    * @dev Getter function for the timestamps available
    * @return uint array of timestamps available
    */
    function getTimestamps() external view returns (uint256[] memory) {
        return timestamps;
    }

   /**
    * @dev Getter function for the number of disputed values
    * @return uint count of number of values for the spedified timestamp
    */
    function getNumberOfDisputedValues() external view returns (uint256) {
        return disputedValuesArray.length;
    }

    /**
    * @dev Getter function for all disputed values
    * @return the array with all values under dispute
    */
    function getDisputedValues() external view returns (uint256[] memory) {
        return disputedValuesArray;
    }

    /**
    * @dev This checks if the value for the specified timestamp is under dispute
    * @param _timestamp to check if it is under dispute
    * @return true if it is under dispute
    */
    function isDisputed(uint256 _timestamp) external view returns (bool) {
        return disputedValues[_timestamp];
    }

    /**
    * @dev Getter function for the dispute value by index
    * @return the value
    */
    function getDisputedValueByIndex(uint256 _index) external view returns (uint256) {
        return disputedValuesArray[_index];
    }
}
