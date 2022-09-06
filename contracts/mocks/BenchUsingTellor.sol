// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import "./TestUsingTellor.sol";

/**
* @title UserContract
* This contract inherits UsingTellor for simulating user interaction
*/
contract BenchUsingTellor is TestUsingTellor{

    constructor(address payable _tellor) TestUsingTellor(_tellor) {}
}
