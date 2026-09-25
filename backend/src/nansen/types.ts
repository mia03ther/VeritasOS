/** Consumed subset of official Profiler schemas. See docs/nansen-api.md. */
export interface NansenPage<T> {
  pagination: { page: number; per_page: number; is_last_page: boolean };
  data: T[];
}
export interface NansenBalance {
  chain: string;
  address: string;
  token_address: string;
  token_symbol: string;
  value_usd?: number | null;
}
export interface NansenTransaction {
  chain: string;
  transaction_hash: string;
  block_timestamp: string;
  method: string;
  source_type: string;
}
export interface RawIntelligence {
  balances: NansenPage<NansenBalance>;
  transactions: NansenPage<NansenTransaction>;
}
