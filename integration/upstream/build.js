// Test-only upstream compilation. Core Hardhat compilation remains Solidity 0.8.19.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc-upstream");
const pins = require("./pins.json");
const cache = path.resolve(__dirname, "../../cache/protocol-consumers");
const compilerVersion = "0.8.21+commit.d9974bed.Emscripten.clang";

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", timeout: 120000, ...options });
}
function repository(name) { return path.join(cache, `${name}.git`); }
function prepare() {
  if (solc.version() !== compilerVersion) throw new Error(`Unexpected compiler: ${solc.version()}`);
  fs.mkdirSync(cache, { recursive: true });
  for (const [name, pin] of Object.entries(pins)) {
    const dir = repository(name);
    if (!fs.existsSync(dir)) git(["init", "--bare", dir]);
    try {
      git(["--git-dir", dir, "cat-file", "-e", `${pin.commit}^{commit}`], { stdio: "pipe" });
    } catch {
      git(["--git-dir", dir, "fetch", "--depth=1", pin.url, pin.commit], { stdio: "inherit" });
    }
  }
}
function source(name) {
  if (name === "fixture/TokenDecimals.sol") return fs.readFileSync(path.join(__dirname, "TokenDecimals.sol"), "utf8");
  const slash = name.indexOf("/");
  const repo = name.slice(0, slash), file = name.slice(slash + 1);
  if (!pins[repo] || file.split("/").includes("..")) throw new Error(`Unpinned import: ${name}`);
  // Read immutable Git objects, never a potentially modified working tree or old artifact.
  return git(["--git-dir", repository(repo), "show", `${pins[repo].commit}:${file}`]);
}
function compile(entry, contract, settings) {
  const input = {
    language: "Solidity", sources: { [entry]: { content: source(entry) } },
    settings: { evmVersion: "paris", ...settings, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: name => {
    try { return { contents: source(name) }; } catch (error) { return { error: error.message }; }
  } }));
  const errors = (output.errors || []).filter(error => error.severity === "error");
  if (errors.length) throw new Error(errors.map(error => error.formattedMessage).join("\n"));
  const artifact = output.contracts[entry][contract];
  if (!artifact.evm.bytecode.object) throw new Error(`Missing deployment bytecode: ${contract}`);
  return { abi: artifact.abi, bytecode: `0x${artifact.evm.bytecode.object}`, settings: input.settings };
}
function build() {
  prepare();
  const morpho = compile("morpho/src/morpho-chainlink/MorphoChainlinkOracleV2.sol", "MorphoChainlinkOracleV2", {
    optimizer: { enabled: true, runs: 999999 }, viaIR: true, metadata: { bytecodeHash: "none" },
    remappings: ["morpho/lib/morpho-blue/=morpho-blue/", "morpho/lib/openzeppelin-contracts/=openzeppelin/"],
  });
  const euler = compile("euler/src/adapter/chainlink/ChainlinkOracle.sol", "ChainlinkOracle", {
    optimizer: { enabled: true, runs: 100000 },
    remappings: ["forge-std/=forge-std/src/", "@solady/=solady/src/"],
  });
  const token = compile("fixture/TokenDecimals.sol", "TokenDecimals", {});
  // Written for inspection only. Every invocation recompiles; tests never load old JSON.
  fs.writeFileSync(path.join(cache, "build.json"), JSON.stringify({ compilerVersion, pins, morpho, euler, token }, null, 2));
  return { morpho, euler, token };
}
if (require.main === module) {
  build();
  console.log(`Built pinned Morpho V2 and Euler ChainlinkOracle with ${compilerVersion}`);
}
module.exports = { build };
