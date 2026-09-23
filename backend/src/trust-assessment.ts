/**
 * AI Trust Assessment Engine — derives trust signals and risk factors
 * from Nansen intelligence and VeritasOS reputation data, then produces
 * a structured HIRE / DO_NOT_HIRE assessment.
 *
 * This is the core decision layer that sits between raw onchain intelligence
 * (Nansen) and the agent-facing tools (MCP). It converts intelligence into
 * actionability.
 *
 * PRE-TRANSACTION: This module runs BEFORE a deal is created. It answers
 * "should I hire this agent?" based on available intelligence.
 *
 * POST-TRANSACTION: That is the AI Judge (ai-judge/), which evaluates
 * deliverables after work is submitted. These two are clearly separate.
 */

import { keccak256, toUtf8Bytes } from "ethers";
import type {
  NansenIntelligence,
  DerivedEntitySummary,
  DerivedWalletActivity,
} from "./nansen/adapter.js";
import type { ReputationSummary } from "./reputation.js";

// ── Types ─────────────────────────────────────────────────────────────────

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type Recommendation = "HIRE" | "DO_NOT_HIRE";

/** A derived trust signal with name, value, and interpretation. */
export interface TrustSignal {
  /** Signal name, e.g. "accountAge", "reputationSuccessRate" */
  name: string;
  /** Normalized value 0-1 (1 = most trustworthy) */
  value: number;
  /** Human-readable interpretation */
  description: string;
  /** Data source that produced this signal */
  source: string;
}

/** A risk factor identified during assessment. */
export interface RiskFactor {
  /** Factor name, e.g. "newAccount", "lowReputation" */
  name: string;
  /** Severity */
  severity: "info" | "warning" | "critical";
  /** Human-readable description */
  description: string;
}

/** The full trust assessment response. */
export interface TrustAssessment {
  /** The assessed wallet address */
  walletAddress: string;
  /** Overall risk level */
  riskLevel: RiskLevel;
  /** Derived trust signals (normalized 0-1) */
  trustSignals: TrustSignal[];
  /** Identified risk factors */
  riskFactors: RiskFactor[];
  /** The final recommendation */
  assessment: {
    recommendation: Recommendation;
    confidence: number;
    reasoning: string;
  };
  /** Entity summary from Nansen (if available) */
  entitySummary?: DerivedEntitySummary;
  /** Activity metrics from Nansen (if available) */
  activity?: DerivedWalletActivity;
  /** Reputation from VeritasOS (if available) */
  reputation?: {
    totalJudged: number;
    successRate: number;
    recencyWeightedReliability: number;
  };
  /** Data sources that contributed to this assessment */
  dataSources: string[];
  /** Assessment timestamp */
  timestamp: string;
  /** Deterministic verdict hash for auditability */
  verdictHash: string;
}

/** Input for the trust assessment. */
export interface TrustAssessmentInput {
  walletAddress: string;
  /** Optional task context for domain-specific signals */
  taskContext?: string;
  /** Optional counterparty role for context */
  counterpartyRole?: string;
}

// ── Signal derivation ─────────────────────────────────────────────────────

function deriveAccountAgeSignal(
  activity: DerivedWalletActivity,
): TrustSignal {
  const days = activity.accountAgeDays;
  // Trust grows with age: 0 days → 0, 30 days → 0.5, 90+ days → 1
  const value = Math.min(1, days / 90);
  return {
    name: "accountAge",
    value,
    description:
      days === 0
        ? "Account age unknown"
        : `Account ${days} days old`,
    source: "nansen",
  };
}

function deriveActivitySignal(
  activity: DerivedWalletActivity,
): TrustSignal {
  const txCount = activity.txCount30d;
  // Active accounts are more trustworthy: 0 tx → 0, 10 tx → 0.5, 30+ tx → 1
  const value = Math.min(1, txCount / 30);
  return {
    name: "recentActivity",
    value,
    description:
      txCount === 0
        ? "No recent activity data"
        : `${txCount} transactions in last 30 days`,
    source: "nansen",
  };
}

