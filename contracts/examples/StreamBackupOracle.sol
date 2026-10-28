// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {IBackupOracle} from "../interfaces/IBackupOracle.sol";

/**
 * @notice Example multi-feed backup with trusted streamers and admin-controlled recovery.
 * @dev Admin may appoint itself as a streamer. Authentication establishes authorship,
 * not market truth. Timestamps measure submission age, not underlying observation age.
 * Values must match the primary feed's units. Independent of Layer only to the extent
 * that operators source independent prices. Admin, streamers, and read delay are shared across feeds.
 */
contract StreamBackupOracle is IBackupOracle {
    struct Report {
        uint256 value;
        uint256 submittedAt; // EVM seconds; returned to Shepherd in milliseconds.
        address reporter;
    }

    address public immutable admin;
    uint256 public immutable READ_DELAY_SECONDS;
    uint256 public constant MAX_REPORTS_TO_CHECK = 32;
    mapping(address => bool) public isStreamer;
    mapping(bytes32 => mapping(uint256 => bool)) public isDisputed;
    mapping(bytes32 => Report[]) public reports;
    mapping(bytes32 => bool) public recoveryAllowed;

    event StreamerChanged(address indexed streamer, bool enabled);
    event ReportSubmitted(bytes32 indexed queryId, uint256 indexed index, address indexed reporter, uint256 value, uint256 submittedAt);
    event ReportDisputed(bytes32 indexed queryId, uint256 indexed index);
    event RecoveryPermissionChanged(bytes32 indexed queryId, bool allowed);

    error InvalidQueryId();
    error InvalidAddress();
    error InvalidReadDelay();
    error NotAdmin();
    error NotStreamer();
    error StreamerUnchanged();
    error ZeroValue();
    error InvalidReportIndex();
    error AlreadyDisputed();
    error NoUsableReport();

    // Constructor

    /// @notice Deploys a shared backup with one initial trusted streamer.
    /// @param _admin Authority for streamer membership, disputes, and recovery permission.
    /// @param _initialStreamer Initial address allowed to author reports for any feed.
    /// @param _readDelaySeconds Positive submission-to-read delay in seconds.
    constructor(address _admin, address _initialStreamer, uint256 _readDelaySeconds) {
        if (_admin == address(0) || _initialStreamer == address(0)) revert InvalidAddress();
        if (_readDelaySeconds == 0) revert InvalidReadDelay();
        admin = _admin;
        READ_DELAY_SECONDS = _readDelaySeconds;
        isStreamer[_initialStreamer] = true;
        emit StreamerChanged(_initialStreamer, true);
    }

    // State-changing functions

    /// @notice Permanently excludes a report, including one that was already readable.
    /// @dev Disputes preserve the original value and author for inspection.
    function disputeValue(bytes32 _queryId, uint256 _index) external {
        if (msg.sender != admin) revert NotAdmin();
        if (_index >= reports[_queryId].length) revert InvalidReportIndex();
        if (isDisputed[_queryId][_index]) revert AlreadyDisputed();
        isDisputed[_queryId][_index] = true;
        emit ReportDisputed(_queryId, _index);
    }

    /// @notice Sets the admin's recovery decision; it is not a computed health assessment.
    /// @dev Defaults false per feed. Admin must reassess after primary migration; flags persist.
    function setCanRecover(bytes32 _queryId, bool _allowed) external {
        if (msg.sender != admin) revert NotAdmin();
        if (_queryId == bytes32(0)) revert InvalidQueryId();
        recoveryAllowed[_queryId] = _allowed;
        emit RecoveryPermissionChanged(_queryId, _allowed);
    }

    /// @notice Admin may grant/revoke authorship, including its own, for every feed; history remains intact.
    function setStreamer(address _streamer, bool _enabled) external {
        if (msg.sender != admin) revert NotAdmin();
        if (_streamer == address(0)) revert InvalidAddress();
        if (isStreamer[_streamer] == _enabled) revert StreamerUnchanged();
        isStreamer[_streamer] = _enabled;
        emit StreamerChanged(_streamer, _enabled);
    }

    /// @notice Appends a report timestamped at submission; no observation-time claim is verified.
    /// @dev Indices and disputes are local to each feed. Same-block reports use index order. Resubmission creates a new arrival time.
    function submitValue(bytes32 _queryId, uint256 _value) external {
        if (!isStreamer[msg.sender]) revert NotStreamer();
        if (_queryId == bytes32(0)) revert InvalidQueryId();
        if (_value == 0) revert ZeroValue();
        uint256 index = reports[_queryId].length;
        reports[_queryId].push(Report(_value, block.timestamp, msg.sender));
        emit ReportSubmitted(_queryId, index, msg.sender, _value, block.timestamp);
    }

    // Getter functions

    /// @inheritdoc IBackupOracle
    function canRecover(bytes32 _queryId) external view override returns (bool) {
        return recoveryAllowed[_queryId];
    }

    /**
     * @inheritdoc IBackupOracle
     * @notice Returns the newest mature, undisputed report within the bounded search.
     * @dev Equality permits maturity. Binary search skips immature history, then at most
     * 32 mature reports are inspected backwards. Reverts if that range has no usable report,
     * even when an older undisputed report exists. Selected submission time is preserved.
     */
    function getCurrentValue(bytes32 _queryId) external view override returns (uint256 value, uint256 timestamp) {
        if (block.timestamp < READ_DELAY_SECONDS) revert NoUsableReport();
        uint256 cutoff = block.timestamp - READ_DELAY_SECONDS;
        uint256 low;
        Report[] storage history = reports[_queryId];
        uint256 high = history.length;
        // Upper bound includes every report at cutoff, including same-block submissions.
        while (low < high) {
            uint256 middle = low + (high - low) / 2;
            if (history[middle].submittedAt <= cutoff) low = middle + 1;
            else high = middle;
        }
        for (uint256 checked; low > 0 && checked < MAX_REPORTS_TO_CHECK; checked++) {
            low--;
            if (!isDisputed[_queryId][low]) {
                Report storage report = history[low];
                return (report.value, report.submittedAt * 1000);
            }
        }
        revert NoUsableReport();
    }

    /// @notice Returns the number of submitted reports, including disputed and immature reports.
    /// @param _queryId Feed whose history is counted.
    /// @return Number of reports; also the next submission's index.
    function reportCount(bytes32 _queryId) external view returns (uint256) {
        return reports[_queryId].length;
    }
}
