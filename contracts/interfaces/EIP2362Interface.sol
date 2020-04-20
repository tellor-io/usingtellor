pragma solidity >=0.5.0 <0.7.0;

/**
    * @dev EIP2362 Interface for pull oracles
    * https://github.com/tellor-io/EIP-2362
*/
interface EIP2362Interface{
	/**
    	* @dev Exposed function pertaining to EIP standards
    	* @param _id bytes32 ID of the query
    	* @return int,uint,uint returns the value, timestamp, and status code of query
	*/
  	function valueFor(bytes32 _id) external view returns(int256,uint256,uint256);
}
