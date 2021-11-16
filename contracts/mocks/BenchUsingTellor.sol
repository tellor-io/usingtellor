pragma solidity >0.8.0;

import "../UsingTellor.sol";

/**
* @title UserContract
* This contracts creates for easy integration to the Tellor System
* by allowing smart contracts to read data off Tellor
*/
contract BenchUsingTellor is UsingTellor{

    constructor(address payable _tellor) UsingTellor(_tellor) public {}

    function wrapper(bytes32 _queryId, uint256 _timestamp) public {
        getDataBefore(_queryId, _timestamp);
    }
}
