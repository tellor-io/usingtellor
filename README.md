<p align="center">
  <a href='https://twitter.com/WeAreTellor'>
    <img src= 'https://img.shields.io/twitter/url/http/shields.io.svg?style=social' alt='Twitter WeAreTellor' />
  </a> 
</p>


# Overview

Use this package to install the Tellor User Contracts to test the implementation of Tellor in your contracts.

Once installed this will allow your contracts to inherit the functions from the Tellor UserTellor. 


#### How to Use
Just Inherit the UsingTellor contract, passing the Tellor address as a constructor argument: 

Here's an example
```solidity 
contract BtcPriceContract is UsingTellor {

  //This Contract now have access to all functions on UsingTellor

  uint256 btcPrice;
  uint256 btcRequestId = 2;

  constructor(address payable _tellorAddress) UsingTellor(_tellorAddress) public {}

  function setBtcPrice() public {
    bool _didGet;
    uint _timestamp;
    uint _value;

    (_didGet, btcPrice, _timestamp) = getCurrentValue(btcRequestId);
  }
}
```
##### Addresses:

Mainnet: [`0x0Ba45A8b5d5575935B8158a88C631E9F9C95a2e5`](https://etherscan.io/address/0x0Ba45A8b5d5575935B8158a88C631E9F9C95a2e5)

Rinkeby: [`0x20374E579832859f180536A69093A126Db1c8aE9`](https://rinkeby.etherscan.io/address/0x20374E579832859f180536A69093A126Db1c8aE9#code)

Kovan: [`0x20374E579832859f180536A69093A126Db1c8aE9`](https://kovan.etherscan.io/address/0x20374E579832859f180536A69093A126Db1c8aE9#code)

Ropsten: [`0x20374E579832859f180536A69093A126Db1c8aE9`](https://ropsten.etherscan.io/address/0x20374E579832859f180536A69093A126Db1c8aE9#code)

Goerli: [`0x20374E579832859f180536A69093A126Db1c8aE9`](https://goerli.etherscan.io/address/0x20374E579832859f180536A69093A126Db1c8aE9#code)


#### Available Tellor functions:

Children contracts have access to the following functions:

```solidity
    /**
    * @dev Retreive value from oracle based on requestId/timestamp
    * @param _requestId being requested
    * @param _timestamp to retreive data/value from
    * @return uint value for requestId/timestamp submitted
    */
    function retrieveData(uint256 _requestId, uint256 _timestamp) public view returns(uint256);

    /**
    * @dev Gets if the mined value for the specified requestId/_timestamp is currently under dispute
    * @param _requestId to looku p
    * @param _timestamp is the timestamp to look up miners for
    * @return bool true if requestId/timestamp is under dispute
    */
    function isInDispute(uint256 _requestId, uint256 _timestamp) public view returns(bool);

    /**
    * @dev Counts the number of values that have been submited for the request
    * @param _requestId the requestId to look up
    * @return uint count of the number of values received for the requestId
    */
    function getNewValueCountbyRequestId(uint256 _requestId) public view returns(uint);

    /**
    * @dev Gets the timestamp for the value based on their index
    * @param _requestId is the requestId to look up
    * @param _index is the value index to look up
    * @return uint timestamp
    */
    function getTimestampbyRequestIDandIndex(uint256 _requestId, uint256 _index) public view returns(uint256);

    /**
    * @dev Allows the user to get the latest value for the requestId specified
    * @param _requestId is the requestId to look up the value for
    * @return bool true if it is able to retreive a value, the value, and the value's timestamp
    */
    function getCurrentValue(uint256 _requestId) public view returns (bool ifRetrieve, uint256 value, uint256 _timestampRetrieved);

    /**
    * @dev Allows the user to get the first value for the requestId before the specified timestamp
    * @param _requestId is the requestId to look up the value for
    * @param _timestamp before which to search for first verified value
    * @return bool true if it is able to retreive a value, the value, and the value's timestamp
    */
    function getDataBefore(uint256 _requestId, uint256 _timestamp)
        public
        view
        returns (bool _ifRetrieve, uint256 _value, uint256 _timestampRetrieved);

```


#### Tellor Playground:

For ease of use, the  `UsingTellor`  repo comes with a version of [Tellor Playground](https://github.com/tellor-io/TellorPlayground) system for easier integration. This version contains a few helper functions:

```solidity
   /**
    * @dev A mock function to submit a value to be read withoun miners needed
    * @param _requestId The tellorId to associate the value to
    * @param _value the value for the requestId
    */
    function submitValue(uint256 _requestId,uint256 _value) external;

    /**
    * @dev A mock function to create a dispute
    * @param _requestId The tellorId to be disputed
    * @param _timestamp the timestamp that indentifies for the value
    */
    function disputeValue(uint256 _requestId, uint256 _timestamp) external;

     /**
    * @dev Retreive value from oracle based on requestId/timestamp
    * @param _requestId being requested
    * @param _timestamp to retreive data/value from
    * @return uint value for requestId/timestamp submitted
    */
    function retrieveData(uint256 _requestId, uint256 _timestamp) public view returns(uint256);

    /**
    * @dev Gets if the mined value for the specified requestId/_timestamp is currently under dispute
    * @param _requestId to looku p
    * @param _timestamp is the timestamp to look up miners for
    * @return bool true if requestId/timestamp is under dispute
    */
    function isInDispute(uint256 _requestId, uint256 _timestamp) public view returns(bool);

    /**
    * @dev Counts the number of values that have been submited for the request
    * @param _requestId the requestId to look up
    * @return uint count of the number of values received for the requestId
    */
    function getNewValueCountbyRequestId(uint256 _requestId) public view returns(uint);

    /**
    * @dev Gets the timestamp for the value based on their index
    * @param _requestId is the requestId to look up
    * @param index is the value index to look up
    * @return uint timestamp
    */
    function getTimestampbyRequestIDandIndex(uint256 _requestId, uint256 index) public view returns(uint256);

    /**
    * @dev Adds a tip to a given request Id.
    * @param _requestId is the requestId to look up
    * @param _amount is the amount of tips
    */
    function addTip(uint256 _requestId, uint256 _amount) external;

```

# Test
Open two Git Bash terminals. 

On one terminal run this code: 
```bash
ganache-cli
```

On the second terminal run this code:
```bash
clone https://github.com/tellor-io/usingtellor
npm install
truffle compile
truffle test
```

# Implementing using Tellor
See our documentation for implementing usingTellor here: 
[https://docs.tellor.io/tellor/integration/introduction](https://docs.tellor.io/tellor/integration/introduction)

# Keywords

Decentralized oracle, price oracle, oracle, Tellor, TRB, Tributes, price data, smart contracts.
