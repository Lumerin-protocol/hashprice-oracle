import { viem } from "hardhat";
import { parseUnits, maxUint256, encodeFunctionData } from "viem";

export async function deployTokenOraclesAndMulticall3() {
  // Get wallet clients
  const [owner, user] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  // Deploy USDC Mock (for payments)
  const _usdcMock = await viem.deployContract("contracts/USDCMock.sol:USDCMock", []);
  const usdcMock = await getIERC20Metadata(_usdcMock.address as `0x${string}`);

  // Deploy BTC Price Oracle Mock
  const btcPriceOracleMock = await viem.deployContract(
    "contracts/BTCPriceOracleMock.sol:BTCPriceOracleMock",
    [],
  );

  const btcPriceOracleDecimals = await btcPriceOracleMock.read.decimals();

  // Top up buyer with tokens

  const oracle = (() => {
    const BITCOIN_DECIMALS = 8;
    const USDC_DECIMALS = 6;
    const DIFFICULTY_TO_HASHRATE_FACTOR = 2n ** 32n;

    const btcPrice = parseUnits("84524.2", btcPriceOracleDecimals);
    const blockReward = parseUnits("3.125", BITCOIN_DECIMALS);
    const difficulty = 121n * 10n ** 12n;
    const hashesForBTC = (difficulty * DIFFICULTY_TO_HASHRATE_FACTOR) / blockReward;
    return {
      btcPrice,
      blockReward,
      difficulty,
      decimals: USDC_DECIMALS,
      hashesForBTC,
    };
  })();

  await btcPriceOracleMock.write.setPrice([oracle.btcPrice]);

  // Deploy HashrateOracle
  const hashrateOracleImpl = await viem.deployContract(
    "contracts/HashrateOracle.sol:HashrateOracle",
    [btcPriceOracleMock.address as `0x${string}`, await _usdcMock.read.decimals()],
  );
  const hashrateOracleProxy = await viem.deployContract(
    "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    [
      hashrateOracleImpl.address as `0x${string}`,
      encodeFunctionData({
        abi: hashrateOracleImpl.abi,
        functionName: "initialize",
        args: [],
      }),
    ],
  );
  const hashrateOracle = await viem.getContractAt("HashrateOracle", hashrateOracleProxy.address);

  await hashrateOracle.write.setTTL([maxUint256, maxUint256]);
  await hashrateOracle.write.setUpdaterAddress([owner.account.address]);
  await hashrateOracle.write.setHashesForBTC([oracle.hashesForBTC]);

  return {
    config: {
      oracle,
    },
    contracts: {
      usdcMock,
      btcPriceOracleMock,
      hashrateOracle,
    },
    accounts: {
      owner,
      user,
      pc,
      tc,
    },
  };
}

function getIERC20(addr: `0x${string}`) {
  return viem.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", addr);
}

function getIERC20Metadata(addr: `0x${string}`) {
  return viem.getContractAt(
    "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol:IERC20Metadata",
    addr,
  );
}

type IERC20 = Awaited<ReturnType<typeof getIERC20>>;
type IERC20Metadata = Awaited<ReturnType<typeof getIERC20Metadata>>;
