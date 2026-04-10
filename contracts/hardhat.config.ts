import { loadEnvFile } from "node:process";
import { configVariable, defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
// import "@nomicfoundation/hardhat-verify";
// import "@openzeppelin/hardhat-upgrades";

loadEnvFile("./../.env");

export default defineConfig({
  plugins: [hardhatToolboxViem],
  paths: {
    tests: "tests",
  },
  solidity: {
    version: "0.8.28",
    npmFilesToBuild: [
      "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol",
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol",
      "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol",
    ],
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    default: {
      type: "edr-simulated",
      mining: {
        auto: true,
      },
      initialDate: "2025-11-23",
    },
    localhost: {
      type: "http",
      url: "http://127.0.0.1:8545",
    },
    production: {
      type: "http",
      url: configVariable("ETH_NODE_ADDRESS"),
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