function derivePortfolioSignal(
  activity: DerivedWalletActivity,
): TrustSignal {
  const valueUsd = activity.totalValueUsd;
  // Portfolio depth indicates commitment: $0 → 0, $1k → 0.3, $10k → 0.7, $100k+ → 1
  let value = 0;
  if (valueUsd > 0) {
    value = Math.min(1, Math.log10(valueUsd + 1) / 5);
  }
  return {
    name: "portfolioDepth",
    value,
    description:
      valueUsd === 0
        ? "Portfolio value unknown"
        : `Portfolio value: $${valueUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    source: "nansen",
  };
}

function deriveEntitySignal(
  entity: DerivedEntitySummary,
): TrustSignal {
  // Known entities (exchanges, DeFi protocols) are more trustworthy than unknown EOAs
  const value = entity.isKnownEntity ? 0.8 : 0.3;
  return {
    name: "entityRecognition",
    value,
    description: entity.isKnownEntity
      ? `Known entity: ${entity.label} (${entity.type})`
      : `Unrecognized entity type: ${entity.type}`,
    source: "nansen",
  };
}

function deriveReputationSignal(
  reputation: ReputationSummary,
): TrustSignal {
  const rate = reputation.recencyWeightedReliability;
  return {
    name: "reputationReliability",
    value: rate,
    description: `${reputation.successes}/${reputation.totalJudged} successful deals (recency-weighted: ${(rate * 100).toFixed(0)}%)`,
    source: "veritasos",
  };
}

// ── Risk factor identification ────────────────────────────────────────────

function identifyRiskFactors(
  activity: DerivedWalletActivity | undefined,
  entity: DerivedEntitySummary | undefined,
  reputation: ReputationSummary | undefined,
): RiskFactor[] {
  const factors: RiskFactor[] = [];

  // New account risk
  if (activity && activity.accountAgeDays < 7 && activity.accountAgeDays > 0) {
    factors.push({
      name: "newAccount",
      severity: "warning",
      description: `Account is only ${activity.accountAgeDays} days old`,
    });
  } else if (activity && activity.accountAgeDays === 0) {
    factors.push({
      name: "unknownAccountAge",
      severity: "warning",
      description: "Account age could not be determined",
    });
  }

  // Inactive account risk
  if (activity && activity.daysSinceLastActive > 30) {
    factors.push({
      name: "inactiveAccount",
      severity: "info",
      description: `Last active ${Math.floor(activity.daysSinceLastActive)} days ago`,
    });
  }

  // Low or no reputation
  if (!reputation || reputation.totalJudged === 0) {
    factors.push({
      name: "noReputation",
      severity: "warning",
      description: "No prior VeritasOS deal history",
    });
  } else if (reputation.successRate < 0.5) {
    factors.push({
      name: "lowReputation",
      severity: "critical",
      description: `Success rate ${(reputation.successRate * 100).toFixed(0)}% is below 50%`,
    });
  }

  // Unknown entity type
  if (entity && !entity.isKnownEntity && entity.type === "unknown") {
    factors.push({
      name: "unknownEntity",
      severity: "info",
      description: "Nansen could not classify this address",
    });
  }

  // Very low activity
  if (activity && activity.txCount30d === 0 && activity.accountAgeDays > 0) {
    factors.push({
      name: "noRecentActivity",
      severity: "warning",
      description: "Zero transactions in the last 30 days",
    });
  }

  return factors;
}

// ── Assessment logic ──────────────────────────────────────────────────────

function computeRecommendation(
  signals: TrustSignal[],
  riskFactors: RiskFactor[],
): { recommendation: Recommendation; confidence: number; reasoning: string } {
  if (signals.length === 0) {
    return {
      recommendation: "DO_NOT_HIRE",
      confidence: 0,
      reasoning: "Insufficient data to produce a trust assessment.",
    };
  }

  // Weighted average of trust signals
  const weights: Record<string, number> = {
    reputationReliability: 0.4,
    accountAge: 0.15,
    recentActivity: 0.15,
    portfolioDepth: 0.1,
    entityRecognition: 0.2,
  };

  let totalWeight = 0;
  let weightedScore = 0;

  for (const signal of signals) {
    const weight = weights[signal.name] ?? 0.1;
    weightedScore += signal.value * weight;
    totalWeight += weight;
  }

  const trustScore = totalWeight > 0 ? weightedScore / totalWeight : 0;

  // Adjust for critical risk factors
  const criticalCount = riskFactors.filter(
    (f) => f.severity === "critical",
  ).length;
  const warningCount = riskFactors.filter(
    (f) => f.severity === "warning",
  ).length;

  const adjustedScore = Math.max(
    0,
    trustScore - criticalCount * 0.3 - warningCount * 0.1,
  );

  // Decision threshold
  const HIRE_THRESHOLD = 0.5;
  const recommendation: Recommendation =
    adjustedScore >= HIRE_THRESHOLD ? "HIRE" : "DO_NOT_HIRE";

  // Confidence is how far from the threshold the score is
  const confidence = Math.min(
    1,
    Math.abs(adjustedScore - HIRE_THRESHOLD) / 0.5,
  );

  // Build reasoning
  const signalSummary = signals
    .map((s) => `${s.name}=${s.value.toFixed(2)}`)
    .join(", ");
  const riskSummary =
    riskFactors.length > 0
      ? ` Risk factors: ${riskFactors.map((f) => `${f.name}(${f.severity})`).join(", ")}.`
      : "";
  const reasoning = `Trust score ${adjustedScore.toFixed(2)} (threshold ${HIRE_THRESHOLD}). Signals: ${signalSummary}.${riskSummary} Recommendation: ${recommendation}.`;

  return { recommendation, confidence, reasoning };
}

function determineRiskLevel(
  signals: TrustSignal[],
  riskFactors: RiskFactor[],
): RiskLevel {
  if (signals.length === 0) return "UNKNOWN";

  const hasCritical = riskFactors.some((f) => f.severity === "critical");
  if (hasCritical) return "HIGH";

  const avgTrust =
    signals.reduce((sum, s) => sum + s.value, 0) / signals.length;

  if (avgTrust >= 0.7 && riskFactors.filter((f) => f.severity === "warning").length === 0) {
    return "LOW";
  }

  if (avgTrust >= 0.4) return "MEDIUM";

  return "HIGH";
}

// ── Deterministic hashing ─────────────────────────────────────────────────

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`);

    return `{${entries.join(",")}}`;
  }

  return value === undefined ? "null" : JSON.stringify(value);
}

