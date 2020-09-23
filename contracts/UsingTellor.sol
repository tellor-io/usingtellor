pragma solidity 0.5.16;

import "./MockTellor.sol";

/**
* @title UserContract
* This contracts creates for easy integration to the Tellor System
* by allowing smart contracts to read data off Tellor
*/
contract UsingTellor{
    MockTellor tellor;
    /*Constructor*/
    /**
    * @dev the constructor sets the storage address and owner
    * @param _tellor is the TellorMaster address
    */
    constructor(address payable _tellor) public {
        tellor = MockTellor(_tellor);
    }

     /**
    * @dev Retreive value from oracle based on requestId/timestamp
    * @param _requestId being requested
    * @param _timestamp to retreive data/value from
    * @return uint value for requestId/timestamp submitted
    */
    function retrieveData(uint256 _requestId, uint256 _timestamp) public view returns(uint256){
        return tellor.retrieveData(_requestId,_timestamp);
    }

    /**
    * @dev Gets the 5 miners who mined the value for the specified requestId/_timestamp
    * @param _requestId to looku p
    * @param _timestamp is the timestamp to look up miners for
    * @return bool true if requestId/timestamp is under dispute
    */
    function isInDispute(uint256 _requestId, uint256 _timestamp) public view returns(bool){
        return tellor.isInDispute(_requestId, _timestamp);
    }

    /**
    * @dev Counts the number of values that have been submited for the request
    * @param _requestId the requestId to look up
    * @return uint count of the number of values received for the requestId
    */
    function getNewValueCountbyRequestId(uint256 _requestId) public view returns(uint) {
        return tellor.getNewValueCountbyRequestId(_requestId);
    }

    /**
    * @dev Gets the timestamp for the value based on their index
    * @param _requestId is the requestId to look up
    * @param _index is the value index to look up
    * @return uint timestamp
    */
    function getTimestampbyRequestIDandIndex(uint256 _requestId, uint256 _index) public view returns(uint256) {
        return tellor.getTimestampbyRequestIDandIndex( _requestId,_index);
    }

    /**
    * @dev Allows the user to get the latest value for the requestId specified
    * @param _requestId is the requestId to look up the value for
    * @return bool true if it is able to retreive a value, the value, and the value's timestamp
    */
    function getCurrentValue(uint256 _requestId) public view returns (bool ifRetrieve, uint256 value, uint256 _timestampRetrieved) {
        uint256 _count = tellor.getNewValueCountbyRequestId(_requestId);
        uint _time = tellor.getTimestampbyRequestIDandIndex(_requestId, _count - 1);
        uint _value = tellor.retrieveData(_requestId, _time);
        if(_value > 0) return (true, _value, _time);
        return (false, 0 , _time);
    }
    
    /**
    * @dev Allows the user to get the first value for the requestId before the specified timestamp
    * @param _requestId is the requestId to look up the value for
    * @param _timestamp before which to search for first verified value
    * @param _limit a limit on the number of values to look at
    * @param _offset the number of values to go back before looking for data values
    * @return bool true if it is able to retreive a value, the value, and the value's timestamp
    */
    function getDataBefore(uint256 _requestId, uint256 _timestamp, uint256 _limit, uint256 _offset)
        public
        view
        returns (bool _ifRetrieve, uint256 _value, uint256 _timestampRetrieved)
    {
        uint256 _count = tellor.getNewValueCountbyRequestId(_requestId);
        if (_count > 0) {
            for (uint256 i = _count - _offset; i < _count -_offset + _limit; i++) {
                uint256 _time = tellor.getTimestampbyRequestIDandIndex(_requestId, i - 1);
                if(_value > 0 && _time > _timestamp){
                    return(true, _value, _timestampRetrieved);
                }
                else if (_time > 0 && _time <= _timestamp && tellor.isInDispute(_requestId,_time) == false) {
                    _value = tellor.retrieveData(_requestId, _time);
                    _timestampRetrieved = _time;
                    if(i == _count){
                        return(true, _value, _timestampRetrieved);
                    }
                }
            }
        }
        return (false, 0, 0);
    }
}
