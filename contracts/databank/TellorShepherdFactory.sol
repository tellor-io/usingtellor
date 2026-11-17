// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import { TellorShepherd } from "./TellorShepherd.sol";

/**
 * @author Tellor Inc.
 * @title TellorShepherdFactory
 * @notice Permissionless deployment and provenance tracking for Shepherd instances.
 * @dev Registration proves deployment by this factory, not safe configuration or
 * trustworthy sources. The factory has no owner or administrative forwarding path.
 */
contract TellorShepherdFactory {
    // Storage
    mapping(address => bool) public isShepherd;

    // Events
    event ShepherdCreated(address indexed shepherd, address indexed caller, Configuration configuration);

    // Structs
    struct Configuration {
        string description;
        uint8 decimals;
        address primarySource;
        address backupSource;
        address admin;
        uint256 minPauseDuration;
        uint256 configChangeDelay;
        uint256 challengeThresholdBps;
        uint256 challengeDelaySeconds;
        uint256 recoveryDelaySeconds;
        uint256 maxDataAge;
        bool isPausable;
    }

    // State-changing functions

    /**
     * @notice Deploys a fresh instance using the supplied configuration and admin.
     * @dev Shepherd's constructor owns validation. Reverts leave no registration
     * or creation event. Duplicate configurations require distinct caller salts. The event records initial
     * configuration; read Shepherd getters for current sources, authority and mutable policies.
     * @param _configuration Initial sources, authority, pause duration, threshold, and immutable settings.
     * All durations are seconds; minPauseDuration may be zero. Threshold is basis points.
     * isPausable permanently enables or disables explicit pausing; false permits live source replacement.
     * Source timing calibration remains the deployer/admin responsibility, including after replacement.
     * @param _userSalt Caller-scoped salt; the address also commits to all constructor arguments.
     * @return _shepherd Address of the newly deployed and registered instance.
     */
    function createShepherd(
        Configuration memory _configuration,
        bytes32 _userSalt
    ) external returns (address _shepherd) {
        _shepherd = address(
            new TellorShepherd{ salt: keccak256(abi.encode(msg.sender, _userSalt)) }(
                _configuration.description,
                _configuration.decimals,
                _configuration.primarySource,
                _configuration.backupSource,
                _configuration.admin,
                _configuration.minPauseDuration,
                _configuration.configChangeDelay,
                _configuration.challengeThresholdBps,
                [_configuration.challengeDelaySeconds, _configuration.recoveryDelaySeconds],
                _configuration.maxDataAge,
                _configuration.isPausable
            )
        );

        isShepherd[_shepherd] = true;
        emit ShepherdCreated(_shepherd, msg.sender, _configuration);
    }
}
