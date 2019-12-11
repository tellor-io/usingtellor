pragma solidity ^0.5.0;

/*
 * @title Price/numberic Pull Oracle mapping contract
*/

contract OracleIDDescriptions {

/*Variables*/
mapping(bytes32 =>string) bytesToString;
mapping(string=>bytes32) stringToBytes;

//should status enum be defined here too?

/*Events*/
event NewIDAdded(bytes32 _id, string _description);
event newhash(bytes32 _hash);
event newString(string _string);

/*Functions*/
//whitelist function for adding or open?

function defineBytes32ID (string memory description, uint256 granularity) 
public 
returns(bytes32 _id)
{
    require(granularity > 0, "Too few decimal places");
    string memory _description = description;
	_id = keccak256(abi.encodePacked(_description, granularity));
    emit newhash(_id);
    //_id = keccak256(_description)];
    string memory _desc = string(abi.encodePacked(_description, _id));
    emit newString(_desc);
    bytesToString[_id] = _desc;
    stringToBytes[_description]= _id;
    emit NewIDAdded(_id, _description);
    return(_id);
}


function whatIsIdDescription (bytes32 _id) 
public
view
returns(string memory _description) 
{
   _description = bytesToString[_id];
   return(_description);
}


function whatIsStringID (string memory description, uint granularity) 
public 
view
returns(bytes32 _id)
{
    require(granularity > 0, "Too few decimal places");
    string memory _description = description;
    string memory _desc = string(abi.encodePacked(_description, granularity));
    
    _id = stringToBytes[_desc];
    return(_id);
}

}