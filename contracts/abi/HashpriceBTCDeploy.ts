export const HashpriceBTCDeployAbi = [
  {
    inputs: [],
    stateMutability: "nonpayable",
    type: "constructor",
  },
  {
    inputs: [],
    name: "AncestorNotInBuffer",
    type: "error",
  },
  {
    inputs: [],
    name: "ArrayLengthMismatch",
    type: "error",
  },
  {
    inputs: [],
    name: "BrokenChain",
    type: "error",
  },
  {
    inputs: [],
    name: "InsufficientData",
    type: "error",
  },
  {
    inputs: [],
    name: "InsufficientPoW",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidCoinbaseTx",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidHeaderLength",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidMerkleProof",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidRetarget",
    type: "error",
  },
  {
    inputs: [],
    name: "InvalidTimestamp",
    type: "error",
  },
  {
    inputs: [],
    name: "NotHeaviestChain",
    type: "error",
  },
  {
    inputs: [],
    name: "NotImplemented",
    type: "error",
  },
  {
    inputs: [],
    name: "UnexpectedDifficultyChange",
    type: "error",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "blockHash",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "uint32",
        name: "height",
        type: "uint32",
      },
      {
        indexed: false,
        internalType: "uint64",
        name: "fees",
        type: "uint64",
      },
    ],
    name: "BlockSubmitted",
    type: "event",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: "bytes32",
        name: "newTip",
        type: "bytes32",
      },
      {
        indexed: true,
        internalType: "uint32",
        name: "newHeight",
        type: "uint32",
      },
    ],
    name: "ChainReorg",
    type: "event",
  },
  {
    inputs: [],
    name: "BLOCK_BUFFER_SIZE",
    outputs: [
      {
        internalType: "uint32",
        name: "",
        type: "uint32",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "CONFIRMATION_DEPTH",
    outputs: [
      {
        internalType: "uint32",
        name: "",
        type: "uint32",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "EXPECTED_TIMESPAN",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "FEE_WINDOW",
    outputs: [
      {
        internalType: "uint32",
        name: "",
        type: "uint32",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "RETARGET_INTERVAL",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "chainTipHash",
    outputs: [
      {
        internalType: "bytes32",
        name: "",
        type: "bytes32",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "confirmedHeight",
    outputs: [
      {
        internalType: "uint32",
        name: "",
        type: "uint32",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [
      {
        internalType: "uint8",
        name: "",
        type: "uint8",
      },
    ],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [],
    name: "description",
    outputs: [
      {
        internalType: "string",
        name: "",
        type: "string",
      },
    ],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [],
    name: "feeRunningSum",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint80",
        name: "",
        type: "uint80",
      },
    ],
    name: "getRoundData",
    outputs: [
      {
        internalType: "uint80",
        name: "",
        type: "uint80",
      },
      {
        internalType: "int256",
        name: "",
        type: "int256",
      },
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
      {
        internalType: "uint80",
        name: "",
        type: "uint80",
      },
    ],
    stateMutability: "pure",
    type: "function",
  },
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      {
        internalType: "uint80",
        name: "roundId",
        type: "uint80",
      },
      {
        internalType: "int256",
        name: "answer",
        type: "int256",
      },
      {
        internalType: "uint256",
        name: "startedAt",
        type: "uint256",
      },
      {
        internalType: "uint256",
        name: "updatedAt",
        type: "uint256",
      },
      {
        internalType: "uint80",
        name: "answeredInRound",
        type: "uint80",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "state",
    outputs: [
      {
        internalType: "uint32",
        name: "chainHeight",
        type: "uint32",
      },
      {
        internalType: "uint32",
        name: "blockCount",
        type: "uint32",
      },
      {
        internalType: "uint32",
        name: "epochStartTimestamp",
        type: "uint32",
      },
      {
        internalType: "uint32",
        name: "epochStartNBits",
        type: "uint32",
      },
      {
        internalType: "uint32",
        name: "lastSubmittedAt",
        type: "uint32",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "bytes",
        name: "header",
        type: "bytes",
      },
      {
        internalType: "bytes",
        name: "coinbaseTx",
        type: "bytes",
      },
      {
        internalType: "bytes32[]",
        name: "merkleProof",
        type: "bytes32[]",
      },
    ],
    name: "submitBlock",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      {
        internalType: "uint32",
        name: "ancestorHeight",
        type: "uint32",
      },
      {
        internalType: "bytes",
        name: "headers",
        type: "bytes",
      },
      {
        internalType: "bytes[]",
        name: "coinbaseTxs",
        type: "bytes[]",
      },
      {
        internalType: "bytes32[][]",
        name: "merkleProofs",
        type: "bytes32[][]",
      },
    ],
    name: "submitBlocks",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "version",
    outputs: [
      {
        internalType: "uint256",
        name: "",
        type: "uint256",
      },
    ],
    stateMutability: "pure",
    type: "function",
  },
] as const;
