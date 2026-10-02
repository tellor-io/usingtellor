const { ethers, network } = require("hardhat");
const assert = require('assert');

const hash = ethers.keccak256;
const abiCoder = new ethers.AbiCoder();

/**
 * Advances the time by the given amount.
 * @param {number} time - The amount of time to advance in seconds
 * @returns {void}
 */
async function advanceTime(time) {
  await network.provider.send("evm_increaseTime", [time])
  await network.provider.send("evm_mine")
}

/**
 * Expects a throw from a promise.
 * @param {Promise} promise - The promise to expect a throw from
 * @returns {void}
 */
async function expectThrow(promise) {
  try {
    await promise;
  } catch (error) {
    const invalidOpcode = error.message.search("invalid opcode") >= 0;
    const outOfGas = error.message.search("out of gas") >= 0;
    const revert = error.message.search("revert") >= 0;
    assert(
      invalidOpcode || outOfGas || revert,
      "Expected throw, got '" + error + "' instead"
    );
    return;
  }
  assert.fail("Expected throw not received");
}

/**
 * Converts a number to a bytes32 string.
 * @param {number} n - The number to convert to a bytes32 string
 * @returns {string} The bytes32 string
 */
function tob32(n) {
  return ethers.formatBytes32String(n)
}

/**
 * Converts a number to a bytes32 string.
 * @param {number} n - The number to convert to a bytes32 string
 * @returns {string} The bytes32 string
 */
function uintTob32(n){
  let vars = ethers.hexlify(n)
  vars = vars.slice(2)
  while(vars.length < 64){
    vars = "0" + vars
  }
  vars = "0x" + vars
  return vars
}

function bytes(n){
  return ethers.hexlify(n)
}

/**
 * Gets the current block.
 * @returns {Object} The current block
 */
function getBlock(){
  return ethers.provider.getBlock()
}

/**
 * Converts a number from ether to wei.
 * @param {number} n - The number to convert to wei
 * @returns {ethers.BigNumber} The number in wei
 */
function toWei(n){
  return ethers.parseEther(n)
}

/**
 * Converts a number from wei to ether.
 * @param {ethers.BigNumber} n - The number to convert from wei
 * @returns {number} The number in ether
 */
function fromWei(n){
  return ethers.formatEther(n)
}

/**
 * Sleeps for the given amount of seconds.
 * @param {number} s - The amount of seconds to sleep
 * @returns {Promise} A promise that resolves after the given amount of seconds
 */
function sleep(s) {
  return new Promise(resolve => setTimeout(resolve, s * 1000));
}

/**
 * Calculates the validator checkpoint.
 * @param {string} valHash - The validator hash
 * @param {number} threshold - The threshold
 * @param {number} valTimestamp - The validator timestamp
 * @param {string} domainSeparator - The domain separator (defaults to mainnet domain separator)
 * @returns {string} The validator checkpoint
 */
function calculateValCheckpoint(valHash, threshold, valTimestamp, domainSeparator="0x636865636b706f696e7400000000000000000000000000000000000000000000") {
  enc = abiCoder.encode(["bytes32", "uint256", "uint256", "bytes32"], [domainSeparator, threshold, valTimestamp, valHash])
  valCheckpoint = hash(enc)
  return valCheckpoint
}

/**
 * Calculates the validator set hash.
 * @param {Array} valSet - The validator set
 * @param {Array} powers - The powers
 * @returns {string} The validator hash
 */
function calculateValHash(valSet, powers) {
  structArray = []
  for (i = 0; i < valSet.length; i++) {
    structArray[i] = {
      addr: valSet[i],
      power: powers[i]
    }
  }
  // encode the array of Validator struct objects into bytes so they can be hashed
  enc = abiCoder.encode(["tuple(address addr, uint256 power)[]"], [structArray])
  // hash the encoded bytes
  valHash = hash(enc)
  return valHash
}

/**
 * Calculates the Ethereum signed message hash.
 * @param {string} messageHash - The message hash
 * @returns {string} The Ethereum signed message hash
 */