function computeVerdictHash(assessment: Omit<TrustAssessment, "verdictHash">): string {
  const payload = {
    walletAddress: assessment.walletAddress,
    riskLevel: assessment.riskLevel,
    recommendation: assessment.assessment.recommendation,
    confidence: assessment.assessment.confidence,
    trustSignals: assessment.trustSignals.map((s) => ({
      name: s.name,
      value: s.value,
      source: s.source,
    })),
    riskFactors: assessment.riskFactors.map((f) => ({
      name: f.name,
      severity: f.severity,
    })),
    dataSources: assessment.dataSources.sort(),
    timestamp: assessment.timestamp,
  };

  return keccak256(toUtf8Bytes(canonicalize(payload)));
}

// ── Main assessment function ──────────────────────────────────────────────

/**
 * Produce a structured trust assessment for a wallet address.
 *
 * Combines Nansen onchain intelligence with VeritasOS deal history
 * to derive trust signals, risk factors, and a HIRE/DO_NOT_HIRE recommendation.
 */
export async function assessTrust(
  input: TrustAssessmentInput,
  nansenIntelligence: NansenIntelligence | null,
  reputation: ReputationSummary | null,
): Promise<TrustAssessment> {
  const signals: TrustSignal[] = [];
  const dataSources: string[] = [];

  // 1. Derive signals from Nansen intelligence
  if (nansenIntelligence) {
    dataSources.push(...nansenIntelligence.dataSources);

    signals.push(deriveAccountAgeSignal(nansenIntelligence.activity));
    signals.push(deriveActivitySignal(nansenIntelligence.activity));
    signals.push(derivePortfolioSignal(nansenIntelligence.activity));
    signals.push(deriveEntitySignal(nansenIntelligence.entitySummary));
  }

  // 2. Derive signals from VeritasOS reputation
  if (reputation && reputation.totalJudged > 0) {
    dataSources.push("veritasos-reputation");
    signals.push(deriveReputationSignal(reputation));
  }

  // 3. Identify risk factors
  const riskFactors = identifyRiskFactors(
    nansenIntelligence?.activity,
    nansenIntelligence?.entitySummary,
    reputation ?? undefined,
  );

  // 4. Compute recommendation
  const assessmentResult = computeRecommendation(signals, riskFactors);

  // 5. Determine risk level
  const riskLevel = determineRiskLevel(signals, riskFactors);

  // 6. Build assessment
  const timestamp = new Date().toISOString();
  const assessmentWithoutHash: Omit<TrustAssessment, "verdictHash"> = {
    walletAddress: input.walletAddress.toLowerCase(),
    riskLevel,
    trustSignals: signals,
    riskFactors,
    assessment: assessmentResult,
    entitySummary: nansenIntelligence?.entitySummary,
    activity: nansenIntelligence?.activity,
    reputation: reputation
      ? {
          totalJudged: reputation.totalJudged,
          successRate: reputation.successRate,
          recencyWeightedReliability: reputation.recencyWeightedReliability,
        }
      : undefined,
    dataSources: [...new Set(dataSources)],
    timestamp,
  };

  const verdictHash = computeVerdictHash(assessmentWithoutHash);

  return {
    ...assessmentWithoutHash,
    verdictHash,
  };
}
