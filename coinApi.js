// coinApi.js
import axios from "axios";

export class CoinAPI {
  constructor({ baseURL, timeout }) {
    this.client = axios.create({
      baseURL,
      timeout: timeout || 12000
    });
  }

  // cooldown de 1s entre pagamentos
  static async throttle1s() {
    await new Promise(r => setTimeout(r, 1000));
  }

  async payFromCard({ cardCode, toId, amount }) {
    const res = await this.client.post("/api/transfer/card", {
      cardCode,
      toId,
      amount
    });
    if (!res.data.success) {
      throw new Error("CoinAPI: pagamento falhou");
    }
    return res.data; // retorna { success, txId, date }
  }
}