function getEthSignedMessageHash(messageHash) {
  const prefix = "\x19Ethereum Signed Message:\n32";
  const messageHashBytes = ethers.getBytes(messageHash);
  const prefixBytes = ethers.getBytes(prefix);
  const combined = ethers.concat([prefixBytes, messageHashBytes]);
  const digest = ethers.keccak256(combined);
  return digest;
}

/**
 * Calculates the tellor data digest, also known as a "snapshot".
 * @param {string} queryId - The query ID
 * @param {string} value - The encoded value
 * @param {number} timestamp - The timestamp
 * @param {number} aggregatePower - The aggregate power
 * @param {number} previousTimestamp - The previous timestamp
 * @param {number} nextTimestamp - The next timestamp
 * @param {string} valCheckpoint - The validator checkpoint
 * @param {number} attestationTimestamp - The attestation timestamp
 * @param {number} lastConsensusTimestamp - The last consensus timestamp
 * @returns {string} The data digest
 */
function getDataDigest(queryId, value, timestamp, aggregatePower, previousTimestamp, nextTimestamp, valCheckpoint, attestationTimestamp, lastConsensusTimestamp) {
  const DOMAIN_SEPARATOR = "0x74656c6c6f7243757272656e744174746573746174696f6e0000000000000000"
  enc = abiCoder.encode(["bytes32", "bytes32", "bytes", "uint256", "uint256", "uint256", "uint256", "bytes32", "uint256", "uint256"],
    [DOMAIN_SEPARATOR, queryId, value, timestamp, aggregatePower, previousTimestamp, nextTimestamp, valCheckpoint, attestationTimestamp, lastConsensusTimestamp])
  return hash(enc)
}

/**
 * Converts arrays of validator addresses and powers to a struct array.
 * @param {Array} valAddrs - The validator addresses
 * @param {Array} powers - The powers
 * @returns {Array} The validator set struct array
 * @example
 * const valSetStructArray = getValSetStructArray(["0x123", "0x456"], [1, 2])
 * // returns [{ addr: "0x123", power: 1 }, { addr: "0x456", power: 2 }]
 */
function getValSetStructArray(valAddrs, powers) {
  structArray = []
  for (i = 0; i < valAddrs.length; i++) {
    structArray[i] = {
      addr: valAddrs[i],
      power: powers[i]
    }
  }
  return structArray
}

/**
 * Converts arrays of signatures to a struct array.
 * @param {Array} sigs - The signatures
 * @returns {Array} The signature struct array
 * @example
 * const sigStructArray = getSigStructArray([{ v: 0, r: "0x123", s: "0x456" }, { v: 1, r: "0x789", s: "0xabc" }])
 * // returns [{ v: 0, r: "0x123", s: "0x456" }, { v: 1, r: "0x789", s: "0xabc" }]
 */
function getSigStructArray(sigs) {
  structArray = []
  for (i = 0; i < sigs.length; i++) {
    if(sigs[i].v == 0){
      structArray[i] = {
        v: abiCoder.encode(["uint8"], [0]),
        r: abiCoder.encode(["bytes32"], ['0x0000000000000000000000000000000000000000000000000000000000000000']),
        s: abiCoder.encode(["bytes32"], ['0x0000000000000000000000000000000000000000000000000000000000000000'])
      }
    }
    else{
      // let { v, r, s } = ethers.Signature.from(sigs[i])
      structArray[i] = {
        v: abiCoder.encode(["uint8"], [sigs[i].v]),
        r: abiCoder.encode(["bytes32"], [sigs[i].r]),
        s: abiCoder.encode(["bytes32"], [sigs[i].s])
      }
    }
  }
  return structArray
}

