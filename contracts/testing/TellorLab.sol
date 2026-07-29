// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import "../interfaces/ITellorDataBridge.sol";

/**
 * @author Tellor Inc.
 * @title TellorLab
 * @notice Testing contract for rapid prototyping with Tellor oracle data
 * @dev This contract is used to store data for multiple data feeds for testing tellor 
 * data integrations. It has no data bridge validation, zero security checks, and is 
 * NOT for production use. For production contracts, use TellorDataBridge verification. 
 * See SampleLayerUser repo for usage examples: https://github.com/tellor-io/SampleLayerUser
 * This contract conforms to the ITellorDataBank interface.
 */
contract TellorLab {
    // Storage
    mapping(bytes32 => AggregateData[]) public data; // queryId -> array of aggregate data

    struct AggregateData {
        bytes value; // the oracle data value
        uint256 power; // the combined stake power of the data reporters (0 decimals, 100 == 100 TRB tokens)
        uint256 aggregateTimestamp; // the time when the oracle data was aggregated (milliseconds)
        uint256 attestationTimestamp; // the time when the oracle data was signed by validators (milliseconds)
        uint256 relayTimestamp; // the time when the oracle data was stored in this contract (seconds)
    }

    // Events
    event OracleUpdated(
        bytes32 indexed queryId,
        OracleAttestationData attestData
    );

    // Functions
    /**
     * @dev updates oracle data with new attestation data after verification
     * @param _attestData the oracle attestation data to be stored
     * note: _currentValidatorSet array of current validators (unused for testing)
     * note: _sigs array of validator signatures (unused for testing)
     */
    function updateOracleData(
        OracleAttestationData calldata _attestData,
        Validator[] calldata /* _currentValidatorSet */,
        Signature[] calldata /* _sigs */
    ) public {
        // Skips verification for simplified integration testing
        // dataBridge.verifyOracleData(_attestData, _currentValidatorSet, _sigs);

        data[_attestData.queryId].push(
            AggregateData(
                _attestData.report.value,
                _attestData.report.aggregatePower,
                _attestData.report.timestamp,
                _attestData.attestationTimestamp,
                block.timestamp
            )
        );
        emit OracleUpdated(_attestData.queryId, _attestData);
    }

    /**
     * @dev updates lab contract with new oracle data
     * without needing to format data structs
     * @param _queryId the unique identifier for the oracle data
     * @param _value the oracle data value to be stored
     */
    function updateOracleDataLab(
        bytes32 _queryId,
        bytes memory _value
    ) external {
        // aggregate timestamp from tellor is in milliseconds
        uint256 _aggregateTimestamp = (block.timestamp - 1) * 1000;
        data[_queryId].push(
            AggregateData(
                _value,
                0,
                _aggregateTimestamp,
                _aggregateTimestamp,
                block.timestamp
            )
        );
        emit OracleUpdated(
            _queryId,
            OracleAttestationData(
                _queryId,
                ReportData(_value, _aggregateTimestamp, 0, 0, 0, 0),
                _aggregateTimestamp
            )
        );
    }

    // Getter functions
    /**
     * @dev returns the oracle data for a given query ID and index
     * @param _queryId the unique identifier for the oracle data
     * @param _index the index of the oracle data to get
     * @return _aggregateData the oracle data and metadata
     */
    function getAggregateByIndex(
        bytes32 _queryId,
        uint256 _index
    ) external view returns (AggregateData memory _aggregateData) {
        return data[_queryId][_index];
    }

    /**
     * @dev returns the total number of oracle data values for a given query ID
     * @param _queryId the unique identifier for the oracle data
     * @return number the total number of oracle data values stored
     */
    function getAggregateValueCount(
        bytes32 _queryId
    ) external view returns (uint256) {
        return data[_queryId].length;
    }

    /**
     * @dev returns the last submitted oracle data for a given query ID
     * @param _queryId the unique identifier for the oracle data
     * @return _aggregateData the last submitted oracle data and metadata
     */
    function getCurrentAggregateData(
        bytes32 _queryId
    ) external view returns (AggregateData memory _aggregateData) {
        return _getCurrentAggregateData(_queryId);
    }

    // Internal functions
    /**
     * @dev internal function to get the last submitted oracle data for a query ID
     * @param _queryId the unique identifier for the oracle data
     * @return _aggregateData the last submitted oracle data and metadata
     */
    function _getCurrentAggregateData(
        bytes32 _queryId
    ) internal view returns (AggregateData memory _aggregateData) {
        if (data[_queryId].length == 0) {
            return (AggregateData(bytes(""), 0, 0, 0, 0));
        }
        _aggregateData = data[_queryId][data[_queryId].length - 1];
        return _aggregateData;
    }
}
