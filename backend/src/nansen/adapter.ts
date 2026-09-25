import { TrustError } from "../trust-errors.js";
import type { NansenBalance, NansenPage, NansenTransaction, RawIntelligence } from "./types.js";

export interface NansenIntelligence {
  walletAddress: string;
  chain: string;
  mode: "live" | "mock";
  window: { from: string; to: string };
  activity: {
    observedTransactions: number;
    latestObservedAt: string | null;
    observedTokenCount: number;
    observedValueUsd: number | null;
    unpricedTokenCount: number;
  };
  coverage: { transactionsComplete: boolean; balancesComplete: boolean; pageSize: number };
  dataSources: string[];
  queriedAt: string;
}

function page<T>(raw: unknown, valid: (row: any) => boolean): NansenPage<T> {
  const value = raw as NansenPage<T>;
  if (!value || !Array.isArray(value.data) || !value.pagination ||
      value.pagination.page !== 1 || !Number.isInteger(value.pagination.per_page) ||
      value.pagination.per_page < 1 || value.pagination.per_page > 100 || value.data.length > value.pagination.per_page ||
      typeof value.pagination.is_last_page !== "boolean" || !value.data.every(valid)) {
    throw new TrustError(502, "Nansen returned an invalid response schema");
  }
  return value;
}

/** Missing valuations stay unknown; a sampled page is never lifetime history. */
export function normalizeIntelligence(raw: RawIntelligence, walletAddress: string,
  chain: string, mode: "live" | "mock", window: NansenIntelligence["window"]): NansenIntelligence {
  const balances = page<NansenBalance>(raw.balances, row => row &&
    row.chain === chain && typeof row.address === "string" && row.address.toLowerCase() === walletAddress &&
    typeof row.token_address === "string" && typeof row.token_symbol === "string" &&
    (row.value_usd == null || (typeof row.value_usd === "number" && Number.isFinite(row.value_usd) && row.value_usd >= 0)));
  const transactions = page<NansenTransaction>(raw.transactions, row => row &&
    row.chain === chain && typeof row.transaction_hash === "string" &&
    typeof row.method === "string" && typeof row.source_type === "string" &&
    typeof row.block_timestamp === "string" && Number.isFinite(Date.parse(row.block_timestamp)) &&
    Date.parse(row.block_timestamp) >= Date.parse(window.from) && Date.parse(row.block_timestamp) <= Date.parse(window.to));
  const priced = balances.data.filter(row => row.value_usd != null);
  const observedValueUsd = priced.length ? priced.reduce((sum, row) => sum + row.value_usd!, 0) : null;
  if (observedValueUsd !== null && !Number.isFinite(observedValueUsd)) throw new TrustError(502, "Nansen balance total exceeds numeric range");
  const prefix = mode === "mock" ? "mock:nansen" : "nansen";
  return {
    walletAddress, chain, mode, window,
    activity: {
      observedTransactions: new Set(transactions.data.map(row => row.transaction_hash)).size,
      latestObservedAt: transactions.data.length
        ? new Date(Math.max(...transactions.data.map(row => Date.parse(row.block_timestamp)))).toISOString() : null,
      observedTokenCount: new Set(balances.data.map(row => row.token_address)).size,
      observedValueUsd,
      unpricedTokenCount: balances.data.length - priced.length,
    },
    coverage: { transactionsComplete: transactions.pagination.is_last_page,
      balancesComplete: balances.pagination.is_last_page, pageSize: 100 },
    dataSources: [`${prefix}:profiler/address/current-balance`, `${prefix}:profiler/address/transactions`],
    queriedAt: window.to,
  };
}

export class NansenAdapter {
  constructor(private readonly apiKey = process.env.NANSEN_API_KEY ?? "",
    private readonly baseUrl = process.env.NANSEN_BASE_URL ?? "https://api.nansen.ai/api/v1",
    private readonly timeoutMs = 10_000) {}

  private async query(endpoint: string, body: object): Promise<unknown> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/profiler/address/${endpoint}`, {
        method: "POST", headers: { "Content-Type": "application/json", apikey: this.apiKey },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) throw new TrustError(502, `Nansen provider failed (HTTP ${response.status})`);
      return await response.json();
    } catch (error) {
      if (error instanceof TrustError) throw error;
      throw new TrustError(502, "Nansen request failed, timed out, or returned invalid JSON");
    }
  }

  async getIntelligence(walletAddress: string): Promise<NansenIntelligence> {
    const mode = process.env.MOCK_NANSEN === "true" ? "mock" : "live";
    if (mode === "live" && !this.apiKey.trim()) throw new TrustError(500, "NANSEN_API_KEY is not configured");
    // These EVM chains are supported by both selected official endpoints.
    const chain = process.env.NANSEN_CHAIN ?? "monad";
    if (chain !== "monad" && chain !== "ethereum") throw new TrustError(500, "NANSEN_CHAIN must be monad or ethereum");
    const now = Date.now();
    const window = { from: new Date(now - 30 * 86_400_000).toISOString(), to: new Date(now).toISOString() };
    const request = { address: walletAddress, chain, hide_spam_token: true, pagination: { page: 1, per_page: 100 } };
    let raw: RawIntelligence;
    if (mode === "mock") {
      // Offline fixture, independent of real wallet identity. No provider was called.
      const pagination = { page: 1, per_page: 100, is_last_page: true };
      raw = {
        balances: { pagination, data: [{ chain, address: walletAddress, token_address: "mock-token", token_symbol: "MOCK", value_usd: 100 }] },
        transactions: { pagination, data: [{ chain, transaction_hash: "mock-transaction", block_timestamp: window.to, method: "received", source_type: "mock" }] },
      };
    } else {
      const [balances, transactions] = await Promise.all([
        this.query("current-balance", request),
        this.query("transactions", { ...request, date: window, order_by: [{ field: "block_timestamp", direction: "DESC" }] }),
      ]);
      raw = { balances, transactions } as RawIntelligence;
    }
    return normalizeIntelligence(raw, walletAddress, chain, mode, window);
  }
}
