import { arbitrumSepolia, arbitrum, hardhat } from "viem/chains";

const chainMap = {
  [arbitrumSepolia.id]: arbitrumSepolia,
  [arbitrum.id]: arbitrum,
  [hardhat.id]: hardhat,
} as const;

export function getChain(chainId: number) {
  const chain = chainMap[chainId as keyof typeof chainMap];
  if (!chain) {
    throw new Error(`Chain with id ${chainId} not supported`);
  }
  return chain;
}
