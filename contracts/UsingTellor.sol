// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "./interface/ITellor.sol";
import "./interface/IERC2362.sol";

/**
 * @title UserContract
 * This contract allows for easy integration with the Tellor System
 * by helping smart contracts to read data from Tellor
 */
contract UsingTellor is IERC2362 {
    ITellor public tellor;

    /*Constructor*/
    /**
     * @dev the constructor sets the tellor address in storage
     * @param _tellor is the TellorMaster address
     */
    constructor(address payable _tellor) {
        tellor = ITellor(_tellor);
    }

    /*Getters*/
    /**
     * @dev Retrieves the latest value for the queryId before the specified timestamp
     * @param _queryId is the queryId to look up the value for
     * @param _timestamp before which to search for latest value
     * @return _ifRetrieve bool true if able to retrieve a non-zero value
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
        return tellor.getDataBefore(_queryId, _timestamp);
    }

    /**
     * @dev Retrieves the next value for the queryId after the specified timestamp
     * @param _queryId is the queryId to look up the value for
     * @param _timestamp after which to search for next value
     * @return _ifRetrieve bool true if able to retrieve a non-zero value
     * @return _value the value retrieved
     * @return _timestampRetrieved the value's timestamp
     */
    function getDataAfter(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (
            bool _ifRetrieve,
            bytes memory _value,
            uint256 _timestampRetrieved
        )
    {
        (bool _found, uint256 _index) = getIndexForDataAfter(_queryId, _timestamp);
        if(!_found) {
            return (false, '', 0);
        }
        _timestampRetrieved = getTimestampbyQueryIdandIndex(_queryId, _index);
        _value = retrieveData(_queryId, _index);
        return (true, _value, _timestampRetrieved);
    }

    /**
     * @dev Retrieves next array index of data after the specified timestamp for the queryId
     * @param _queryId is the queryId to look up the index for
     * @param _timestamp is the timestamp after which to search for the next index
     * @return _found whether the index was found
     * @return _index the next index found after the specified timestamp
     */
    function getIndexForDataAfter(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (
            bool _found,
            uint256 _index
        )
    {
        (_found, _index) = getIndexForDataBefore(_queryId, _timestamp);
        if(!_found) {
            return (false, 0);
        }
        _index++;
        uint256 _valCount = getNewValueCountbyQueryId(_queryId);
        // no value after timestamp
        if(_valCount < _index) {
            return (false, 0);
        }
        uint256 _timestampRetrieved = getTimestampbyQueryIdandIndex(_queryId, _index);
        if(_timestampRetrieved > _timestamp) {
            return (true, _index);
        } 
        // if _timestampRetrieved == _timestamp, try next value
        _index++;
        // no value after timestamp
        if(_valCount < _index) {
            return (false, 0);
        }
        _timestampRetrieved = getTimestampbyQueryIdandIndex(_queryId, _index);
        return (true, _index);
    }


    /**
     * @dev Retrieves latest array index of data before the specified timestamp for the queryId
     * @param _queryId is the queryId to look up the index for
     * @param _timestamp is the timestamp before which to search for the latest index
     * @return _found whether the index was found
     * @return _index the latest index found before the specified timestamp
     */
    // slither-disable-next-line calls-loop
    function getIndexForDataBefore(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bool _found, uint256 _index)
    {
        return tellor.getIndexForDataBefore(_queryId, _timestamp);
    }

    function getMultipleValuesBefore(bytes32 _queryId, uint256 _timestamp, uint256 _maxAge, uint256 _maxCount)
        public
        view
        returns (
            uint256[] memory _values,
            uint256[] memory _timestamps
        )
    {
        (bool _ifRetrieve, uint256 _startIndex) = getIndexForDataBefore(_queryId, _timestamp);
        if(!_ifRetrieve) {
            return (new uint256[](0), new uint256[](0));
        }
        
    }

    /**
     * @dev Counts the number of values that have been submitted for the queryId
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

    /**
     * @dev Returns the address of the reporter who submitted a value for a data ID at a specific time
     * @param _queryId is ID of the specific data feed
     * @param _timestamp is the timestamp to find a corresponding reporter for
     * @return address of the reporter who reported the value for the data ID at the given timestamp
     */
    function getReporterByTimestamp(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (address)
    {
        return tellor.getReporterByTimestamp(_queryId, _timestamp);
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
     * @dev Determines whether a value with a given queryId and timestamp has been disputed
     * @param _queryId is the value id to look up
     * @param _timestamp is the timestamp of the value to look up
     * @return bool true if queryId/timestamp is under dispute
     */
    function isInDispute(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bool)
    {
        return tellor.isInDispute(_queryId, _timestamp);
    }

    /**
     * @dev Retrieve value from oracle based on queryId/timestamp
     * @param _queryId being requested
     * @param _timestamp to retrieve data/value from
     * @return bytes value for query/timestamp submitted
     */
    function retrieveData(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bytes memory)
    {
        return tellor.retrieveData(_queryId, _timestamp);  
    }

    /**
     * @dev Retrieve most recent value from oracle based on queryId
     * @param _id being requested
     * @return _value most recent value submitted
     * @return _timestamp timestamp of most recent value
     * @return _statusCode 200 if value found, 404 if not found
     */
    function valueFor(bytes32 _id) external view override returns(int256 _value,uint256 _timestamp,uint256 _statusCode) {
        bool _isERC362Id;
        uint256 _decimalsDividend = 1;
        if(_id == 0xdfaa6f747f0f012e8f2069d6ecacff25f5cdf0258702051747439949737fc0b5) {
            bytes memory _queryData = abi.encode("SpotPrice", abi.encode("eth", "usd"));
            _id = keccak256(_queryData);
            _isERC362Id = true;
            _decimalsDividend = 1e15;
        } else if(_id == 0x637b7efb6b620736c247aaa282f3898914c0bef6c12faff0d3fe9d4bea783020) {
            bytes memory _queryData = abi.encode("SpotPrice", abi.encode("btc", "usd"));
            _id = keccak256(_queryData);
            _isERC362Id = true;
            _decimalsDividend = 1e15;
        } else if(_id == 0x2dfb033e1ae0529b328985942d27f2d5a62213f3a2d97ca8e27ad2864c5af942) {
            bytes memory _queryData = abi.encode("SpotPrice", abi.encode("xau", "usd"));
            _id = keccak256(_queryData);
            _isERC362Id = true;
            _decimalsDividend = 1e15;
        } else if(_id == 0x9899e35601719f1348e09967349f72c7d04800f17c14992d6dcf2f17fac713ea) {
            bytes memory _queryData = abi.encode("SpotPrice", abi.encode("dai", "usd"));
            _id = keccak256(_queryData);
            _isERC362Id = true;
            _decimalsDividend = 1e12;
        }

        uint256 _count = getNewValueCountbyQueryId(_id);
        if (_count == 0) {
            return (0, 0, 404);
        }
        _timestamp = getTimestampbyQueryIdandIndex(_id, _count - 1);
        bytes memory _valueBytes = retrieveData(_id, _timestamp);
        if (_valueBytes.length == 0) {
            return (0, 0, 404);
        }
        uint256 _valueUint = abi.decode(_valueBytes, (uint256));
        _valueUint = _valueUint / _decimalsDividend;
        _value = int256(_valueUint);
        return(_value, _timestamp, 200);
    }
}
