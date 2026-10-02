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
        address dataBank;
        address backupOracle;
        address admin;
        uint256 relayReadDelay;
        uint256 minPauseDuration;
        uint256 dataBankChangeDelay;
        uint256 backupChangeDelay;
        uint256 twapWindowMs;
        uint256 challengeThresholdBps;
        uint256 challengeDelaySeconds;
        uint256 recoveryDelaySeconds;
    }

    // State-changing functions

    /**
     * @notice Deploys a fresh instance using the supplied configuration and admin.
     * @dev Shepherd's constructor owns validation. Reverts leave no registration
     * or creation event. Duplicate configurations are allowed. Event source
     * addresses describe deployment; read Shepherd getters after source migration.
     * @param configuration Initial sources, authority, and immutable settings.
     * All durations are seconds except twapWindowMs; threshold is basis points.
     * @return shepherd Address of the newly deployed and registered instance.
     */
    function createShepherd(Configuration calldata configuration) external returns (address shepherd) {
        shepherd = address(new TellorShepherd(
            configuration.queryId,
            configuration.dataBank,
            configuration.backupOracle,
            configuration.admin,
            configuration.relayReadDelay,
            configuration.minPauseDuration,
            configuration.dataBankChangeDelay,
            configuration.backupChangeDelay,
            configuration.twapWindowMs,
            configuration.challengeThresholdBps,
            [configuration.challengeDelaySeconds, configuration.recoveryDelaySeconds]
        ));

        isShepherd[shepherd] = true;
        emit ShepherdCreated(shepherd, msg.sender, configuration);
    }
}
