import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatViemAbi from "hardhat-viem-abi";
import envLoader from "./plugins/env-loader/index.ts";

export default defineConfig({
  plugins: [hardhatToolboxViem, hardhatViemAbi, envLoader],
  envLoader: {
    configDir: "../config",
    // Machine/secret values; win over the named env file for overlapping keys.
    overrideEnvFiles: ["../.env", ".env"],
  },
  paths: {
    tests: "tests",
  },
  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      // chainlink contracts v0.6
      {
        version: "0.6.6",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
    npmFilesToBuild: [
      "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol",
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
      "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol",
      "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV2V3Interface.sol",
      "@chainlink/contracts-old/src/v0.6/AggregatorProxy.sol",
    ],
  },
  networks: {
    default: {
      type: "edr-simulated",
      mining: {
        auto: true,
      },
      initialDate: "2025-11-23",
      // Cancun: avoid EIP-7825 (Osaka+) 16M tx gas cap so graph-node eth_call
      // (default gas 50M) works against this node during local indexing.
      hardfork: "cancun",
      blockGasLimit: 100_000_000n,
      loggingEnabled: true,
      gas: "auto",
      gasPrice: "auto",
    },
    // `hardhat node` defaults to the `node` network and requires it to be
    // edr-simulated. We pin the genesis well in the past so seed-history.ts can
    // mine deploy/replay blocks at historical Bitcoin/Chainlink timestamps via
    // evm_setNextBlockTimestamp (which only moves forward).
    node: {
      type: "edr-simulated",
      mining: {
        auto: true,
      },
      initialDate: "2024-01-01",
      hardfork: "cancun",
      blockGasLimit: 100_000_000n,
      loggingEnabled: true,
      gas: "auto",
      gasPrice: "auto",
    },
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
    },
    "base-sepolia": {
      type: "http",
      chainType: "l1",
      chainId: 84532,
      url: configVariable(
        "ALCHEMY_API_KEY",
        "https://base-sepolia.g.alchemy.com/v2/{variable}",
      ),
      accounts: [configVariable("PRIVATE_KEY")],
    },
    "base-mainnet": {
      type: "http",
      chainType: "l1",
      chainId: 8453,
      url: configVariable(
        "ALCHEMY_API_KEY",
        "https://base-mainnet.g.alchemy.com/v2/{variable}",
      ),
      accounts: [configVariable("PRIVATE_KEY")],
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
      enabled: true,
    },
  },
});
