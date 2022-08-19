// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "./interface/ITellor.sol";
import "./interface/IERC2362.sol";
import "./interface/IMappingContract.sol";
import "hardhat/console.sol";

/**
 @author Tellor Inc
 @title UsingTellor
 @dev This contract helps smart contracts read data from Tellor
 */
contract UsingTellor is IERC2362 {
    ITellor public tellor;
    IMappingContract public idMappingContract;

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
     * @dev Retrieves the next value for the queryId after the specified timestamp
     * @param _queryId is the queryId to look up the value for
     * @param _timestamp after which to search for next value
     * @return _value the value retrieved
     * @return _timestampRetrieved the value's timestamp
     */
    function getDataAfter(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bytes memory _value, uint256 _timestampRetrieved)
    {
        (bool _found, uint256 _index) = getIndexForDataAfter(
            _queryId,
            _timestamp
        );
        if (!_found) {
            return ("", 0);
        }
        _timestampRetrieved = getTimestampbyQueryIdandIndex(_queryId, _index);
        _value = retrieveData(_queryId, _timestampRetrieved);
        return (_value, _timestampRetrieved);
    }

    /**
     * @dev Retrieves the latest value for the queryId before the specified timestamp
     * @param _queryId is the queryId to look up the value for
     * @param _timestamp before which to search for latest value
     * @return _value the value retrieved
     * @return _timestampRetrieved the value's timestamp
     */
    function getDataBefore(bytes32 _queryId, uint256 _timestamp)
        public
        view
        returns (bytes memory _value, uint256 _timestampRetrieved)
    {
        (, _value, _timestampRetrieved) = tellor.getDataBefore(
            _queryId,
            _timestamp
        );
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
        returns (bool _found, uint256 _index)
    {
        (_found, _index) = tellor.getIndexForDataBefore(_queryId, _timestamp);
        if (_found) {
            _index++;
        }
        uint256 _valCount = tellor.getNewValueCountbyQueryId(_queryId);
        // no value after timestamp
        if (_valCount <= _index) {
            return (false, 0);
        }
        uint256 _timestampRetrieved = tellor.getTimestampbyQueryIdandIndex(
            _queryId,
            _index
        );
        if (_timestampRetrieved > _timestamp) {
            return (true, _index);
        }
        // if _timestampRetrieved equals _timestamp, try next value
        _index++;
        // no value after timestamp
        if (_valCount <= _index) {
            return (false, 0);
        }
        _timestampRetrieved = tellor.getTimestampbyQueryIdandIndex(
            _queryId,
            _index
        );
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

    /**
     * @dev Retrieves multiple uint256 values before the specified timestamp
     * @param _queryId the unique id of the data query
     * @param _timestamp the timestamp before which to search for values
     * @param _maxAge the maximum number of seconds before the _timestamp to search for values
     * @param _maxCount the maximum number of values to return
     * @return _values the values retrieved, ordered from oldest to newest
     * @return _timestamps the timestamps of the values retrieved
     */
    function getMultipleValuesBefore(
        bytes32 _queryId,
        uint256 _timestamp,
        uint256 _maxAge,
        uint256 _maxCount
    )
        public
        view
        returns (bytes[] memory _values, uint256[] memory _timestamps)
    {
        (bool _ifRetrieve, uint256 _startIndex) = getIndexForDataAfter(
            _queryId,
            _timestamp - _maxAge
        );
        // no value within range
        if (!_ifRetrieve) {
            return (new bytes[](0), new uint256[](0));
        }
        uint256 _endIndex;
        (_ifRetrieve, _endIndex) = getIndexForDataBefore(_queryId, _timestamp);
        // no value before _timestamp
        if (!_ifRetrieve) {
            return (new bytes[](0), new uint256[](0));
        }
        uint256 _valCount = _endIndex - _startIndex + 1;
        // more than _maxCount values found within range
        if (_valCount > _maxCount) {
            _startIndex = _endIndex - _maxCount + 1;
            _valCount = _maxCount;
        }
        bytes[] memory _valuesArray = new bytes[](_valCount);
        uint256[] memory _timestampsArray = new uint256[](_valCount);
        bytes memory _valueRetrieved;
        for (uint256 _i = 0; _i < _valCount; _i++) {
            _timestampsArray[_i] = getTimestampbyQueryIdandIndex(
                _queryId,
                (_startIndex + _i)
            );
            _valueRetrieved = retrieveData(_queryId, _timestampsArray[_i]);
            _valuesArray[_i] = _valueRetrieved;
        }
        return (_valuesArray, _timestampsArray);
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

    /**
     * @dev Gets the timestamp for the value based on their index
     * @param _queryId is the id to look up
     * @param _index is the value index to look up
     * @return uint256 timestamp
     */
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
     * @dev allows dev to set mapping contract for valueFor (EIP2362)
     * @param _addy address of mapping contract
     */
     function setIdMappingContract(address _addy) external{
         require(address(idMappingContract) == address(0));
         idMappingContract = IMappingContract(_addy); 
     }

    /**
     * @dev Retrieve most recent int256 value from oracle based on queryId
     * @param _id being requested
     * @return _value most recent value submitted
     * @return _timestamp timestamp of most recent value
     * @return _statusCode 200 if value found, 404 if not found
     */
    function valueFor(bytes32 _id)
        external
        view
        override
        returns (
            int256 _value,
            uint256 _timestamp,
            uint256 _statusCode
        )
    {
        _id = idMappingContract.getTellorID(_id);
        uint256 _count = getNewValueCountbyQueryId(_id);
        if (_count == 0) {
            return (0, 0, 404);
        }
        _timestamp = getTimestampbyQueryIdandIndex(_id, _count - 1);
        bytes memory _valueBytes = retrieveData(_id, _timestamp);
        if (_valueBytes.length == 0) {
            return (0, 0, 404);
        }
        uint256 _valueUint = _bytesToUint(_valueBytes);
        _value = int256(_valueUint);
        return (_value, _timestamp, 200);
    }

    // Internal functions
    /**
     * @dev Convert bytes to uint256
     * @param _b bytes value to convert to uint256
     * @return _number uint256 converted from bytes
     */
    function _bytesToUint(bytes memory _b) internal pure returns(uint256 _number){
        for (uint256 _i = 0; _i < _b.length; _i++) {
            _number = _number * 256 + uint8(_b[_i]);
        }
    }
}
