import { keccak256, toUtf8Bytes } from "ethers";
import { NansenAdapter, type NansenIntelligence } from "./nansen/adapter.js";
import { getReputation, type ReputationSummary } from "./reputation.js";
import { TrustError } from "./trust-errors.js";
import { assessWithModel } from "./trust-model.js";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type Recommendation = "HIRE" | "DO_NOT_HIRE";
export interface TrustAssessmentInput { walletAddress: string; taskContext?: string; counterpartyRole?: string }
export interface TrustSignal { name: string; value: number | null; description: string; source: string }
export interface RiskFactor { name: string; severity: "info" | "warning" | "critical"; description: string }
export interface ModelAssessment {
  riskLevel: RiskLevel;
  recommendation: Recommendation;
  reasoning: string;
  keySignals: string[];
  caveat: string;
}
export interface TrustAssessment {
  walletAddress: string;
  riskLevel: RiskLevel;
  trustSignals: TrustSignal[];
  riskFactors: RiskFactor[];
  assessment: Omit<ModelAssessment, "riskLevel">;
  intelligence: NansenIntelligence;
  input: TrustAssessmentInput;
  model: { id: string; version: string; mode: "live" | "mock"; promptVersion: string };
  dataSources: string[];
  timestamp: string;
  verdictHash: string;
}

export function parseTrustInput(body: unknown): TrustAssessmentInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TrustError(400, "Expected JSON object with walletAddress");
  const input = body as Record<string, unknown>;
  if (typeof input.walletAddress !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input.walletAddress.trim())) {
    throw new TrustError(400, "walletAddress must be a valid EVM address");
  }
  for (const [name, limit] of [["taskContext", 4000], ["counterpartyRole", 100]] as const) {
    if (input[name] !== undefined && (typeof input[name] !== "string" || input[name].length > limit)) {
      throw new TrustError(400, `${name} must be a string of at most ${limit} characters`);
    }
  }
  return { walletAddress: input.walletAddress.trim().toLowerCase(),
    ...(input.taskContext !== undefined ? { taskContext: (input.taskContext as string).trim() } : {}),
    ...(input.counterpartyRole !== undefined ? { counterpartyRole: (input.counterpartyRole as string).trim() } : {}) };
}

/** Values are observations in their stated units, not fabricated trust scores. */
export function deriveSignals(intelligence: NansenIntelligence, reputation: ReputationSummary | null) {
  const a = intelligence.activity;
  const source = intelligence.dataSources[1];
  const signals: TrustSignal[] = [
    { name: "observedTransactions", value: a.observedTransactions, source,
      description: `${a.observedTransactions} distinct transactions in the returned 30-day sample; this is not wallet age.` },
    { name: "observedTokenCount", value: a.observedTokenCount, source: intelligence.dataSources[0],
      description: `${a.observedTokenCount} tokens in the returned balance sample; holdings do not establish reliability.` },
    { name: "observedValueUsd", value: a.observedValueUsd, source: intelligence.dataSources[0],
      description: a.observedValueUsd === null ? "No priced balances observed; valuation is unknown."
        : `Priced balances in this sample total USD ${a.observedValueUsd}; this is not a credit or trust score.` },
  ];
  const factors: RiskFactor[] = [{ name: "limitedScope", severity: "info",
    description: "Only one chain, 30 days and the first 100 rows per endpoint are queried. Wallet age, owner identity, labels and task ability are not established." }];
  if (!intelligence.coverage.transactionsComplete || !intelligence.coverage.balancesComplete) factors.push({
    name: "partialCoverage", severity: "warning", description: "Additional pages exist; observations are lower bounds, not complete totals." });
  if (a.unpricedTokenCount) factors.push({ name: "unpricedBalances", severity: "info", description: `${a.unpricedTokenCount} balance rows have no USD valuation.` });
  if (a.observedTransactions === 0) factors.push({ name: "limitedObservableHistory", severity: "warning",
    description: "No transactions returned in this window. This does not establish inactivity on other chains or fraud." });
  if (reputation) {
    signals.push({ name: "reputationReliability", value: reputation.recencyWeightedReliability,
      source: "veritasos-reputation", description: `${reputation.successes}/${reputation.totalJudged} judged deals succeeded in backend records.` });
    if (!reputation.totalJudged) factors.push({ name: "noRecordedDeals", severity: "warning", description: "No judged deals in the queried VeritasOS records." });
  } else factors.push({ name: "reputationUnavailable", severity: "warning", description: "Backend reputation was unavailable; no claim is made about prior deals." });
  if (intelligence.mode === "mock") factors.push({ name: "mockData", severity: "warning", description: "MOCK DATA: synthetic Nansen-shaped fixture; no live Nansen request was made." });
  return { signals, factors };
}

// Retain the existing sorted-key canonicalization and keccak256 scheme.
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  return value === undefined ? "null" : JSON.stringify(value);
}
export function hashAssessment(value: Omit<TrustAssessment, "verdictHash">): string {
  return keccak256(toUtf8Bytes(canonicalize(value)));
}

export async function assessTrust(input: TrustAssessmentInput, intelligence: NansenIntelligence,
  reputation: ReputationSummary | null): Promise<TrustAssessment> {
  input = parseTrustInput(input);
  const { signals, factors } = deriveSignals(intelligence, reputation);
  const { result, model } = await assessWithModel(input, intelligence, signals, factors);
  const { riskLevel, ...assessment } = result;
  const payload: Omit<TrustAssessment, "verdictHash"> = {
    walletAddress: input.walletAddress, input, intelligence, riskLevel, assessment, model,
    trustSignals: signals, riskFactors: factors,
    dataSources: [...intelligence.dataSources, ...(reputation ? ["veritasos-reputation"] : [])],
    timestamp: new Date().toISOString(),
  };
  return { ...payload, verdictHash: hashAssessment(payload) };
}

/** Single orchestration path for REST, frontend proxy and MCP. */
export async function runTrustAssessment(body: unknown): Promise<TrustAssessment> {
  const input = parseTrustInput(body);
  const intelligence = await new NansenAdapter().getIntelligence(input.walletAddress);
  let reputation: ReputationSummary | null = null;
  try { reputation = await getReputation(input.walletAddress); } catch { /* explicitly disclosed by deriveSignals */ }
  return assessTrust(input, intelligence, reputation);
}
