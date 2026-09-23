/**
 * Nansen Adapter — runtime onchain intelligence integration.
 *
 * This is the primary data source for the Agent Trust Intelligence feature.
 * It queries the Nansen API for wallet profiling, entity labels, token flows,
 * and portfolio data, then normalizes these into structured intelligence that
 * the trust assessment engine consumes.
 *
 * DESIGN PRINCIPLES:
 * - Clean abstraction: no raw Nansen payloads leak out
 * - Explicit configuration errors: missing API key throws immediately
 * - Graceful degradation: individual query failures don't block the assessment
 * - No fabrication: if Nansen returns nothing, we return nothing
 * - No model training: data is used for runtime assessment only
 */

import type {
  NansenConfig,
  NansenWalletProfile,
  NansenWalletPortfolio,
  NansenTokenFlows,
  NansenApiError,
} from "./types.js";

// ── Normalized output types ───────────────────────────────────────────────

/** A normalized entity label derived from Nansen intelligence. */
export interface DerivedEntitySummary {
  /** Primary entity type classification */
  type: string;
  /** Human-readable label */
  label: string;
  /** Whether Nansen recognized this as a known entity */
  isKnownEntity: boolean;
}

/** Normalized wallet activity summary from Nansen. */
export interface DerivedWalletActivity {
  /** Days since first onchain activity (0 if unknown) */
  accountAgeDays: number;
  /** Days since last onchain activity (Infinity if unknown) */
  daysSinceLastActive: number;
  /** Transaction count in the last 30 days (0 if unknown) */
  txCount30d: number;
  /** Distinct token count (0 if unknown) */
  tokenCount: number;
  /** Total portfolio value in USD (0 if unknown) */
  totalValueUsd: number;
  /** 30-day inflow value in USD (0 if unknown) */
  inflow30dUsd: number;
  /** 30-day outflow value in USD (0 if unknown) */
  outflow30dUsd: number;
}

/** The full normalized intelligence packet from Nansen. */
export interface NansenIntelligence {
  /** The queried wallet address */
  walletAddress: string;
  /** Entity summary derived from Nansen labels */
  entitySummary: DerivedEntitySummary;
  /** Activity metrics derived from Nansen wallet data */
  activity: DerivedWalletActivity;
  /** Which Nansen endpoints were successfully queried */
  dataSources: string[];
  /** Timestamp of this intelligence query */
  queriedAt: string;
}

// ── Adapter ───────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = "https://api.nansen.ai/v1";

export class NansenAdapter {
  private readonly config: NansenConfig;

  constructor(
    apiKey?: string,
    baseUrl?: string,
    timeoutMs?: number,
  ) {
    const key = apiKey ?? process.env.NANSEN_API_KEY ?? "";
    const url = baseUrl ?? process.env.NANSEN_BASE_URL ?? DEFAULT_BASE_URL;
    const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!key.trim()) {
      throw new Error(
        "NANSEN_API_KEY is required for Nansen intelligence queries. " +
        "Set the NANSEN_API_KEY environment variable or pass apiKey to the constructor."
      );
    }

