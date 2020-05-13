<p align="center">
  <a href='https://twitter.com/WeAreTellor'>
    <img src= 'https://img.shields.io/twitter/url/http/shields.io.svg?style=social' alt='Twitter WeAreTellor' />
  </a> 
</p>


# Overview

Use this package to install the Tellor User Contracts to test the implementation of Tellor in your contracts.

Once installed this will allow your contracts to inherit the functions from the Tellor UserTellor. 

# Quick Start

STEP 1: Install usingtellor

```bash
  npm install usingtellor
```

STEP 2: Allow your contact to inherit from usingtellor and use the functions within to get data for the corresponding request ID. 

For the tellorContract use the TellorMaster address:
Rinkeby 0xFe41Cb708CD98C5B20423433309E55b53F79134a
Mainnet 0x0Ba45A8b5d5575935B8158a88C631E9F9C95a2e5

For example: 

```javascript
 contract mycontract is usingtellor {
    
    /*Variables*/
    address payable public tellorContract;
    uint public requestId;
    uint public endDate;
    int public outcome;

    /** 
    * @dev Sets the tellor contract
    * @param _tellorContract is the Tellor user contract that should be used by the interface
    */
    constructor(address payable _tellorContract) public {
        require(_tellorContract != address(0), "_usingTelloraddress should not be 0");
        tellorContract = _tellorContract;
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
        (_status,_value,_time) = ADOInterface(tellorContract).valueFor(_bytesId);
        if(_status != 0){
        	outcome = int(_value);
        }
        return(_time, _value, _status);
    }


 }
```


# Keywords

Decentralized oracle, price oracle, oracle, Tellor, TRB, Tributes, price data, smart contracts.
