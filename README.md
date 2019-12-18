<p align="center">
  <a href='https://twitter.com/WeAreTellor'>
    <img src= 'https://img.shields.io/twitter/url/http/shields.io.svg?style=social' alt='Twitter WeAreTellor' />
  </a> 
</p>


# Overview

Use this package to install the Tellor User Contracts to test the implementation of Tellor in your contracts.

Once installed this will allow your contracts to inherit the functions from the Tellor UserContract. 

# Quick Start

STEP 1: Install usingtellor

```bash
  npm install usingtellor
```

STEP 2: Allow your contact to inherit from usingtellor and use the functions within to get data for the corresponding request ID. For example: 

```javascript
 contract mycontract is usingtellor {
    
    /*Variables*/
    address payable public userContract;
    uint public requestId;
    uint public endDate;
    int public outcome;

    /** @dev Sets the tellor contract, dispute period, type of data(requestId), end date and dispute cost
    * @param _userContract is the Tellor user contract that should be used by the interface
    */
    constructor(address payable _userContract) public {
        require(_tellorContract != address(0), "_tellorContract address should not be 0");
        userContract = _userContract;
       }

    
    /*Public functions*/
    /**
    * @dev Allows the user to set the outcome to the current value for the _id specified using the ADO specification for the standard inteface for price oracles
    * @param _bytesId is the ADO standarized bytes32 price/key value pair identifier
    * @return the timestamp, outcome or value/ and the status code (for retreived, null, etc...)
    */
    function setPrice(bytes32 _bytesId) public returns(uint, uint, int){
        int _status;
        uint _value;
        uint _time;
        (_status,_value,_time) = ADOInterface(userContract).resultFor(_bytesId);
        if(_status != 0){
        	outcome = int(_value);
        }
        return(_time, _value, _status);
    }


 }
```


# Keywords

Decentralized oracle, price oracle, oracle, Tellor, TRB, Tributes, price data, smart contracts.