/**
 * Converts oracle data and metadata to a struct compatible with the databridge contract.
 * @param {string} queryId - The query ID
 * @param {string} value - The encoded value
 * @param {number} timestamp - The timestamp
 * @param {number} aggregatePower - The aggregate power
 * @param {number} previousTimestamp - The previous timestamp
 * @param {number} nextTimestamp - The next timestamp
 * @param {number} attestTimestamp - The attestation timestamp
 * @param {number} lastConsensusTimestamp - The last consensus timestamp
 * @returns {Object} The oracle data struct
 */
function getOracleDataStruct(queryId, value, timestamp, aggregatePower, previousTimestamp, nextTimestamp, attestTimestamp, lastConsensusTimestamp) {
  return {
    queryId: queryId,
    report: {
      value: value,
      timestamp: timestamp,
      aggregatePower: aggregatePower,
      previousTimestamp: previousTimestamp,
      nextTimestamp: nextTimestamp,
      lastConsensusTimestamp: lastConsensusTimestamp
    },
    attestationTimestamp: attestTimestamp
  }
}

/**
 * Encodes tellor token bridge withdraw values into an oracle value.
 * @param {string} _recipient - The recipient (evm address)
 * @param {string} _sender - The sender (tellor layer address)
 * @param {number} _amount - The amount (amount in loya, 1e6)
 * @returns {string} The withdraw value
 */
function getWithdrawValue(_recipient, _sender, _amount) {
  // tip is 0 for withdrawals
  myVal = abiCoder.encode(["address", "string", "uint256", "uint256"],
    [_recipient, _sender, _amount, 0])
  return myVal
}

/**
 * Creates an oracle attestation data struct.
 * @param {string} _queryId - The query ID
 * @param {string} _value - The encoded value
 * @param {number} _timestamp - The timestamp
 * @param {number} _reporterPower - The reporter power
 * @returns {Object} The oracle attestation data struct
 */
function getCurrentAggregateReport(_queryId, _value, _timestamp,_reporterPower) {
    reportData = {
      value: _value,
      timestamp: _timestamp,
      aggregatePower: _reporterPower,
      previousTimestamp: 0,
      nextTimestamp: 0
    }
    oracleAttestationData = {
      queryId: _queryId,
      report: reportData,
      attestTimestamp: _timestamp
    }
    return oracleAttestationData
}

/**
 * Using a private key, signs the sha256 hash of a message.
 * @param {string} message - The message to sign
 * @param {string} privateKey - The private key to sign with
 * @returns {Object} The signature
 */
function layerSign(message, privateKey) {
  // assumes message is bytesLike
  messageHash = ethers.sha256(message)
  signingKey = new ethers.SigningKey(privateKey)
  signature = signingKey.sign(messageHash)
  return signature
}

/**
 * Prepares oracle data for relaying to a user contract.
 * @param {string} queryId - The query ID for the oracle data
 * @param {string} value - The encoded value to be reported
 * @param {Object} validatorSet - Object from createTellorValset() containing wallets, powers, checkpoint
 * @param {Object} overrides - Optional overrides for any calculated values
 * @param {number} overrides.aggregateTimestamp - Custom aggregate timestamp (default: (block.timestamp - 2) * 1000)
 * @param {number} overrides.aggregatePower - Custom aggregate power (default: sum of powers)
 * @param {number} overrides.attestationTimestamp - Custom attestation timestamp (default: aggregateTimestamp + 1000)
 * @param {number} overrides.previousTimestamp - Custom previous timestamp (default: 0)
 * @param {number} overrides.nextTimestamp - Custom next timestamp (default: 0)
 * @param {number} overrides.lastConsensusTimestamp - Custom last consensus timestamp (default: aggregateTimestamp for consensus data)
 * @param {boolean} overrides.ignoreInvariantChecks - Whether to skip invariant checks (default: false)
 * @returns {Object} Object containing attestData, currentValidatorSet, and sigs
 */
