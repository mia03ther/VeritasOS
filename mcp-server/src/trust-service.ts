/**
 * Agent Trust Assessment service for the MCP server.
 *
 * Calls the VeritasOS backend `POST /api/trust-assessment` endpoint, which
 * combines Nansen onchain intelligence (PRE-TRANSACTION counterparty risk)
 * with VeritasOS deal-history reputation, and returns a structured
 * HIRE / DO_NOT_HIRE assessment.
 *
 * This module is a thin, validating client. It does not synthesize risk data,
 * does not cache stale assessments, and does not fabricate fields the backend
 * did not return. When the backend is unreachable or returns an error, the
 * error propagates to the tool layer verbatim.
 *
 * Response shape is optimized for an AI agent consumer: concise, decisive,
 * auditable (verdictHash present for later verification).
 */

const DEFAULT_TIMEOUT_MS = 10_000;

/** Input accepted by the assess_agent_risk MCP tool. */
export interface AssessAgentRiskInput {
  walletAddress: string;
  taskContext?: string;
  counterpartyRole?: string;
}

/** One normalized trust signal mirrored from the backend assessment. */
export interface TrustSignalSummary {
  name: string;
  value: number;
  description: string;
  source: string;
}

/** One risk factor mirrored from the backend assessment. */
export interface RiskFactorSummary {
  name: string;
  severity: "info" | "warning" | "critical";
  description: string;
}

/**
 * The concise agent-facing assessment response.
 *
 * Everything here is derived from the backend response; nothing is invented.
 * `nansenCoverage` states honestly whether Nansen intelligence contributed.
 */
export interface AgentRiskAssessment {
  walletAddress: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  recommendation: "HIRE" | "DO_NOT_HIRE";
  confidence: number;
  reasoning: string;
  /** Top signals by trust value, capped for a concise tool response. */
  topSignals: TrustSignalSummary[];
  riskFactors: RiskFactorSummary[];
  /** Data sources that contributed (e.g. nansen:wallet-profile, veritasos-reputation). */
  dataSources: string[];
  /** Whether Nansen intelligence contributed: full (2+), partial (1), none (0). */
  nansenCoverage: "full" | "partial" | "none";
  /** Deterministic keccak256 hash of the assessment payload (audit trail). */
  verdictHash: string;
  timestamp: string;
}

/** Raw backend response shape (subset consumed). */
interface BackendAssessment {
  success?: boolean;
  walletAddress?: unknown;
  riskLevel?: unknown;
  trustSignals?: unknown;
  riskFactors?: unknown;
  assessment?: { recommendation?: unknown; confidence?: unknown; reasoning?: unknown };
  dataSources?: unknown;
  timestamp?: unknown;
  verdictHash?: unknown;
  error?: unknown;
}

/** Validates an EVM address and returns its lowercase form. */
export function normalizeWalletAddress(value: unknown, field = "walletAddress"): string {
  if (typeof value !== "string") {
    throw new Error(`${field} is required and must be an EVM address string`);
  }
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    throw new Error(
      `${field} must be a valid EVM address (0x followed by 40 hex characters)`
    );
  }
  return trimmed.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parses and validates the backend assessment into the agent-facing shape. */
export function parseAgentRiskAssessment(payload: unknown): AgentRiskAssessment {
  if (!isRecord(payload)) {
    throw new Error("Backend trust assessment response is invalid");
  }
  const body = payload as BackendAssessment;

  if (typeof body.error === "string" && body.error.trim()) {
    throw new Error(body.error);
  }

  const walletAddress = normalizeWalletAddress(body.walletAddress, "walletAddress");
  const riskLevel = body.riskLevel;
  if (riskLevel !== "LOW" && riskLevel !== "MEDIUM" && riskLevel !== "HIGH" && riskLevel !== "UNKNOWN") {
    throw new Error("Backend trust assessment response is missing a valid riskLevel");
  }

  const assessment = isRecord(body.assessment) ? body.assessment : {};
  const recommendation = assessment.recommendation;
  if (recommendation !== "HIRE" && recommendation !== "DO_NOT_HIRE") {
    throw new Error("Backend trust assessment response is missing a valid recommendation");
  }

  const confidence =
    typeof assessment.confidence === "number" && Number.isFinite(assessment.confidence)
      ? assessment.confidence
      : 0;

  const reasoning =
    typeof assessment.reasoning === "string" && assessment.reasoning.trim()
      ? assessment.reasoning
      : "No reasoning provided.";

  const trustSignals = Array.isArray(body.trustSignals) ? body.trustSignals : [];
  const topSignals = trustSignals
    .filter(isRecord)
    .map((signal) => ({
      name: typeof signal.name === "string" ? signal.name : "unknown",
      value: typeof signal.value === "number" && Number.isFinite(signal.value) ? signal.value : 0,
      description: typeof signal.description === "string" ? signal.description : "",
      source: typeof signal.source === "string" ? signal.source : "unknown",
    }))
    .sort((left, right) => right.value - left.value)
    .slice(0, 3);

  const riskFactors = (Array.isArray(body.riskFactors) ? body.riskFactors : [])
    .filter(isRecord)
    .map((factor) => {
      const severity =
        factor.severity === "critical" || factor.severity === "warning" || factor.severity === "info"
          ? factor.severity
          : "info";
      return {
        name: typeof factor.name === "string" ? factor.name : "unknown",
        severity,
        description: typeof factor.description === "string" ? factor.description : "",
      };
    });

  const dataSources = (Array.isArray(body.dataSources) ? body.dataSources : [])
    .filter((item): item is string => typeof item === "string");

  const nansenCount = dataSources.filter((source) => source.startsWith("nansen:")).length;
  const nansenCoverage = nansenCount >= 2 ? "full" : nansenCount === 1 ? "partial" : "none";

  const verdictHash =
    typeof body.verdictHash === "string" && /^0x[0-9a-f]{64}$/.test(body.verdictHash)
      ? body.verdictHash
      : "";
  if (!verdictHash) {
    throw new Error("Backend trust assessment response is missing a valid verdictHash");
  }

  const timestamp = typeof body.timestamp === "string" ? body.timestamp : "";

  return {
    walletAddress,
    riskLevel,
    recommendation,
    confidence,
    reasoning,
    topSignals,
    riskFactors,
    dataSources,
    nansenCoverage,
    verdictHash,
    timestamp,
  };
}

/**
 * Requests a trust assessment from the VeritasOS backend.
 *
 * Throws on transport failure, timeout, non-2xx, or an unparseable response.
 */
export async function assessAgentRisk(
  backendUrl: string,
  input: AssessAgentRiskInput,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<AgentRiskAssessment> {
  const walletAddress = normalizeWalletAddress(input.walletAddress);

  const response = await fetch(`${backendUrl.replace(/\/$/, "")}/api/trust-assessment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      walletAddress,
      taskContext: input.taskContext,
      counterpartyRole: input.counterpartyRole,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed?.error === "string") detail = `: ${parsed.error}`;
    } catch {
      // Non-JSON error body — keep the status-line detail only.
    }
    throw new Error(`Backend trust assessment failed (${response.status})${detail}`);
  }

  const payload: unknown = await response.json().catch(() => {
    throw new Error("Backend trust assessment returned a non-JSON response");
  });

  return parseAgentRiskAssessment(payload);
}
