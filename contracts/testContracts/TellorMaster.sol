pragma solidity ^0.5.0;

/**** TellorMaster Test Contract***/
/*WARNING: This contract is used for the delegate calls to the Test Tellor contract
           wich excludes mining for testing purposes
           This has bee adapted for projects testing Tellor integration

**/
import "./TellorGetters.sol";

/**
* @title Tellor Master
* @dev This is the Master contract with all tellor getter functions and delegate call to Tellor. 
* The logic for the functions on this contract is saved on the TellorGettersLibrary, TellorTransfer, 
* TellorGettersLibrary, and TellorStake
*/
contract TellorMaster is TellorGetters{
    
    event NewTellorAddress(address _newTellor);

    /**
    * @dev The constructor sets the original `tellorStorageOwner` of the contract to the sender
    * account, the tellor contract to the Tellor master address and owner to the Tellor master owner address 
    * @param _tellorContract is the address for the tellor contract
    */
    constructor (address _tellorContract)  public{
        init();
        tellor.addressVars[keccak256("_owner")] = msg.sender;
        tellor.addressVars[keccak256("_deity")] = msg.sender;
        tellor.addressVars[keccak256("tellorContract")]= _tellorContract;
        emit NewTellorAddress(_tellorContract);
    }
    
    /**
    * @dev This function stakes the five initial miners, sets the supply and all the constant variables.
    * This function is called by the constructor function on TellorMaster.sol
    */
    function init() internal {
        require(tellor.uintVars[keccak256("decimals")] == 0);
        //Give this contract 6000 Tellor Tributes so that it can stake the initial 6 miners
        TellorTransfer.updateBalanceAtNow(tellor.balances[address(this)], 2**256-1 - 6000e18);

        // //the initial 5 miner addresses are specfied below
        // //changed payable[5] to 6
        address payable[6] memory _initalMiners = [address(0xE037EC8EC9ec423826750853899394dE7F024fee),
        address(0xcdd8FA31AF8475574B8909F135d510579a8087d3),
        address(0xb9dD5AfD86547Df817DA2d0Fb89334A6F8eDd891),
        address(0x230570cD052f40E14C14a81038c6f3aa685d712B),
        address(0x3233afA02644CCd048587F8ba6e99b3C00A34DcC),
        address(0xe010aC6e0248790e08F42d5F697160DEDf97E024)];
        //Stake each of the 5 miners specified above
        for(uint i=0;i<6;i++){//6th miner to allow for dispute
            //Miner balance is set at 1000e18 at the block that this function is ran
            TellorTransfer.updateBalanceAtNow(tellor.balances[_initalMiners[i]],1000e18);

            //newStake(self, _initalMiners[i]);
        }

        //update the total suppply
        tellor.uintVars[keccak256("total_supply")] += 6000e18;//6th miner to allow for dispute
        //set Constants
        tellor.uintVars[keccak256("decimals")] = 18;
        tellor.uintVars[keccak256("targetMiners")] = 200;
        tellor.uintVars[keccak256("stakeAmount")] = 1000e18;
        tellor.uintVars[keccak256("disputeFee")] = 970e18;
        tellor.uintVars[keccak256("timeTarget")]= 600;
        tellor.uintVars[keccak256("timeOfLastNewValue")] = now - now  % tellor.uintVars[keccak256("timeTarget")];
        tellor.uintVars[keccak256("difficulty")] = 1;
    }

    /**
    * @dev Gets the 5 miners who mined the value for the specified requestId/_timestamp 
    * @dev Only needs to be in library
    * @param _newDeity the new Deity in the contract
    */

    function changeDeity(address _newDeity) external{
        tellor.changeDeity(_newDeity);
    }


    /**
    * @dev  allows for the deity to make fast upgrades.  Deity should be 0 address if decentralized
    * @param _tellorContract the address of the new Tellor Contract
    */
    function changeTellorContract(address _tellorContract) external{
        tellor.changeTellorContract(_tellorContract);
    }
  

    /**
    * @dev This is the fallback function that allows contracts to call the tellor contract at the address stored
    */
    function () external payable {
        address addr = tellor.addressVars[keccak256("tellorContract")];
        bytes memory _calldata = msg.data;
        assembly {
            let result := delegatecall(not(0), addr, add(_calldata, 0x20), mload(_calldata), 0, 0)
            let size := returndatasize
            let ptr := mload(0x40)
            returndatacopy(ptr, 0, size)
            // revert instead of invalid() bc if the underlying call failed with invalid() it already wasted gas.
            // if the call returned error data, forward it
            switch result case 0 { revert(ptr, size) }
            default { return(ptr, size) }
        }
    }
}