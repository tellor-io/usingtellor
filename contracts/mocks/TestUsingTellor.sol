// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "../UsingTellor.sol";

contract TestUsingTellor is UsingTellor {
    
    constructor(address payable _oracle, address payable _autopay) UsingTellor(_oracle, _autopay) {}
    
    function sliceUint(bytes memory _b) public pure returns (uint256) {
        return _sliceUint(_b);
    }
}