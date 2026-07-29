// export all your on‐chain APIs…
const { TellorDataBridge, YoloTellorUser } = require("./contracts")
const { artifacts } = require("./artifacts")
// …and all your evm-helpers
const evmHelpers = require("./helpers/evmHelpers")

module.exports = {
  TellorDataBridge,
  YoloTellorUser,
  ...evmHelpers,
  artifacts
}
