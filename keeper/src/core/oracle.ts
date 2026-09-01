import type { Logger } from "pino";
import {
  type Account,
  type Chain,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HashpriceBTCAbi } from "../abi/HashpriceBTC.ts";
import { getChain } from "../config.ts";
import type { Config } from "../config.ts";

export interface OracleState {
  chainHeight: number;
  chainTipHash: `0x${string}`;
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

/**
 * Heuristic match for the family of "RPC node hasn't ingested this block yet"
 * errors thrown by load-balanced public providers (Alchemy/Infura/QuickNode).
 * The exact phrasing varies per provider:
 *   - Alchemy: "Unknown block" / "unknown block"
 *   - Infura:  "header not found"
 *   - geth:    "header for hash not found", "missing trie node"
 *   - generic: "block not found", "requested block ... not found", "block ... does not exist"
 *
 * Walks the cause chain because viem wraps the underlying RpcRequestError
 * inside CallExecutionError -> ContractFunctionExecutionError, and the
 * provider-specific text only appears at the leaves.
 */
function isStaleBlockError(err: unknown): boolean {
  const pattern =
    /unknown block|block not found|header(?: for hash)? not found|missing trie|requested block.*not found|block.*does not exist/i;

  let current: unknown = err;
  for (let i = 0; i < 8 && current; i++) {
    if (current instanceof Error) {
      if (pattern.test(`${current.name} ${current.message}`)) return true;
      current = (current as { cause?: unknown }).cause;
    } else {
      return pattern.test(String(current));
    }
  }
  return false;
}

export class OracleClient {
  private readonly pc: PublicClient;
  private readonly wc: WalletClient<Transport, Chain, Account>;
  private readonly address: `0x${string}`;
  private readonly log: Logger;
  private readonly confirmations: number;
  private blockBufferSize?: number;

  constructor(config: Config, log: Logger) {
    const chain = getChain(config.chainId);
    const transport = http(config.ethereumRpcUrl);
    const account = privateKeyToAccount(config.privateKey);

    this.pc = createPublicClient({ chain, transport, batch: { multicall: true } });
    this.wc = createWalletClient({ chain, transport, account });
    this.address = config.hashpriceBtcAddress;
    this.log = log.child({ component: "oracle" });
    this.confirmations = config.confirmations;
  }

  /**
   * Reads getBlockFromTip(index). Pass `minBlock` (e.g. the previous write's
   * receipt.blockNumber) to guarantee the RPC node serving us has applied at
   * least that block — critical after a write to avoid stale reads from
   * load-balanced providers. Reads without `minBlock` use the node's `latest`.
   */
  async getBlockFromTip(
    index: number,
    minBlock?: bigint,
  ): Promise<{ blockHash: `0x${string}`; height: number }> {
    const entry = await this.readPinned(minBlock, (blockNumber) =>
      this.pc.readContract({
        address: this.address,
        abi: HashpriceBTCAbi,
        functionName: "getBlockFromTip",
        args: [index],
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      }),
    );
    return { blockHash: entry.blockHash, height: entry.height };
  }

  /**
   * Ring buffer size, read from the contract and cached for the process lifetime.
   * It is a compile-time constant on-chain, so one read is enough — and reading it
   * beats hardcoding a copy that silently goes stale when the contract changes.
   */
  async getBlockBufferSize(): Promise<number> {
    if (this.blockBufferSize === undefined) {
      this.blockBufferSize = await this.pc.readContract({
        address: this.address,
        abi: HashpriceBTCAbi,
        functionName: "BLOCK_BUFFER_SIZE",
      });
    }
    return this.blockBufferSize;
  }

  /** See `getBlockFromTip` for `minBlock` semantics. */
  async getState(minBlock?: bigint): Promise<OracleState> {
    const [stateResult, chainTipHash] = await Promise.all([
      this.readPinned(minBlock, (blockNumber) =>
        this.pc.readContract({
          address: this.address,
          abi: HashpriceBTCAbi,
          functionName: "state",
          ...(blockNumber !== undefined ? { blockNumber } : {}),
        }),
      ),
      this.readPinned(minBlock, (blockNumber) =>
        this.pc.readContract({
          address: this.address,
          abi: HashpriceBTCAbi,
          functionName: "chainTipHash",
          ...(blockNumber !== undefined ? { blockNumber } : {}),
        }),
      ),
    ]);

    return {
      chainHeight: stateResult[0],
      blockCount: stateResult[1],
      lastSubmittedAt: stateResult[4],
      chainTipHash,
    };
  }

  async submitBlock(block: PreparedBlock): Promise<TransactionReceipt> {
    const { request } = await this.pc.simulateContract({
      address: this.address,
      abi: HashpriceBTCAbi,
      functionName: "submitBlock",
      args: [block.header, block.coinbaseTx, block.merkleProof],
      account: this.wc.account,
    });

    const hash = await this.wc.writeContract(request);
    this.log.info({ txHash: hash }, "submitBlock tx sent");

    const receipt = await this.pc.waitForTransactionReceipt({
      hash,
      confirmations: this.confirmations,
    });
    this.log.info(
      { txHash: hash, gasUsed: receipt.gasUsed.toString(), status: receipt.status },
      "submitBlock tx confirmed",
    );
    return receipt;
  }

  async submitBlocks(ancestorHeight: number, blocks: PreparedBlock[]): Promise<TransactionReceipt> {
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
    this.log.debug({ txHash: hash, blockCount: blocks.length }, "submitBlocks tx sent");

    return this.pc.waitForTransactionReceipt({ hash, confirmations: this.confirmations });
  }

  /**
   * Runs `read(blockNumber)` pinned to `minBlock`, retrying with exponential
   * backoff if the RPC node serving us hasn't ingested that block yet
   * (typical of load-balanced providers like Alchemy/Infura). Any non-stale
   * error propagates immediately. When `minBlock` is undefined, runs a single
   * unpinned read against the node's `latest`.
   */
  private async readPinned<T>(
    minBlock: bigint | undefined,
    read: (blockNumber: bigint | undefined) => Promise<T>,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (minBlock === undefined) return read(undefined);

    const startedAt = Date.now();
    let delayMs = 100;
    while (true) {
      try {
        return await read(minBlock);
      } catch (err) {
        if (!isStaleBlockError(err)) throw err;
        if (Date.now() - startedAt > timeoutMs) {
          this.log.error(
            { minBlock: minBlock.toString(), timeoutMs, err },
            "RPC node did not catch up to required block within timeout",
          );
          throw err;
        }
        this.log.debug(
          { minBlock: minBlock.toString(), delayMs },
          "RPC node behind required block, retrying read",
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 2000);
      }
    }
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
