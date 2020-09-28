pragma solidity 0.5.16;

import "../contracts/UsingTellor.sol";

/**
* @title UserContract
* This contracts creates for easy integration to the Tellor System
* by allowing smart contracts to read data off Tellor
*/
contract BenchUsingTellor is UsingTellor{

    constructor(address payable _tellor) UsingTellor(_tellor) public {

    }
    function wrapper(uint256 _requestId, uint256 _timestamp) public {
        getDataBefore(_requestId, _timestamp);
    }
}
