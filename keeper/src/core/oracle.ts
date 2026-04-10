import type { Logger } from "pino";
import {
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HashpriceBTCAbi } from "../abi/HashpriceBTC.ts";
import type { KeeperConfig } from "../config.ts";
import { getChain } from "../config.ts";

export interface OracleState {
  chainHeight: number;
  chainTip: `0x${string}`;
  blockCount: number;
  lastSubmittedAt: number;
}

export interface PreparedBlock {
  header: `0x${string}`;
  coinbaseTx: `0x${string}`;
  merkleProof: `0x${string}`[];
}

function prefixed0x(s: string): `0x${string}` {
  return `0x${s.replace(/^0x/, "")}`;
}

export class OracleClient {
  private readonly pc: PublicClient;
  private readonly wc: WalletClient<Transport, Chain, Account>;
  private readonly address: `0x${string}`;
  private readonly log: Logger;

  constructor(config: KeeperConfig, log: Logger) {
    const chain = getChain(config.chainId);
    const transport = http(config.ethereumRpcUrl);
    const account = privateKeyToAccount(config.privateKey);

    this.pc = createPublicClient({ chain, transport, batch: { multicall: true } });
    this.wc = createWalletClient({ chain, transport, account });
    this.address = config.hashpriceBtcAddress;
    this.log = log.child({ component: "oracle" });
  }

  async getState(): Promise<OracleState> {
    const [stateResult, chainTip] = await Promise.all([
      this.pc.readContract({
        address: this.address,
        abi: HashpriceBTCAbi,
        functionName: "state",
      }),
      this.pc.readContract({
        address: this.address,
        abi: HashpriceBTCAbi,
        functionName: "chainTip",
      }),
    ]);

    return {
      chainHeight: stateResult[0],
      blockCount: stateResult[1],
      lastSubmittedAt: stateResult[4],
      chainTip,
    };
  }

  async submitBlock(block: PreparedBlock): Promise<`0x${string}`> {
    const { request } = await this.pc.simulateContract({
      address: this.address,
      abi: HashpriceBTCAbi,
      functionName: "submitBlock",
      args: [block.header, block.coinbaseTx, block.merkleProof],
      account: this.wc.account,
    });

    const hash = await this.wc.writeContract(request);
    this.log.info({ txHash: hash }, "submitBlock tx sent");

    const receipt = await this.pc.waitForTransactionReceipt({ hash });
    this.log.info(
      { txHash: hash, gasUsed: receipt.gasUsed.toString(), status: receipt.status },
      "submitBlock tx confirmed",
    );
    return hash;
  }

  async submitBlocks(ancestorHeight: number, blocks: PreparedBlock[]): Promise<`0x${string}`> {
    let headers = "";
    const coinbaseTxs: `0x${string}`[] = [];
    const merkleProofs: `0x${string}`[][] = [];

    for (const b of blocks) {
      headers += b.header.replace(/^0x/, "");
      coinbaseTxs.push(b.coinbaseTx);
      merkleProofs.push(b.merkleProof);
    }

    const { request } = await this.pc.simulateContract({
      address: this.address,
      abi: HashpriceBTCAbi,
      functionName: "submitBlocks",
      args: [ancestorHeight, prefixed0x(headers), coinbaseTxs, merkleProofs],
      account: this.wc.account,
    });

    const hash = await this.wc.writeContract(request);
    this.log.info({ txHash: hash, blockCount: blocks.length }, "submitBlocks tx sent");

    const receipt = await this.pc.waitForTransactionReceipt({ hash });
    this.log.info(
      { txHash: hash, gasUsed: receipt.gasUsed.toString(), status: receipt.status },
      "submitBlocks tx confirmed",
    );
    return hash;
  }

  prepareBlock(raw: {
    rawHeader: string;
    coinbaseStripped: string;
    merkleProof: string[];
  }): PreparedBlock {
    return {
      header: prefixed0x(raw.rawHeader),
      coinbaseTx: prefixed0x(raw.coinbaseStripped),
      merkleProof: raw.merkleProof.map((h) => prefixed0x(h)),
    };
  }
}
