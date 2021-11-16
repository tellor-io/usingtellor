// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "./interface/ITellor.sol";

/**
 * @title UserContract
 * This contracts creates for easy integration to the Tellor System
 * by allowing smart contracts to read data off Tellor
 */
contract UsingTellor {
    ITellor private tellor;

    /*Constructor*/
    /**
     * @dev the constructor sets the storage address and owner
     * @param _tellor is the TellorMaster address
     */
    constructor(address payable _tellor) {
        tellor = ITellor(_tellor);
    }

    /**
     * @dev Retreive value from oracle based on queryId/timestamp
     * @param _queryId being requested
     * @param _timestamp to retreive data/value from
     * @return bytes value for query/timestamp submitted
     */
    function retrieveData(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns(bytes memory)
    {
        return tellor.retrieveData(_queryId, _timestamp);
    }

    /**
     * @dev Counts the number of values that have been submited for the queryId
     * @param _queryId the id to look up
     * @return uint256 count of the number of values received for the queryId
     */
    function getNewValueCountbyQueryId(bytes32 _queryId)
        public
        view
        returns (uint256)
    {
        return tellor.getNewValueCountbyQueryId(_queryId);
    }

    // /**
    //  * @dev Gets the timestamp for the value based on their index
    //  * @param _queryId is the id to look up
    //  * @param _index is the value index to look up
    //  * @return uint256 timestamp
    //  */
    function getTimestampbyQueryIdandIndex(bytes32 _queryId, uint256 _index)
        public
        view
        returns (uint256)
    {
        return tellor.getTimestampbyQueryIdandIndex(_queryId, _index);
    }

    /**
     * @dev Allows the user to get the latest value for the queryId specified
     * @param _queryId is the id to look up the value for
     * @return ifRetrieve bool true if it is able to retreive a value, the value, and the value's timestamp
     * @return value the value retrieved
     * @return _timestampRetrieved the value's timestamp
     */
    function getCurrentValue(bytes32 _queryId)
        public
        view
        returns (
            bool ifRetrieve,
            bytes memory value,
            uint256 _timestampRetrieved
        )
    {
        uint256 _count = tellor.getNewValueCountbyQueryId(_queryId);
        uint256 _time =
            tellor.getTimestampbyQueryIdandIndex(_queryId, _count - 1);
        bytes memory _value = tellor.retrieveData(_queryId, _time);
        if (keccak256(_value) != keccak256(bytes(""))) return (true, _value, _time);
        return (false, bytes(""), _time);
    }

    /**
     * @dev Retrieves index of data for a given ID before a given timestamp
     * @param _queryId is the id to look up an index for
     * @param _timestamp is the timestamp
     * @return found whether the index was found
     * @return index the index
     */
    function getIndexForDataBefore(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bool found, uint256 index)
    {
        uint256 _count = tellor.getNewValueCountbyQueryId(_queryId);
        if (_count > 0) {
            uint256 middle;
            uint256 start = 0;
            uint256 end = _count - 1;
            uint256 _time;

            //Checking Boundaries to short-circuit the algorithm
            _time = tellor.getTimestampbyQueryIdandIndex(_queryId, start);
            if (_time >= _timestamp) return (false, 0);
            _time = tellor.getTimestampbyQueryIdandIndex(_queryId, end);
            if (_time < _timestamp) return (true, end);

            //Since the value is within our boundaries, do a binary search
            while (true) {
                middle = (end - start) / 2 + 1 + start;
                _time = tellor.getTimestampbyQueryIdandIndex(
                    _queryId,
                    middle
                );
                if (_time < _timestamp) {
                    //get imeadiate next value
                    uint256 _nextTime =
                        tellor.getTimestampbyQueryIdandIndex(
                            _queryId,
                            middle + 1
                        );
                    if (_nextTime >= _timestamp) {
                        //_time is correct
                        return (true, middle);
                    } else {
                        //look from middle + 1(next value) to end
                        start = middle + 1;
                    }
                } else {
                    uint256 _prevTime =
                        tellor.getTimestampbyQueryIdandIndex(
                            _queryId,
                            middle - 1
                        );
                    if (_prevTime < _timestamp) {
                        // _prevtime is correct
                        return (true, middle - 1);
                    } else {
                        //look from start to middle -1(prev value)
                        end = middle - 1;
                    }
                }
                //We couldn't found a value
                //if(middle - 1 == start || middle == _count) return (false, 0);
            }
        }
        return (false, 0);
    }


    /**
     * @dev Allows the user to get the first value for the requestId before the specified timestamp
     * @param _queryId is the requestId to look up the value for
     * @param _timestamp before which to search for first verified value
     * @return _ifRetrieve bool true if it is able to retreive a value, the value, and the value's timestamp
     * @return _value the value retrieved
     * @return _timestampRetrieved the value's timestamp
     */
    function getDataBefore(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (
            bool _ifRetrieve,
            bytes memory _value,
            uint256 _timestampRetrieved
        )
    {
        (bool _found, uint256 _index) =
            getIndexForDataBefore(_queryId, _timestamp);
        if (!_found) return (false, bytes(''), 0);
        uint256 _time =
            tellor.getTimestampbyQueryIdandIndex(_queryId, _index);
        _value = tellor.retrieveData(_queryId, _time);
        //If value is diputed it'll return zero
        if (keccak256(_value) != keccak256(bytes(''))) return (true, _value, _time);
        return (false, bytes(''), 0);
    }
}
