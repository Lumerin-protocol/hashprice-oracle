import type { NetworkConnection } from "hardhat/types";

export async function deployHashpriceUSDFixture(conn: NetworkConnection) {
  const { viem } = conn;
  const [owner] = await viem.getWalletClients();
  const pc = await viem.getPublicClient();
  const tc = await viem.getTestClient();

  const hashpriceMock = await viem.deployContract("BTCUSDMock", []);
  const btcUsdMock = await viem.deployContract("BTCUSDMock", []);

  // hashprice ≈ 3200 sats (0.00003200 BTC) with 8 decimals
  await hashpriceMock.write.setPrice([3200n]);
  // BTC/USD ≈ $84,524.20 with 8 decimals
  await btcUsdMock.write.setPrice([8_452_420_000_000n]);

  const hashpriceUSD = await viem.deployContract("HashpriceUSD", [
    hashpriceMock.address as `0x${string}`,
    btcUsdMock.address as `0x${string}`,
  ]);

  return {
    viem,
    contracts: { hashpriceUSD, hashpriceMock, btcUsdMock },
    accounts: { owner, pc, tc },
  };
}
