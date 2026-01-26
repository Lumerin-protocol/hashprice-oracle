import { fetchWithRetry } from "./fetch-retry";

export class Coingecko {
  private readonly apiURL =
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

  async getBTCUSDExchangeRate(): Promise<number> {
    const response = await fetchWithRetry(this.apiURL, {}, "CoinGecko price");

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Failed to parse CoinGecko response (status ${response.status}): ${text.substring(0, 500)}`
      );
    }

    if (!data.bitcoin?.usd) {
      throw new Error(`Unexpected CoinGecko response format: ${text.substring(0, 500)}`);
    }

    return data.bitcoin.usd;
  }
}