async function prepareOracleData(queryId, value, validatorSet, overrides = {}) {
  const validators = validatorSet.wallets;
  const powers = validatorSet.powers;
  const validatorCheckpoint = validatorSet.checkpoint;
  const blocky = await getBlock();
  
  // Calculate defaults
  const defaultAggregateTimestamp = (blocky.timestamp - 2) * 1000;
  const defaultAggregatePower = powers.reduce((a, b) => a + b, 0);
  
  // Use overrides or defaults
  const aggregateTimestamp = overrides.aggregateTimestamp !== undefined ? overrides.aggregateTimestamp : defaultAggregateTimestamp;
  const aggregatePower = overrides.aggregatePower !== undefined ? overrides.aggregatePower : defaultAggregatePower;
  const attestationTimestamp = overrides.attestationTimestamp !== undefined ? overrides.attestationTimestamp : aggregateTimestamp + 1000;
  const previousTimestamp = overrides.previousTimestamp !== undefined ? overrides.previousTimestamp : 0;
  const nextTimestamp = overrides.nextTimestamp !== undefined ? overrides.nextTimestamp : 0;
  // Default to consensus data (aggregateTimestamp == lastConsensusTimestamp)
  const lastConsensusTimestamp = overrides.lastConsensusTimestamp !== undefined ? overrides.lastConsensusTimestamp : aggregateTimestamp;
  
  // Validate invariants if not overridden. These are not checked by the contract. But they are expected behavior,
  // and help when writing tests. They can be ignored if testing for invariant violations.
  if (!overrides.ignoreInvariantChecks) {
    if (previousTimestamp > 0 && aggregateTimestamp <= previousTimestamp) {
        throw new Error("Invariant violation: aggregateTimestamp must be > previousTimestamp");
    }
    if (nextTimestamp > 0 && nextTimestamp <= aggregateTimestamp) {
        throw new Error("Invariant violation: nextTimestamp must be > aggregateTimestamp or 0");
    }
    if (attestationTimestamp < aggregateTimestamp) {
        throw new Error("Invariant violation: attestationTimestamp must be >= aggregateTimestamp");
    }
    if (attestationTimestamp < lastConsensusTimestamp) {
        throw new Error("Invariant violation: attestationTimestamp must be >= lastConsensusTimestamp");
    }
  }
  
  // Generate data digest
  const dataDigest = await getDataDigest(
    queryId,
    value,
    aggregateTimestamp,
    aggregatePower,
    previousTimestamp,
    nextTimestamp,
    validatorCheckpoint,
    attestationTimestamp,
    lastConsensusTimestamp
  );
  
  // Prepare validator set
  const valAddrs = validators.map(v => v.address);
  const currentValSetArray = await getValSetStructArray(valAddrs, powers);
  
  // Generate signatures
  const sigs = [];
  for (let i = 0; i < validators.length; i++) {
    sigs.push(layerSign(dataDigest, validators[i].privateKey));
  }
  const sigStructArray = await getSigStructArray(sigs);
  
  // Create oracle data struct
  const oracleDataStruct = await getOracleDataStruct(
    queryId,
    value,
    aggregateTimestamp,
    aggregatePower,
    previousTimestamp,
    nextTimestamp,
    attestationTimestamp,
    lastConsensusTimestamp
  );
  
  return {
    attestData: oracleDataStruct,
    currentValidatorSet: currentValSetArray,
    sigs: sigStructArray
  };
}

/**
 * Converts attestData struct to array. Useful when the attestData struct is emitted in an event.
 * @param {Object} attestData - The attestData struct to convert to an array
 * @returns {Array} Array of attestData struct
 */
function attestDataStructToArray(attestData) {
  return [
    attestData.queryId,
    [
      attestData.report.value,
      attestData.report.timestamp,
      attestData.report.aggregatePower,
      attestData.report.previousTimestamp,
      attestData.report.nextTimestamp,
      attestData.report.lastConsensusTimestamp,
    ],
    attestData.attestationTimestamp,
  ];
}

/**
 * Gets the domain separator for the given layer chain ID.
 * @param {string} layerChainId - The layer chain ID (defaults to mainnet, "tellor-1")
 * @returns {string} The domain separator
 */
