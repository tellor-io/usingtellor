pragma solidity ^0.5.0;

/*
@title TellorInterface 
@notice Inteface to get first verified data after a time period for the specifed requestId and date.
*/
contract TellorInterface {
		function getFirstVerifiedDataAfter(uint _requestId, uint _timestamp) external returns (bool,uint,uint);
}

