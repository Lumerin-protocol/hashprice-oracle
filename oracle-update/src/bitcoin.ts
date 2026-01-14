export class BitcoinClient {
  private readonly rpcUrl: string;
  private requestId = 0;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  async getBlockCount(): Promise<number> {
    return await this.request<number>("getblockcount", []);
  }

  async getBlockHash(blockNumber: number): Promise<string> {
    return await this.request<string>("getblockhash", [blockNumber]);
  }

  async getBlock(blockHash: string): Promise<GetBlockRes> {
    return await this.request<GetBlockRes>("getblock", [blockHash]);
  }

  async getBlockHeader(blockHash: string): Promise<GetBlockHeaderRes> {
    return await this.request<GetBlockHeaderRes>("getblockheader", [blockHash]);
  }

  async getBlockStats(blockHashOrHeight: string | number) {
    return await this.request<{
      subsidy: number;
      totalfee: number;
    }>("getblockstats", [blockHashOrHeight, ["subsidy", "totalfee"]]);
  }

  async getBlockchainInfo(): Promise<GetBlockchainInfoRes> {
    return await this.request<GetBlockchainInfoRes>("getblockchaininfo", []);
  }

  async getRawTransaction(txid: string): Promise<GetRawTransactionRes> {
    return await this.request<GetRawTransactionRes>("getrawtransaction", [txid, true]);
  }

  private async request<R>(method: string, params: any[]): Promise<R> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "1.0", id: this.requestId++, method, params }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error.message);
    }
    return data.result as R;
  }
}

type GetBlockRes = {
  height: number;
  time: number; // epoch
  difficulty: number;
  tx: string[];
};

type GetBlockchainInfoRes = {
  blocks: number;
  difficulty: number;
  time: number;
  bestblockhash: string;
};

type GetBlockHeaderRes = {
  hash: string;
  confirmations: number;
  height: number;
  version: number;
  versionHex: string;
  merkleroot: string;
  time: number;
  mediantime: number;
  nonce: number;
  bits: string;
  difficulty: number;
  chainwork: string;
  nTx: number;
  previousblockhash: string;
  nextblockhash: string;
};

type GetRawTransactionRes = {
  vout: {
    value: number;
  }[];
};
