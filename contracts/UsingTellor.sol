// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "./interface/ITellor.sol";

/**
 @author Tellor Inc
 @title UsingTellor
 @dev This contract helps smart contracts read data from Tellor
 */
contract UsingTellor{
    ITellor public tellor;

    /*Constructor*/
    /**
     * @dev the constructor sets the oracle address in storage
     * @param _tellor is the Tellor Oracle address
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
    function _getDataAfter(bytes32 _queryId, uint256 _timestamp)
        internal
        view
        returns (bytes memory _value, uint256 _timestampRetrieved)
    {
        (bool _found, uint256 _index) = _getIndexForDataAfter(
            _queryId,
            _timestamp
        );
        if (!_found) {
            return ("", 0);
        }
        _timestampRetrieved = _getTimestampbyQueryIdandIndex(_queryId, _index);
        _value = _retrieveData(_queryId, _timestampRetrieved);
        return (_value, _timestampRetrieved);
    }

    /**
     * @dev Retrieves the latest value for the queryId before the specified timestamp
     * @param _queryId is the queryId to look up the value for
     * @param _timestamp before which to search for latest value
     * @return _value the value retrieved
     * @return _timestampRetrieved the value's timestamp
     */
    function _getDataBefore(bytes32 _queryId, uint256 _timestamp)
        internal
        view
        returns (bytes memory _value, uint256 _timestampRetrieved)
    {
        (, _value, _timestampRetrieved) = tellor.getDataBefore(
            _queryId,
            _timestamp
        );
    }

    /**
     * @dev Retrieves latest array index of data before the specified timestamp for the queryId
     * @param _queryId is the queryId to look up the index for
     * @param _timestamp is the timestamp before which to search for the latest index
     * @return _found whether the index was found
     * @return _index the latest index found before the specified timestamp
     */
    // slither-disable-next-line calls-loop
    function _getIndexForDataAfter(bytes32 _queryId, uint256 _timestamp)
        internal
        view
        returns (bool _found, uint256 _index)
    {
        uint256 _count = _getNewValueCountbyQueryId(_queryId);
        if (_count == 0) return (false, 0);
        _count--;
        bool _search = true; // perform binary search
        uint256 _middle = 0;
        uint256 _start = 0;
        uint256 _end = _count;
        uint256 _timestampRetrieved;
        // checking boundaries to short-circuit the algorithm
        _timestampRetrieved = _getTimestampbyQueryIdandIndex(_queryId, _end);
        if (_timestampRetrieved <= _timestamp) return (false, 0);
        _timestampRetrieved = _getTimestampbyQueryIdandIndex(_queryId, _start);
        if (_timestampRetrieved > _timestamp) {
            // candidate found, check for disputes
            _search = false;
        }
        // since the value is within our boundaries, do a binary search
        while (_search) {
            _middle = (_end + _start) / 2;
            _timestampRetrieved = _getTimestampbyQueryIdandIndex(
                _queryId,
                _middle
            );
            if (_timestampRetrieved > _timestamp) {
                // get immediate previous value
                uint256 _prevTime = _getTimestampbyQueryIdandIndex(
                    _queryId,
                    _middle - 1
                );
                if (_prevTime <= _timestamp) {
                    // candidate found, check for disputes
                    _search = false;
                } else {
                    // look from start to middle -1(prev value)
                    _end = _middle - 1;
                }
            } else {
                // get immediate next value
                uint256 _nextTime = _getTimestampbyQueryIdandIndex(
                    _queryId,
                    _middle + 1
                );
                if (_nextTime > _timestamp) {
                    // candidate found, check for disputes
                    _search = false;
                    _middle++;
                    _timestampRetrieved = _nextTime;
                } else {
                    // look from middle + 1(next value) to end
                    _start = _middle + 1;
                }
            }
        }
        // candidate found, check for disputed values
        if (!_isInDispute(_queryId, _timestampRetrieved)) {
            // _timestampRetrieved is correct
            return (true, _middle);
        } else {
            // iterate forward until we find a non-disputed value
            while (
                _isInDispute(_queryId, _timestampRetrieved) && _middle < _count
            ) {
                _middle++;
                _timestampRetrieved = _getTimestampbyQueryIdandIndex(
                    _queryId,
                    _middle
                );
            }
            if (
                _middle == _count && _isInDispute(_queryId, _timestampRetrieved)
            ) {
                return (false, 0);
            }
            // _timestampRetrieved is correct
            return (true, _middle);
        }
    }

    /**
     * @dev Retrieves latest array index of data before the specified timestamp for the queryId
     * @param _queryId is the queryId to look up the index for
     * @param _timestamp is the timestamp before which to search for the latest index
     * @return _found whether the index was found
     * @return _index the latest index found before the specified timestamp
     */
    // slither-disable-next-line calls-loop
    function _getIndexForDataBefore(bytes32 _queryId, uint256 _timestamp)
        internal
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
    function _getMultipleValuesBefore(
        bytes32 _queryId,
        uint256 _timestamp,
        uint256 _maxAge,
        uint256 _maxCount
    )
        internal
        view
        returns (bytes[] memory _values, uint256[] memory _timestamps)
    {
        // get index of first possible value
        (bool _ifRetrieve, uint256 _startIndex) = _getIndexForDataAfter(
            _queryId,
            _timestamp - _maxAge
        );
        // no value within range
        if (!_ifRetrieve) {
            return (new bytes[](0), new uint256[](0));
        }
        uint256 _endIndex;
        // get index of last possible value
        (_ifRetrieve, _endIndex) = _getIndexForDataBefore(_queryId, _timestamp);
        // no value before _timestamp
        if (!_ifRetrieve) {
            return (new bytes[](0), new uint256[](0));
        }
        uint256 _valCount = 0;
        uint256 _index = 0;
        uint256[] memory _timestampsArrayTemp = new uint256[](_maxCount);
        // generate array of non-disputed timestamps within range
        while (_valCount < _maxCount && _endIndex + 1 - _index > _startIndex) {
            uint256 _timestampRetrieved = _getTimestampbyQueryIdandIndex(
                _queryId,
                _endIndex - _index
            );
            if (!_isInDispute(_queryId, _timestampRetrieved)) {
                _timestampsArrayTemp[_valCount] = _timestampRetrieved;
                _valCount++;
            }
            _index++;
        }

        bytes[] memory _valuesArray = new bytes[](_valCount);
        uint256[] memory _timestampsArray = new uint256[](_valCount);
        // retrieve values and reverse timestamps order
        for (uint256 _i = 0; _i < _valCount; _i++) {
            _timestampsArray[_i] = _timestampsArrayTemp[_valCount - 1 - _i];
            _valuesArray[_i] = _retrieveData(_queryId, _timestampsArray[_i]);
        }
        return (_valuesArray, _timestampsArray);
    }

    /**
     * @dev Counts the number of values that have been submitted for the queryId
     * @param _queryId the id to look up
     * @return uint256 count of the number of values received for the queryId
     */
    function _getNewValueCountbyQueryId(bytes32 _queryId)
        internal
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
    function _getReporterByTimestamp(bytes32 _queryId, uint256 _timestamp)
        internal
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
    function _getTimestampbyQueryIdandIndex(bytes32 _queryId, uint256 _index)
        internal
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
    function _isInDispute(bytes32 _queryId, uint256 _timestamp)
        internal
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
    function  _retrieveData(bytes32 _queryId, uint256 _timestamp)
        internal
        view
        returns (bytes memory)
    {
        return tellor.retrieveData(_queryId, _timestamp);
    }
}
