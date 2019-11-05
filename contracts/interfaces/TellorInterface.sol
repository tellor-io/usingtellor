pragma solidity ^0.5.0;

contract TellorInterface {
		function getFirstVerifiedDataAfter(uint _requestId, uint _timestamp) external returns (bool,uint,uint);
}

