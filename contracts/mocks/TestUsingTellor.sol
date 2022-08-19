// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "../UsingTellor.sol";

contract TestUsingTellor is UsingTellor {
    
    constructor(address payable _tellor) UsingTellor(_tellor) {}
    
    function sliceUint(bytes memory _b) public pure returns (uint256) {
        return _sliceUint(_b);
    }
}