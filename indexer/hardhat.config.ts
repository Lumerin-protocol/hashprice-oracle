import { defineConfig } from "hardhat/config";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatNodeTestRunner from "@nomicfoundation/hardhat-node-test-runner";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import hardhatMatchstick from "hardhat-matchstick-ts";

export default defineConfig({
  solidity: {
    version: "0.8.28",
  },
  plugins: [hardhatNetworkHelpers, hardhatViem, hardhatMatchstick, hardhatNodeTestRunner],
  paths: {
    tests: {
      nodejs: "integration",
    },
  },
  matchstick: {
    subgraphYaml: "subgraph.yaml",
    schemaPath: "schema.graphql",
  },
  networks: {
    default: {
      type: "edr-simulated",
      allowUnlimitedContractSize: true,
      mining: {
        auto: true,
      },
      // The Bitcoin header fixtures are dated April 2026 and the oracle fixture moves the
      // EVM clock to just past the last header. evm_setNextBlockTimestamp only moves
      // forward, so genesis has to sit before them.
      initialDate: "2025-11-23",
      hardfork: "cancun",
      blockGasLimit: 100_000_000n,
    },
  },
});