function getDomainSeparator(layerChainId = "tellor-1") {
  if (layerChainId == "tellor-1") {
    return "0x636865636b706f696e7400000000000000000000000000000000000000000000"
  } else {
    return ethers.keccak256(abiCoder.encode(["string", "string"], ["checkpoint", layerChainId]))
  }
}

/**
 * Deep freezes an object.
 * @param {Object} obj - The object to deep freeze
 * @returns {Object} The deep frozen object
 */
function deepFreeze(obj) {
  Object.freeze(obj);
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return obj;
}

/**
 * Creates a tellor validator set for testing data bridge interactions.
 * @param {Object} opts - The options for creating the validator set
 * @param {number} opts.valCount - The number of validators (default: 1)
 * @param {Array} opts.powers - The powers for the validators (default: [100])
 * @param {number} opts.validatorTimestamp - The timestamp for the validator set (default: 0)
 * @param {string} opts.tellorChainId - The tellor chain ID (default: "tellor-1")
 * @param {Array} opts.wallets - The wallets for the validators (default: [])
 * @param {Function} opts.walletFactory - The wallet factory function (default: () => ethers.Wallet.createRandom())
 * @returns {Object} The validator set
 */
async function createTellorValset({
  valCount = 1,
  powers,
  validatorTimestamp,
  tellorChainId = "tellor-1",
  wallets,
  walletFactory = () => ethers.Wallet.createRandom(),
} = {}) {
  // derive final wallets
  const finalWallets = wallets?.length
    ? wallets
    : Array.from({ length: valCount }, () => walletFactory());

  const finalValCount = finalWallets.length;

  // derive powers
  const finalPowers =
    powers?.length ? powers
    : Array.from({ length: finalValCount }, () => 100);

  if (finalPowers.length !== finalValCount) {
    throw new Error("powers.length must match wallets length");
  }

  // timestamp
  let finalTimestamp = validatorTimestamp;
  if (finalTimestamp == null) {
    const block = await getBlock();
    finalTimestamp = (block.timestamp - 2) * 1000;
  }

  const domainSeparator = getDomainSeparator(tellorChainId);

  // compute
  const totalPower = finalPowers.reduce((a, b) => a + b, 0);
  const powerThreshold = Math.floor((totalPower * 2) / 3);

  const addresses = finalWallets.map(w => w.address);
  const valsetHash = calculateValHash(addresses, finalPowers);
  const checkpoint = calculateValCheckpoint(
    valsetHash,
    powerThreshold,
    finalTimestamp,
    domainSeparator
  );

  const data = {
    validators: finalWallets.map((w, i) => ({ wallet: w, power: finalPowers[i] })),
    wallets: finalWallets,
    addresses,
    powers: finalPowers,
    totalPower,
    powerThreshold,
    timestamp: finalTimestamp,
    domainSeparator,
    valsetHash,
    checkpoint,
  };

  const api = {
    structArray() {
      return data.validators.map(v => ({
        addr: v.wallet.address,
        power: v.power,
      }));
    },

    toJSON() {
      return {
        addresses: data.addresses,
        powers: data.powers,
        totalPower: data.totalPower,
        powerThreshold: data.powerThreshold,
        timestamp: data.timestamp,
        domainSeparator: data.domainSeparator,
        valsetHash: data.valsetHash,
        checkpoint: data.checkpoint,
      };
    },
  };

  return deepFreeze({ ...data, ...api });
}

module.exports = {
  getWithdrawValue,
  getCurrentAggregateReport,
  getOracleDataStruct,
  getSigStructArray,
  getValSetStructArray,
  getDataDigest,
  getEthSignedMessageHash,
  calculateValCheckpoint,
  calculateValHash,
  hash,
  uintTob32,
  tob32,
  bytes,
  getBlock,
  advanceTime,
  toWei,
  fromWei,
  expectThrow,
  sleep,
  layerSign,
  prepareOracleData,
  abiCoder,
  attestDataStructToArray,
  getDomainSeparator,
  createTellorValset
};

