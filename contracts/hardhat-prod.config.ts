import base from "./hardhat.config.ts";
import { defineConfig } from "hardhat/config";

// #TODO put to default config content from base config and introduce a new config file hardhat-network.config.ts

if (!process.env.ETH_NODE_ADDRESS) {
  throw new Error("ETH_NODE_ADDRESS env variable is not set");
}

if (!process.env.DEPLOYER_PRIVATEKEY) {
  throw new Error("DEPLOYER_PRIVATEKEY env variable is not set");
}

if (!process.env.ETHERSCAN_API_KEY) {
  throw new Error("ETHERSCAN_API_KEY env variable is not set");
}

export default defineConfig({
  ...base,
  networks: {
    ...base.networks,
    production: {
      type: "http",
      url: process.env.ETH_NODE_ADDRESS,
      accounts: [
        process.env.DEPLOYER_PRIVATEKEY!,
        ...(process.env.PROPOSER_PRIVATEKEY ? [process.env.PROPOSER_PRIVATEKEY] : []),
      ],
      gasPrice: "auto",
      gas: "auto",
    },
  },

  verify: {
    etherscan: {
      apiKey: process.env.ETHERSCAN_API_KEY!,
      enabled: true,
    },
  },
});
