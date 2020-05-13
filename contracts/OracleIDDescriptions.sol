pragma solidity ^0.5.0;

/*
 * @title Price/numeric Pull Oracle mapping contract
*/

contract OracleIDDescriptions {

    /*Variables*/
    mapping(uint=>bytes32) tellorIDtoBytesID;
    mapping(bytes32 => uint) bytesIDtoTellorID;
    mapping(uint => uint) tellorCodeToStatusCode;
    mapping(uint => uint) statusCodeToTellorCode;
    mapping(uint => int) tellorIdtoAdjFactor;

    /*Events*/
    event TellorIdMappedToBytes(uint _requestID, bytes32 _id);
    event StatusMapped(uint _tellorStatus, uint _status);
    event AdjFactorMapped(uint _requestID, int _adjFactor);


    /**
    * @dev This function allows the user to map the tellor's Id to it's _adjFactor and
    * to match the standarized granularity
    * @param _tellorId uint the tellor status
    * @param _adjFactor is 1eN where N is the number of decimals to convert to ADO standard
    */
    function defineTellorIdtoAdjFactor(uint _tellorId, int _adjFactor) external{
        require(tellorIdtoAdjFactor[_tellorId] == 0, "Already Set");
        tellorIdtoAdjFactor[_tellorId] = _adjFactor;
        emit AdjFactorMapped(_tellorId, _adjFactor);
    }

    /**
    * @dev This function allows the user to map the tellor uint data status code to the standarized 
    * ADO uint status code such as null, retreived etc...
    * @param _tellorStatus uint the tellor status
    * @param _status the ADO standarized uint status
    */
    function defineTellorCodeToStatusCode(uint _tellorStatus, uint _status) external{
        require(tellorCodeToStatusCode[_tellorStatus] == 0, "Already Set");
        tellorCodeToStatusCode[_tellorStatus] = _status;
        statusCodeToTellorCode[_status] = _tellorStatus;
        emit StatusMapped(_tellorStatus, _status);
    }

    /**
    * @dev Allows user to map the standarized bytes32 Id to a specific requestID from Tellor
    * The dev should ensure the _requestId exists otherwise request the data on Tellor to get a requestId
    * @param _requestID is the existing Tellor RequestID 
    * @param _id is the descption of the ID in bytes 
    */ 
    function defineTellorIdToBytesID(uint _requestID, bytes32 _id) external{
        require(tellorIDtoBytesID[_requestID] == bytes32(0), "Already Set");
        tellorIDtoBytesID[_requestID] = _id;
        bytesIDtoTellorID[_id] = _requestID;
        emit TellorIdMappedToBytes(_requestID,_id);
    }

    /**
    * @dev Getter function for the uint Tellor status code from the specified uint ADO standarized status code
    * @param _status the uint ADO standarized status
    * @return _tellorStatus uint 
    */ 
    function getTellorStatusFromStatus(uint _status) public view returns(uint _tellorStatus){
        return statusCodeToTellorCode[_status];
    }

    /**
    * @dev Getter function of the uint ADO standarized status code from the specified Tellor uint status
    * @param _tellorStatus uint 
    * @return _status the uint ADO standarized status
    */ 
    function getStatusFromTellorStatus (uint _tellorStatus) public view returns(uint _status) {
        return tellorCodeToStatusCode[_tellorStatus];
    }
    
    /**
    * @dev Getter function of the Tellor RequestID based on the specified bytes32 ADO standaraized _id
    * @param _id is the bytes32 descriptor mapped to an existing Tellor's requestId
    * @return _requestId is Tellor's requestID corresnpoding to _id
    */ 
    function getTellorIdFromBytes(bytes32 _id) public view  returns(uint _requestId)  {
       return bytesIDtoTellorID[_id];
    }

    /**
    * @dev Getter function of the Tellor RequestID based on the specified bytes32 ADO standaraized _id
    * @param _id is the bytes32 descriptor mapped to an existing Tellor's requestId
    * @return _requestId is Tellor's requestID corresnpoding to _id
    */ 
    function getGranularityAdjFactor(bytes32 _id) public view  returns(int adjFactor)  {
       uint requestID = bytesIDtoTellorID[_id];
       adjFactor = tellorIdtoAdjFactor[requestID];
       return adjFactor;
    }

    /**
    * @dev Getter function of the bytes32 ADO standaraized _id based on the specified Tellor RequestID 
    * @param _requestId is Tellor's requestID
    * @return _id is the bytes32 descriptor mapped to an existing Tellor's requestId
    */ 
    function getBytesFromTellorID(uint _requestId) public view returns(bytes32 _id) {
        return tellorIDtoBytesID[_requestId];
    }

}