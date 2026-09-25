import * as dotenv from "dotenv";
dotenv.config();

import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { defineConfig, configVariable } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
      },
      production: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    monadTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 10143,
      url: configVariable("MONAD_RPC_URL"),
      accounts: [configVariable("MONAD_PRIVATE_KEY")],
    },
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    arcTestnet: {
      type: "http",
      chainType: "l1",
      url: "https://rpc.testnet.arc.network",
      chainId: 5042002,
      accounts: process.env.ARC_PRIVATE_KEY ? [process.env.ARC_PRIVATE_KEY] : [],
    }
  },
});
