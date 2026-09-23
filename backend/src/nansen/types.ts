/**
 * Nansen API types — defines the shapes that Nansen actually returns.
 *
 * Nansen provides onchain intelligence including wallet profiling,
 * token flow analysis, and entity labeling. We define only the fields
 * we actually consume for trust assessment.
 *
 * IMPORTANT: These types reflect the current Nansen API as documented.
 * Do not add fields that Nansen does not return.
 */

/** A labeled entity from Nansen's entity recognition system. */
export interface NansenEntityLabel {
  /** Entity type: e.g. "exchange", "defi", "mev", "eoa", "contract", "unknown" */
  type: string;
  /** Human-readable label, e.g. "Binance", "Uniswap V3 Router" */
  label: string;
  /** Confidence score 0-1 where available */
  confidence?: number;
}

/** Wallet summary returned by Nansen's wallet profiling endpoint. */
export interface NansenWalletProfile {
  /** The queried wallet address */
  address: string;
  /** Entity labels assigned by Nansen */
  labels: NansenEntityLabel[];
  /** Total portfolio value in USD (if available) */
  totalValueUsd?: number;
  /** Number of distinct tokens held */
  tokenCount?: number;
  /** First onchain activity timestamp (ISO string or Unix seconds) */
  firstActiveAt?: string | number;
  /** Most recent onchain activity timestamp */
  lastActiveAt?: string | number;
  /** Number of transactions in the lookback window */
  txCount30d?: number;
}

/** Token balance from Nansen's portfolio endpoint. */
export interface NansenTokenBalance {
  tokenAddress: string;
  symbol: string;
  balance: string;
  valueUsd?: number;
}

/** Wallet portfolio from Nansen. */
export interface NansenWalletPortfolio {
  address: string;
  tokens: NansenTokenBalance[];
  totalValueUsd?: number;
}

/** Token flow direction from Nansen's flow analysis. */
export interface NansenTokenFlow {
  tokenAddress: string;
  symbol: string;
  direction: "in" | "out";
  amount: string;
  valueUsd?: number;
  counterpartyAddress: string;
  counterpartyLabel?: string;
  timestamp: string | number;
}

/** Aggregated token flows for a wallet. */
export interface NansenTokenFlows {
  address: string;
  flows: NansenTokenFlow[];
  totalInflowUsd?: number;
  totalOutflowUsd?: number;
}

/** Error shape from Nansen API. */
export interface NansenApiError {
  status: number;
  message: string;
}

/** Configuration for the Nansen adapter. */
export interface NansenConfig {
  /** Nansen API key (required for live queries) */
  apiKey: string;
  /** Base URL for the Nansen API */
  baseUrl: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}
