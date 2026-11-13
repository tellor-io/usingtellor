// SPDX-License-Identifier: MIT
pragma solidity 0.8.19;

import {TellorShepherd} from "./TellorShepherd.sol";

/**
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
        bytes32 queryId;
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
     * @param configuration Initial sources, authority, pause duration, threshold, and immutable settings.
     * All durations are seconds; minPauseDuration may be zero. Threshold is basis points.
     * isPausable permanently enables or disables explicit pausing; false permits live source replacement.
     * Source timing calibration remains the deployer/admin responsibility, including after replacement.
     * @param userSalt Caller-scoped salt; the address also commits to all constructor arguments.
     * @return shepherd Address of the newly deployed and registered instance.
     */
    function createShepherd(Configuration calldata configuration, bytes32 userSalt) external returns (address shepherd) {
        shepherd = address(new TellorShepherd{salt: keccak256(abi.encode(msg.sender, userSalt))}(
            configuration.queryId,
            configuration.decimals,
            configuration.primarySource,
            configuration.backupSource,
            configuration.admin,
            configuration.minPauseDuration,
            configuration.configChangeDelay,
            configuration.challengeThresholdBps,
            [configuration.challengeDelaySeconds, configuration.recoveryDelaySeconds],
            configuration.maxDataAge,
            configuration.isPausable
        ));

        isShepherd[shepherd] = true;
        emit ShepherdCreated(shepherd, msg.sender, configuration);
    }
}
