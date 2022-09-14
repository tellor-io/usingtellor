// SPDX-License-Identifier: MIT
pragma solidity 0.8.3;

import "./UsingTellor.sol";
import "contracts/interface/IERC20.sol";
import "hardhat/console.sol";

/**
 @author Tellor Inc.
 @title Autopay
 @dev This is a contract for automatically paying for Tellor oracle data at
 * specific time intervals, as well as one time tips.
*/
contract MockAutopay is UsingTellor {
    // Storage
    IERC20 public token; // TRB token address
    uint256 public fee; // 1000 is 100%, 50 is 5%, etc.

    mapping(bytes32 => bytes32[]) currentFeeds; // mapping queryId to dataFeedIds array
    mapping(bytes32 => mapping(bytes32 => Feed)) dataFeed; // mapping queryId to dataFeedId to details
    mapping(bytes32 => bytes32) public queryIdFromDataFeedId; // mapping dataFeedId to queryId
    mapping(bytes32 => uint256) public queryIdsWithFundingIndex; // mapping queryId to queryIdsWithFunding index plus one (0 if not in array)
    mapping(bytes32 => Tip[]) public tips; // mapping queryId to tips
    mapping(address => uint256) public userTipsTotal; // track user tip total per user

    bytes32[] public feedsWithFunding; // array of dataFeedIds that have funding
    bytes32[] public queryIdsWithFunding; // array of queryIds that have funding

    // Structs
    struct Feed {
        FeedDetails details;
        mapping(uint256 => bool) rewardClaimed; // tracks which tips were already paid out
    }

    struct FeedDetails {
        uint256 reward; // amount paid for each eligible data submission
        uint256 balance; // account remaining balance
        uint256 startTime; // time of first payment window
        uint256 interval; // time between pay periods
        uint256 window; // amount of time data can be submitted per interval
        uint256 priceThreshold; //change in price necessitating an update 100 = 1%
        uint256 rewardIncreasePerSecond; // amount reward increases per second within window (0 for flat rewards)
        uint256 feedsWithFundingIndex; // index plus one of dataFeedID in feedsWithFunding array (0 if not in array)
    }

    struct Tip {
        uint256 amount;
        uint256 timestamp;
    }

    // Events
    event DataFeedFunded(
        bytes32 _queryId,
        bytes32 _feedId,
        uint256 _amount,
        address _feedFunder
    );
    event NewDataFeed(
        bytes32 _queryId,
        bytes32 _feedId,
        bytes _queryData,
        address _feedCreator
    );
    event OneTimeTipClaimed(
        bytes32 _queryId,
        uint256 _amount,
        address _reporter
    );
    event TipAdded(
        bytes32 _queryId,
        uint256 _amount,
        bytes _queryData,
        address _tipper
    );
    event TipClaimed(
        bytes32 _feedId,
        bytes32 _queryId,
        uint256 _amount,
        address _reporter
    );

    // Functions
    /**
     * @dev Initializes system parameters
     * @param _tellor address of Tellor contract
     * @param _token address of token used for tips
     * @param _fee percentage, 1000 is 100%, 50 is 5%, etc.
     */
    constructor(
        address payable _tellor,
        address _token,
        uint256 _fee
    ) UsingTellor(_tellor) {
        token = IERC20(_token);
        fee = _fee;
    }

    /**
     * @dev Function to claim singular tip
     * @param _queryId id of reported data
     * @param _timestamps[] batch of timestamps array of reported data eligible for reward
     */
    function claimOneTimeTip(bytes32 _queryId, uint256[] calldata _timestamps)external{
        require(tips[_queryId].length > 0,"no tips submitted for this queryId");
        uint256 _reward;
        uint256 _cumulativeReward;
        for (uint256 _i = 0; _i < _timestamps.length; _i++) {
            (_reward) = _claimOneTimeTip(_queryId, _timestamps[_i]);
            _cumulativeReward += _reward;
        }
        require(
            token.transfer(
                msg.sender,
                _cumulativeReward - ((_cumulativeReward * fee) / 1000)
            )
        );
        token.approve(address(tellor), (_cumulativeReward * fee) / 1000);
        tellor.addStakingRewards((_cumulativeReward * fee) / 1000);
        if (getCurrentTip(_queryId) == 0) {
            if (queryIdsWithFundingIndex[_queryId] != 0) {
                uint256 _idx = queryIdsWithFundingIndex[_queryId] - 1;
                // Replace unfunded feed in array with last element
                queryIdsWithFunding[_idx] = queryIdsWithFunding[
                    queryIdsWithFunding.length - 1
                ];
                bytes32 _queryIdLastFunded = queryIdsWithFunding[_idx];
                queryIdsWithFundingIndex[_queryIdLastFunded] = _idx + 1;
                queryIdsWithFundingIndex[_queryId] = 0;
                queryIdsWithFunding.pop();
            }
        }
        emit OneTimeTipClaimed(_queryId, _cumulativeReward, msg.sender);
    }

    /**
     * @dev Allows Tellor reporters to claim their tips in batches
     * @param _feedId unique feed identifier
     * @param _queryId ID of reported data
     * @param _timestamps batch of timestamps array of reported data eligible for reward
     */
    function claimTip(
        bytes32 _feedId,
        bytes32 _queryId,
        uint256[] calldata _timestamps
    ) external {
        uint256 _cumulativeReward;
        Feed storage _feed = dataFeed[_queryId][_feedId];
        uint256 _balance = _feed.details.balance;
        for (uint256 _i = 0; _i < _timestamps.length; _i++) {
            require(
                block.timestamp - _timestamps[_i] > 12 hours,
                "buffer time has not passed"
            );
            require(
                getReporterByTimestamp(_queryId, _timestamps[_i]) == msg.sender,
                "message sender not reporter for given queryId and timestamp"
            );
            _cumulativeReward += _getRewardAmount(
                _feedId,
                _queryId,
                _timestamps[_i]
            );
            if (_cumulativeReward >= _balance) {
                // Balance runs out
                require(
                    _i == _timestamps.length - 1,
                    "insufficient balance for all submitted timestamps"
                );
                _cumulativeReward = _balance;
                // Adjust currently funded feeds
                if (feedsWithFunding.length > 1) {
                    uint256 _idx = _feed.details.feedsWithFundingIndex - 1;
                    // Replace unfunded feed in array with last element
                    feedsWithFunding[_idx] = feedsWithFunding[
                        feedsWithFunding.length - 1
                    ];
                    bytes32 _feedIdLastFunded = feedsWithFunding[_idx];
                    bytes32 _queryIdLastFunded = queryIdFromDataFeedId[
                        _feedIdLastFunded
                    ];
                    dataFeed[_queryIdLastFunded][_feedIdLastFunded]
                        .details
                        .feedsWithFundingIndex = _idx + 1;
                }
                feedsWithFunding.pop();
                _feed.details.feedsWithFundingIndex = 0;
            }
            _feed.rewardClaimed[_timestamps[_i]] = true;
        }
        _feed.details.balance -= _cumulativeReward;
        require(
            token.transfer(
                msg.sender,
                _cumulativeReward - ((_cumulativeReward * fee) / 1000)
            )
        );
        token.approve(address(tellor), (_cumulativeReward * fee) / 1000);
        tellor.addStakingRewards((_cumulativeReward * fee) / 1000);
        emit TipClaimed(_feedId, _queryId, _cumulativeReward, msg.sender);
    }

    /**
     * @dev Allows dataFeed account to be filled with tokens
     * @param _feedId unique feed identifier
     * @param _queryId identifier of reported data type associated with feed
     * @param _amount quantity of tokens to fund feed
     */
    function fundFeed(
        bytes32 _feedId,
        bytes32 _queryId,
        uint256 _amount
    ) public {
        FeedDetails storage _feed = dataFeed[_queryId][_feedId].details;
        require(_feed.reward > 0, "feed not set up");
        require(_amount > 0, "must be sending an amount");
        _feed.balance += _amount;
        require(
            token.transferFrom(msg.sender, address(this), _amount),
            "ERC20: transfer amount exceeds balance"
        );
        // Add to array of feeds with funding
        if (_feed.feedsWithFundingIndex == 0 && _feed.balance > 0) {
            feedsWithFunding.push(_feedId);
            _feed.feedsWithFundingIndex = feedsWithFunding.length;
        }
        userTipsTotal[msg.sender] += _amount;
        emit DataFeedFunded(_feedId, _queryId, _amount, msg.sender);
    }

    /**
     * @dev Initializes dataFeed parameters.
     * @param _queryId unique identifier of desired data feed
     * @param _reward tip amount per eligible data submission
     * @param _startTime timestamp of first autopay window
     * @param _interval amount of time between autopay windows
     * @param _window amount of time after each new interval when reports are eligible for tips
     * @param _priceThreshold amount price must change to automate update regardless of time (negated if 0, 100 = 1%)
     * @param _rewardIncreasePerSecond amount reward increases per second within a window (0 for flat reward)
     * @param _queryData the data used by reporters to fulfill the query
     * @param _amount optional initial amount to fund it with
     */
    function setupDataFeed(
        bytes32 _queryId,
        uint256 _reward,
        uint256 _startTime,
        uint256 _interval,
        uint256 _window,
        uint256 _priceThreshold,
        uint256 _rewardIncreasePerSecond,
        bytes calldata _queryData,
        uint256 _amount
    ) external {
        require(
            _queryId == keccak256(_queryData) || uint256(_queryId) <= 100,
            "id must be hash of bytes data"
        );
        bytes32 _feedId = keccak256(
            abi.encode(
                _queryId,
                _reward,
                _startTime,
                _interval,
                _window,
                _priceThreshold,
                _rewardIncreasePerSecond
            )
        );
        FeedDetails storage _feed = dataFeed[_queryId][_feedId].details;
        require(_feed.reward == 0, "feed must not be set up already");
        require(_reward > 0, "reward must be greater than zero");
        require(_interval > 0, "interval must be greater than zero");
        require(
            _window < _interval,
            "window must be less than interval length"
        );
        _feed.reward = _reward;
        _feed.startTime = _startTime;
        _feed.interval = _interval;
        _feed.window = _window;
        _feed.priceThreshold = _priceThreshold;
        _feed.rewardIncreasePerSecond = _rewardIncreasePerSecond;
        currentFeeds[_queryId].push(_feedId);
        queryIdFromDataFeedId[_feedId] = _queryId;
        emit NewDataFeed(_queryId, _feedId, _queryData, msg.sender);
        if(_amount > 0){
            fundFeed(_feedId,_queryId,_amount);
        }
    }

    /**
     * @dev Function to run a single tip
     * @param _queryId ID of tipped data
     * @param _amount amount to tip
     * @param _queryData the data used by reporters to fulfill the query
     */
    function tip(
        bytes32 _queryId,
        uint256 _amount,
        bytes calldata _queryData
    ) external {
        require(
            _queryId == keccak256(_queryData) || uint256(_queryId) <= 100,
            "id must be hash of bytes data"
        );
        require(_amount > 0, "tip must be greater than zero");
        Tip[] storage _tips = tips[_queryId];
        if (_tips.length == 0) {
            _tips.push(Tip(_amount, block.timestamp));
        } else {
            (, uint256 _timestampRetrieved) = _getCurrentValue(_queryId);
            if (_timestampRetrieved < _tips[_tips.length - 1].timestamp) {
                _tips[_tips.length - 1].timestamp = block.timestamp;
                _tips[_tips.length - 1].amount += _amount;
            } else {
                _tips.push(Tip(_amount, block.timestamp));
            }
        }
        if (
            queryIdsWithFundingIndex[_queryId] == 0 &&
            getCurrentTip(_queryId) > 0
        ) {
            queryIdsWithFunding.push(_queryId);
            queryIdsWithFundingIndex[_queryId] = queryIdsWithFunding.length;
        }
        require(
            token.transferFrom(msg.sender, address(this), _amount),
            "ERC20: transfer amount exceeds balance"
        );
        userTipsTotal[msg.sender] += _amount;
        emit TipAdded(_queryId, _amount, _queryData, msg.sender);
    }

    // Getters
    /**
     * @dev Getter function to read current data feeds
     * @param _queryId id of reported data
     * @return feedIds array for queryId
     */
    function getCurrentFeeds(bytes32 _queryId) external view returns (bytes32[] memory){
        return currentFeeds[_queryId];
    }

    /**
     * @dev Getter function to current oneTime tip by queryId
     * @param _queryId id of reported data
     * @return amount of tip
     */
    function getCurrentTip(bytes32 _queryId) public view returns (uint256) {
        (, uint256 _timestampRetrieved) = _getCurrentValue(_queryId);
        Tip memory _lastTip = tips[_queryId][tips[_queryId].length - 1];
        if (_timestampRetrieved < _lastTip.timestamp) {
            return _lastTip.amount;
        } else {
            return 0;
        }
    }

    /**
     * @dev Getter function to read a specific dataFeed
     * @param _feedId unique feedId of parameters
     * @return FeedDetails details of specified feed
     */
    function getDataFeed(bytes32 _feedId) external view returns (FeedDetails memory){
        return (dataFeed[queryIdFromDataFeedId[_feedId]][_feedId].details);
    }

    /**
     * @dev Getter function for currently funded feeds
     */
    function getFundedFeeds() external view returns (bytes32[] memory){
        return feedsWithFunding;
    }

    /**
     * @dev Getter function for queryIds with current one time tips
     */
    function getFundedQueryIds() external view returns (bytes32[] memory){
        return queryIdsWithFunding;
    }

    /**
     * @dev Getter function to get number of past tips
     * @param _queryId id of reported data
     * @return count of tips available
     */
    function getPastTipCount(bytes32 _queryId) external view returns (uint256){
        return tips[_queryId].length;
    }

    /**
     * @dev Getter function for past tips
     * @param _queryId id of reported data
     * @return Tip struct (amount/timestamp) of all past tips
     */
    function getPastTips(bytes32 _queryId) external view returns (Tip[] memory){
        return tips[_queryId];
    }

    /**
     * @dev Getter function for past tips by index
     * @param _queryId id of reported data
     * @param _index uint index in the Tip array
     * @return amount/timestamp of specific tip
     */
    function getPastTipByIndex(bytes32 _queryId, uint256 _index)
        external
        view
        returns (Tip memory)
    {
        return tips[_queryId][_index];
    }

    /**
     * @dev Getter function to lookup query IDs from dataFeed IDs
     * @param _feedId dataFeed unique identifier
     * @return bytes32 corresponding query ID
     */
    function getQueryIdFromFeedId(bytes32 _feedId)
        external
        view
        returns (bytes32)
    {
        return queryIdFromDataFeedId[_feedId];
    }

    /**
     * @dev Getter function to read potential rewards for a set of oracle submissions
     * NOTE: Does not consider reporter address, 12-hour dispute buffer period, or duplicate timestamps
     * @param _feedId dataFeed unique identifier
     * @param _queryId unique identifier of reported data
     * @param _timestamps array of timestamps of oracle submissions
     * @return _cumulativeReward total potential reward for the set of oracle submissions
     */
    function getRewardAmount(
        bytes32 _feedId,
        bytes32 _queryId,
        uint256[] calldata _timestamps
    ) external view returns (uint256 _cumulativeReward) {
        FeedDetails storage _feed = dataFeed[_queryId][_feedId].details;
        for (uint256 _i = 0; _i < _timestamps.length; _i++) {
            _cumulativeReward += _getRewardAmount(
                _feedId,
                _queryId,
                _timestamps[_i]
            );
        }
        if (_cumulativeReward > _feed.balance) {
            _cumulativeReward = _feed.balance;
        }
        _cumulativeReward -= ((_cumulativeReward * fee) / 1000);
    }

    /**
     * @dev Getter function for reading whether a reward has been claimed
     * @param _feedId feedId of dataFeed
     * @param _queryId id of reported data
     * @param _timestamp id or reported data
     * @return bool rewardClaimed
     */
    function getRewardClaimedStatus(
        bytes32 _feedId,
        bytes32 _queryId,
        uint256 _timestamp
    ) external view returns (bool) {
        return dataFeed[_queryId][_feedId].rewardClaimed[_timestamp];
    }

    /**
     * @dev Getter function for retrieving the total amount of tips paid by a given address
     * @param _user address of user to query
     * @return uint256 total amount of tips paid by user
     */
    function getTipsByAddress(address _user) external view returns (uint256) {
        return userTipsTotal[_user];
    }

    // Internal functions
    /**
     * @dev Internal function to read if a reward has been claimed
     * @param _b bytes value to convert to uint256
     * @return _number uint256 converted from bytes
     */
    function _bytesToUint(bytes memory _b) internal pure returns(uint256 _number){
        for (uint256 _i = 0; _i < _b.length; _i++) {
            _number = _number * 256 + uint8(_b[_i]);
        }
    }

    /**
     ** @dev Internal function which determines tip eligibility for a given oracle submission
     * @param _queryId id of reported data
     * @param _timestamp timestamp of one time tip
     * @return _tipAmount of tip
     */
    function _claimOneTimeTip(bytes32 _queryId, uint256 _timestamp)
        internal
        returns (uint256 _tipAmount)
    {
        Tip[] storage _tips = tips[_queryId];
        require(
            block.timestamp - _timestamp > 12 hours,
            "buffer time has not passed"
        );
        if(isInDispute(_queryId, _timestamp)){
            (,uint256 _timestampAfter) = getDataAfter(_queryId, _timestamp+1);
            require(msg.sender == getReporterByTimestamp(_queryId, _timestampAfter), 
            "must be next reporter");
        } else{
            require(
                msg.sender == getReporterByTimestamp(_queryId, _timestamp),
                "no value exists at timestamp"
            );
        }
        uint256 _min = 0;
        uint256 _max = _tips.length;
        uint256 _mid;
        while (_max - _min > 1) {
            _mid = (_max + _min) / 2;
            if (_tips[_mid].timestamp > _timestamp) {
                _max = _mid;
            } else {
                _min = _mid;
            }
        }
        (, uint256 _timestampBefore) = getDataBefore(_queryId, _timestamp);
        require(
            _timestampBefore < _tips[_min].timestamp,
            "tip earned by previous submission"
        );
        require(
            _timestamp >= _tips[_min].timestamp,
            "timestamp not eligible for tip"
        );
        require(_tips[_min].amount > 0, "tip already claimed");
        _tipAmount = _tips[_min].amount;
        _tips[_min].amount = 0;
    }

    /**
     * @dev Allows the user to get the latest value for the queryId specified
     * @param _queryId is the id to look up the value for
     * @return _value the value retrieved
     * @return _timestampRetrieved the retrieved value's timestamp
     */

    function _getCurrentValue(bytes32 _queryId)
        internal
        view
        returns (bytes memory _value, uint256 _timestampRetrieved)
    {
        uint256 _count = getNewValueCountbyQueryId(_queryId);
        if (_count == 0) {
            return (bytes(""), 0);
        }
        uint256 _time;
        //loop handles for dispute (value = "" if disputed)
        while(_count > 0){
                _count--;
                _time = getTimestampbyQueryIdandIndex(_queryId, _count);
                _value = retrieveData(_queryId, _time);
                if (_value.length > 0) {
                    return (_value, _time);
                }
        }
        return (bytes(""), _time);
    }

    /**
     * @dev Internal function which determines the reward amount for a given oracle submission
     * @param _feedId id of dataFeed
     * @param _queryId id of reported data
     * @param _timestamp timestamp of reported data eligible for reward
     * @return _rewardAmount potential reward amount for the given oracle submission
     */
    function _getRewardAmount(
        bytes32 _feedId,
        bytes32 _queryId,
        uint256 _timestamp
    ) internal view returns (uint256 _rewardAmount) {
        require(
            block.timestamp - _timestamp < 12 weeks,
            "timestamp too old to claim tip"
        );
        Feed storage _feed = dataFeed[_queryId][_feedId];
        require(!_feed.rewardClaimed[_timestamp], "reward already claimed");
        uint256 _n = (_timestamp - _feed.details.startTime) /
            _feed.details.interval; // finds closest interval _n to timestamp
        uint256 _c = _feed.details.startTime + _feed.details.interval * _n; // finds start timestamp _c of interval _n
        bytes memory _valueRetrieved = retrieveData(_queryId, _timestamp);
        require(_valueRetrieved.length != 0, "no value exists at timestamp");
        (
            bytes memory _valueRetrievedBefore,
            uint256 _timestampBefore
        ) = getDataBefore(_queryId, _timestamp);
        uint256 _priceChange = 0; // price change from last value to current value
        if (_feed.details.priceThreshold != 0) {
            uint256 _v1 = _bytesToUint(_valueRetrieved);
            uint256 _v2 = _bytesToUint(_valueRetrievedBefore);
            if (_v2 == 0) {
                _priceChange = 10000;
            } else if (_v1 >= _v2) {
                _priceChange = (10000 * (_v1 - _v2)) / _v2;
            } else {
                _priceChange = (10000 * (_v2 - _v1)) / _v2;
            }
        }
        _rewardAmount = _feed.details.reward;
        if (_priceChange <= _feed.details.priceThreshold) {
            uint256 _timeDiff = _timestamp - _c;
            require(
                _timeDiff < _feed.details.window,
                "timestamp not within window"
            );
            require(
                _timestampBefore < _c,
                "timestamp not first report within window"
            );
            // calculate time based reward if applicable
            _rewardAmount += _feed.details.rewardIncreasePerSecond * _timeDiff;
        }
        if (_feed.details.balance < _rewardAmount) {
            _rewardAmount = _feed.details.balance;
        }
    }
}