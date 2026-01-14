export class Coingecko {
  private readonly apiURL =
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

  async getBTCUSDExchangeRate(): Promise<number> {
    const response = await fetch(this.apiURL);
    const data = await response.json();
    return data.bitcoin.usd;
  }
}
