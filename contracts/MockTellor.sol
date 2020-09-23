pragma solidity 0.5.16;


//Slightly modified SafeMath library - includes a min and max function, removes useless div function
library SafeMath {
    function add(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a + b;
        assert(c >= a);
        return c;
    }

    function add(int256 a, int256 b) internal pure returns (int256 c) {
        if (b > 0) {
            c = a + b;
            assert(c >= a);
        } else {
            c = a + b;
            assert(c <= a);
        }
    }

    function max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    function max(int256 a, int256 b) internal pure returns (uint256) {
        return a > b ? uint256(a) : uint256(b);
    }

    function min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function mul(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 c = a * b;
        assert(a == 0 || c / a == b);
        return c;
    }

    function sub(uint256 a, uint256 b) internal pure returns (uint256) {
        assert(b <= a);
        return a - b;
    }

    function sub(int256 a, int256 b) internal pure returns (int256 c) {
        if (b > 0) {
            c = a - b;
            assert(c <= a);
        } else {
            c = a - b;
            assert(c >= a);
        }

    }
}

contract MockTellor {

    using SafeMath for uint256;
    event Transfer(address indexed _from, address indexed _to, uint256 _value);//ERC20 Transfer Event
    
    mapping(uint256 => mapping(uint256 => uint256)) public values; //requestId -> timestamp -> value
    mapping(uint256 => mapping(uint256 => bool)) public isDisputed; //requestId -> timestamp -> value
    mapping(uint256 => uint256[]) public timestamps;
    mapping(address => uint) public balances;
    uint256 public totalSupply;

    constructor(address[] memory _initialBalances, uint256[] memory _intialAmounts) public {
        require(_initialBalances.length == _intialAmounts.length, "Arrays have different lengths");
        for(uint i = 0; i < _intialAmounts.length; i++){
            balances[_initialBalances[i]] = _intialAmounts[i];
            totalSupply = totalSupply.add(_intialAmounts[i]);
        }
    }

    function mint(address _holder, uint256 _value) public {
        balances[_holder] = balances[_holder].add(_value);
        totalSupply = totalSupply.add(_value);
    }

    function transfer(address _to, uint256 _amount) public returns(bool) {
        return transferFrom(msg.sender, _to, _amount);
    }

    function transferFrom(address _from, address _to, uint256 _amount) public returns(bool){
        require(_amount != 0, "Tried to send non-positive amount");
        require(_to != address(0), "Receiver is 0 address");
        balances[_from] = balances[_from].sub(_amount);
        balances[_to] = balances[_to].add(_amount);
        emit Transfer(_from, _to, _amount);
    }

    function submitValue(uint256 _requestId,uint256 _value) external {
        values[_requestId][block.timestamp] = _value;
        timestamps[_requestId].push(block.timestamp);
    }

    function disputeValue(uint256 _requestId, uint256 _timestamp) external {
        values[_requestId][_timestamp] = 0;
        isDisputed[_requestId][_timestamp] = true;
    }

    function retrieveData(uint256 _requestId, uint256 _timestamp) public view returns(uint256){
        return values[_requestId][_timestamp];
    }

    function isInDispute(uint256 _requestId, uint256 _timestamp) public view returns(bool){
        return isDisputed[_requestId][_timestamp];
    }

    function getNewValueCountbyRequestId(uint256 _requestId) public view returns(uint) {
        return timestamps[_requestId].length;
    }

    function getTimestampbyRequestIDandIndex(uint256 _requestId, uint256 index) public view returns(uint256) {
        uint len = timestamps[_requestId].length;
        if(len == 0 || len <= index) return 0; 
        return timestamps[_requestId][index];
    }
}