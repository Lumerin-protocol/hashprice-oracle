import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import hardhatViemAbi from "hardhat-viem-abi";
import { tryLoadEnvFile } from "./lib/env.ts";

tryLoadEnvFile("./../.env");
tryLoadEnvFile(".env");

export default defineConfig({
  plugins: [hardhatToolboxViem, hardhatViemAbi],
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
    production: {
      type: "http",
      url: configVariable("ETHEREUM_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATEKEY")],
      gasPrice: "auto",
      gas: "auto",
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
      enabled: true,
    },
  },
});
