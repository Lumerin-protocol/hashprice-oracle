import { parseUnits } from "viem/utils";
import { BitcoinClient } from "./bitcoin";
import { FileCache } from "./cache";
import type { Logger } from "pino";

const DIFFICULTY_TO_HASHRATE_FACTOR = 2n ** 32n;

export class RewardCalculator {
  private readonly bitcoinClient: BitcoinClient;
  private readonly cache: FileCache;

  constructor(bitcoinClient: BitcoinClient, cache: FileCache) {
    this.bitcoinClient = bitcoinClient;
    this.cache = cache;
  }

  async getIndex(nblocks = 144): Promise<number> {
    const lastBlock = await this.bitcoinClient.getBlockchainInfo();
    const hashrate = 10 ** 15;
    const secondsPerDay = 60 * 60 * 24;
    const averageTxFees = await this.getAverageFee(nblocks, lastBlock.blocks);
    const blockStats = await this.getBlockDataCached(lastBlock.blocks);
    const blocksPerDay =
      (hashrate * secondsPerDay) / lastBlock.difficulty / Number(DIFFICULTY_TO_HASHRATE_FACTOR);
    const btcPerDay = (blocksPerDay * (Number(averageTxFees) + blockStats.subsidy)) / 10 ** 8;
    return btcPerDay;
  }

  async getLastIndexData(nblocks = 144) {
    const lastBlock = await this.bitcoinClient.getBlockchainInfo();
    const averageTxFees = await this.getAverageFee(nblocks, lastBlock.blocks);
    const lastBlockData = await this.getBlockDataCached(lastBlock.blocks);
    const hashesPerBlock = BigInt(
      Math.round(lastBlock.difficulty * Number(DIFFICULTY_TO_HASHRATE_FACTOR))
    );
    const hashesForBTC = hashesPerBlock / (averageTxFees + BigInt(lastBlockData.subsidy));
    return {
      blockNumber: lastBlock.blocks,
      subsidy: lastBlockData.subsidy,
      totalfee: lastBlockData.totalfee,
      difficulty: lastBlock.difficulty,
      averageTxFees,
      hashesPerBlock,
      hashesForBTC,
    };
  }

  async getAverageFee(nblocks = 144, lastBlockNumber: number): Promise<bigint> {
    let totalFee = 0n;
    for (let i = 0; i < nblocks; i++) {
      const blockNumber = lastBlockNumber - i;
      const blockData = await this.getBlockDataCached(blockNumber);
      totalFee += BigInt(blockData.totalfee);
    }
    return totalFee / BigInt(nblocks);
  }

  async getBlockDataCached(height: number) {
    const data = this.cache.get(height.toString());
    if (data) {
      const [subsidy, totalfee] = data;
      return {
        height,
        subsidy,
        totalfee,
      };
    }
    const blockStats = await this.bitcoinClient.getBlockStats(height);
    this.cache.set(height.toString(), [blockStats.subsidy, blockStats.totalfee]);
    return {
      blockNumber: height,
      subsidy: blockStats.subsidy,
      totalfee: blockStats.totalfee,
    };
  }

  async calculateAvgHashesPerBlock(nblocks = 144): Promise<bigint> {
    const lastBlockNumber = await this.bitcoinClient.getBlockCount();
    const lastBlock = await this.bitcoinClient.getBlockHeader(
      await this.bitcoinClient.getBlockHash(lastBlockNumber)
    );
    const firstBlock = await this.bitcoinClient.getBlockHeader(
      await this.bitcoinClient.getBlockHash(lastBlockNumber - nblocks)
    );
    const avgBlockTime = (lastBlock.time - firstBlock.time) / nblocks;

    const targetBlockTime = 600;

    // Scale the theoretical hashes per block by how the observed block time compares
    // to Bitcoin's 10 minute target so temporary slow/fast periods adjust proportionally.
    const avgHashesPerBlock =
      lastBlock.difficulty *
      Number(DIFFICULTY_TO_HASHRATE_FACTOR) *
      (targetBlockTime / avgBlockTime);

    return BigInt(Math.round(avgHashesPerBlock));
  }

  async calculateNetworkHashPS(nblocks = 144): Promise<bigint> {
    const lastBlockNumber = await this.bitcoinClient.getBlockCount();
    const lastBlock = await this.bitcoinClient.getBlockHeader(
      await this.bitcoinClient.getBlockHash(lastBlockNumber)
    );
    const firstBlock = await this.bitcoinClient.getBlockHeader(
      await this.bitcoinClient.getBlockHash(lastBlockNumber - nblocks)
    );
    const avgBlockTime = (lastBlock.time - firstBlock.time) / nblocks;
    const realizedHashrate =
      (lastBlock.difficulty * Number(DIFFICULTY_TO_HASHRATE_FACTOR)) / avgBlockTime;
    return BigInt(Math.round(realizedHashrate));
  }
}

type BlockStats = {
  blockNumber: number;
  subsidy: number;
  totalfee: number;
};
