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
    const [rawHeader, block] = await Promise.all([
      this.rpc.getBlockHeader(hash, false),
      this.rpc.getBlock(hash),
    ]);

    const coinbaseTxid = block.tx[0];
    const coinbaseHex = await this.rpc.getRawTransaction(coinbaseTxid);
    const coinbaseStripped = stripWitness(coinbaseHex);
    const merkleProof = buildMerkleProof(block.tx);

    return { height, hash, rawHeader, coinbaseStripped, merkleProof };
  }

  async getBlockRange(startHeight: number, count: number): Promise<BlockData[]> {
    return Promise.all(Array.from({ length: count }, (_, i) => this.getBlockData(startHeight + i)));
  }

  async getBlockHash(height: number): Promise<string> {
    return this.rpc.getBlockHash(height);
  }
}
