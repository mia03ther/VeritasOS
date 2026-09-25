/** Thin client: all intelligence, derivation and model reasoning live in the backend. */
export interface AssessAgentRiskInput { walletAddress: string; taskContext?: string; counterpartyRole?: string }
export function normalizeWalletAddress(value: unknown, field = "walletAddress"): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    throw new Error(`${field} must be a valid EVM address`);
  }
  return value.trim().toLowerCase();
}
export function parseAgentRiskAssessment(payload: unknown) {
  const body = payload as Record<string, any>;
  if (!body || typeof body !== "object" || typeof body.error === "string") throw new Error(body?.error ?? "Invalid backend assessment");
  const walletAddress = normalizeWalletAddress(body.walletAddress);
  if (!["LOW", "MEDIUM", "HIGH", "UNKNOWN"].includes(body.riskLevel) ||
    !["HIRE", "DO_NOT_HIRE"].includes(body.assessment?.recommendation) ||
    typeof body.assessment?.reasoning !== "string" || typeof body.assessment?.caveat !== "string" ||
    !Array.isArray(body.trustSignals) || !Array.isArray(body.riskFactors) ||
    !Array.isArray(body.dataSources) || !body.dataSources.every((s: unknown) => typeof s === "string") ||
    !["live", "mock"].includes(body.intelligence?.mode) || !["live", "mock"].includes(body.model?.mode) ||
    typeof body.timestamp !== "string" || !Number.isFinite(Date.parse(body.timestamp)) ||
    typeof body.verdictHash !== "string" || !/^0x[0-9a-f]{64}$/.test(body.verdictHash)) {
    throw new Error("Backend trust assessment response has an invalid schema");
  }
  // Preserve the complete hashed payload and explicit mock/coverage metadata.
  // Compatibility aliases retain the existing agent-facing recommendation/reasoning.
  return { ...body, walletAddress, recommendation: body.assessment.recommendation,
    reasoning: body.assessment.reasoning, topSignals: body.trustSignals.slice(0, 3) };
}
export async function assessAgentRisk(backendUrl: string, input: AssessAgentRiskInput, timeoutMs = 45_000) {
  const walletAddress = normalizeWalletAddress(input.walletAddress);
  for (const [name, limit] of [["taskContext", 4000], ["counterpartyRole", 100]] as const) {
    if (input[name] !== undefined && (typeof input[name] !== "string" || input[name].length > limit)) {
      throw new Error(`${name} must be a string of at most ${limit} characters`);
    }
  }
  const response = await fetch(`${backendUrl.replace(/\/$/, "")}/api/trust-assessment`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, walletAddress }), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(`Backend trust assessment failed (${response.status})${typeof error.error === "string" ? `: ${error.error}` : ""}`);
  }
  const result = parseAgentRiskAssessment(await response.json());
  if (result.walletAddress !== walletAddress) throw new Error("Backend assessment wallet does not match request");
  return result;
}