    this.config = { apiKey: key, baseUrl: url, timeoutMs: timeout };
  }

  // ── Private: raw API calls ─────────────────────────────────────────────

  private async query<T>(
    endpoint: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const url = new URL(`${this.config.baseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": this.config.apiKey,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorBody = "";
        try {
          const parsed = await response.json() as NansenApiError;
          errorBody = parsed.message ?? "";
        } catch {
          errorBody = await response.text().catch(() => "");
        }
        throw new Error(
          `Nansen API error ${response.status}: ${errorBody.slice(0, 200)}`
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Nansen API error")) {
        throw error;
      }
      const timedOut =
        error instanceof DOMException && error.name === "AbortError";
      throw new Error(
        `Nansen request ${timedOut ? "timed out" : "failed"}: ${error instanceof Error ? error.message : "unknown error"}`
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Public: individual queries ─────────────────────────────────────────

  /** Query wallet profile from Nansen (labels, activity, value). */
  async getWalletProfile(
    walletAddress: string,
  ): Promise<NansenWalletProfile> {
    return this.query<NansenWalletProfile>(
      `/wallet/${walletAddress.toLowerCase()}/profile`,
    );
  }

  /** Query wallet portfolio from Nansen (token balances, total value). */
  async getWalletPortfolio(
    walletAddress: string,
  ): Promise<NansenWalletPortfolio> {
    return this.query<NansenWalletPortfolio>(
      `/wallet/${walletAddress.toLowerCase()}/portfolio`,
    );
  }

  /** Query 30-day token flows for a wallet. */
  async getTokenFlows(
    walletAddress: string,
  ): Promise<NansenTokenFlows> {
    return this.query<NansenTokenFlows>(
      `/wallet/${walletAddress.toLowerCase()}/flows`,
      { window: "30d" },
    );
  }

  // ── Public: normalized intelligence ─────────────────────────────────────

  /**
   * Get full normalized intelligence for a wallet address.
   *
   * Queries multiple Nansen endpoints and normalizes the results into a
   * structured intelligence packet. Individual failures are recorded but
   * do not block the overall result — partial intelligence is better than
   * none, and the trust engine handles missing data explicitly.
   */
  async getIntelligence(
    walletAddress: string,
  ): Promise<NansenIntelligence> {
    const wallet = walletAddress.toLowerCase();
    const dataSources: string[] = [];
    const now = Date.now();

    // Default values for graceful degradation
    let entitySummary: DerivedEntitySummary = {
      type: "unknown",
      label: "Unknown",
      isKnownEntity: false,
    };
    let activity: DerivedWalletActivity = {
      accountAgeDays: 0,
      daysSinceLastActive: Infinity,
      txCount30d: 0,
      tokenCount: 0,
      totalValueUsd: 0,
      inflow30dUsd: 0,
      outflow30dUsd: 0,
    };

    // 1. Wallet profile (labels + activity)
    try {
      const profile = await this.getWalletProfile(wallet);
      dataSources.push("nansen:wallet-profile");

      // Derive entity summary from labels
      if (profile.labels && profile.labels.length > 0) {
        const primary = profile.labels[0];
        entitySummary = {
          type: primary.type ?? "unknown",
          label: primary.label ?? "Unknown",
          isKnownEntity: primary.type !== "eoa" && primary.type !== "unknown",
        };
      }

      // Derive activity metrics
      activity.txCount30d = profile.txCount30d ?? 0;
      activity.tokenCount = profile.tokenCount ?? 0;
      activity.totalValueUsd = profile.totalValueUsd ?? 0;

      if (profile.firstActiveAt) {
        const firstActiveMs =
          typeof profile.firstActiveAt === "number"
            ? profile.firstActiveAt * 1000
            : Date.parse(String(profile.firstActiveAt));
        if (Number.isFinite(firstActiveMs)) {
          activity.accountAgeDays = Math.max(
            0,
            Math.floor((now - firstActiveMs) / 86_400_000),
          );
        }
      }

      if (profile.lastActiveAt) {
        const lastActiveMs =
          typeof profile.lastActiveAt === "number"
            ? profile.lastActiveAt * 1000
            : Date.parse(String(profile.lastActiveAt));
        if (Number.isFinite(lastActiveMs)) {
          activity.daysSinceLastActive = Math.max(
            0,
            (now - lastActiveMs) / 86_400_000,
          );
        }
      }
    } catch {
      // Profile unavailable — defaults remain
    }

    // 2. Token flows (30-day inflow/outflow)
    try {
      const flows = await this.getTokenFlows(wallet);
      dataSources.push("nansen:token-flows");
      activity.inflow30dUsd = flows.totalInflowUsd ?? 0;
      activity.outflow30dUsd = flows.totalOutflowUsd ?? 0;
    } catch {
      // Flows unavailable — defaults remain
    }

    return {
      walletAddress: wallet,
      entitySummary,
      activity,
      dataSources,
      queriedAt: new Date(now).toISOString(),
    };
  }
}
