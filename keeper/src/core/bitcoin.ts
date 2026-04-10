import type { Logger } from "pino";
import { BitcoinRpc, buildMerkleProof, stripWitness } from "../lib.ts";

export interface BlockData {
  height: number;
  hash: string;
  rawHeader: string;
  coinbaseStripped: string;
  merkleProof: string[];
}

export class BitcoinProvider {
  private readonly rpc: BitcoinRpc;
  private readonly log: Logger;

  constructor(rpcUrl: string, log: Logger) {
    this.rpc = new BitcoinRpc(rpcUrl);
    this.log = log.child({ component: "bitcoin" });
  }

  async getTipHeight(): Promise<number> {
    return this.rpc.getBlockCount();
  }

  async getBlockData(height: number): Promise<BlockData> {
    const hash = await this.rpc.getBlockHash(height);
    const rawHeader = await this.rpc.getBlockHeader(hash, false);
    const block = await this.rpc.getBlock(hash);

    const coinbaseTxid = block.tx[0];
    const coinbaseHex = await this.rpc.getRawTransaction(coinbaseTxid);
    const coinbaseStripped = stripWitness(coinbaseHex);
    const merkleProof = buildMerkleProof(block.tx);

    this.log.debug({ height, hash, proofLen: merkleProof.length }, "fetched block data");

    return { height, hash, rawHeader, coinbaseStripped, merkleProof };
  }

  async getBlockRange(startHeight: number, count: number): Promise<BlockData[]> {
    const blocks: BlockData[] = [];
    for (let i = 0; i < count; i++) {
      blocks.push(await this.getBlockData(startHeight + i));
    }
    return blocks;
  }
}
