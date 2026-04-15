export const BTCUSDMockAbi = [
  {
    type: "function",
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", internalType: "uint8", type: "uint8" }],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", internalType: "uint80", type: "uint80" },
      { name: "answer", internalType: "int256", type: "int256" },
      { name: "startedAt", internalType: "uint256", type: "uint256" },
      { name: "updatedAt", internalType: "uint256", type: "uint256" },
      { name: "answeredInRound", internalType: "uint80", type: "uint80" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    inputs: [{ name: "price", internalType: "int256", type: "int256" }],
    name: "setPrice",
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
