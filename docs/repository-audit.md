# Audit baseline: 783d813

The working tree was clean on `main`; only one commit exists in this GitHub
repository's current history. No history was rewritten or claimed as new work.

| Area | Existing implementation | Gap addressed in this PR |
| --- | --- | --- |
| Backend | Node REST API, Prisma SQLite, AI Judge canonical records, reputation, oracle | Independent Trust API startup; validation and provider errors |
| Nansen | Adapter with unverified GET wallet routes and swallowed failures | Official POST profiler requests, response checks, normalization, explicit mock |
| Trust Engine | Weighted heuristic and distance-from-threshold confidence | Neutral observations, bounded coverage, structured LLM assessment |
| MCP | Reputation, verification, Graph tools, existing assess_agent_risk client | Same engine through REST; preserve full assessment and provenance |
| Frontend | Next.js docket, reputation explorer, fixture APIs, escrow wallet flow | Counterparty assessment form, source/mode disclosure, escrow handoff |
| Contracts | ArbiterEscrow custody, authorized oracle settlement, refunds, tests | Monad Testnet network configuration; explicit oracle deployment parameter |
| Chain deployments | Tracked local and Arc chain-5042002 artifacts | No Monad deployment claimed or fabricated |
| Subgraph | Arc escrow mappings and Graph intelligence | Preserved as additional indexed source; not relabeled as Nansen |
| Simulation | Fixture-backed reputation/Judge/verification demo | Preserved and rerun; new Trust integration tests complement it |

No new database is required. Trust assessments are returned as self-contained
hashed payloads and are not durably stored by this feature. The AI Judge's
canonicalization, verdictReasoningHash and settlement contract are unchanged.
Tracked environment files at baseline were examples, not credential files.

## Validation follow-up

An earlier validation run incorrectly overlapped frontend build and smoke. The
smoke saw HTTP 500 from the shared `.next` output, failed its page assertion,
and Node 24.19.0 on Windows then reported a libuv closing-handle assertion during
termination. Backend and MCP suites and an isolated unmodified smoke passed.
The native assertion's precise internal cause was not independently proven.
The smoke now drains every HTTP body, closes request connections, clears timers,
waits for child `close` rather than only `exit`, and lets failures drain naturally
with exit code 1. Successful and intentionally failing cleanup runs both complete
without the native assertion or extra residual Node processes. Builds and smoke
are run sequentially.

Static review found no new live contract address or transaction hash. Synthetic
Nansen identifiers are confined to the explicit mock branch and tests; frontend
recommendations are read from the backend response. AI Judge, oracle settlement,
contracts and subgraph implementation files remain unchanged. A pattern scan of
198 tracked/untracked non-ignored files found no secret-like values or non-example
environment files; this is a scoped static check, not a guarantee of no secrets.

`npm audit --omit=dev` reported four high-severity entries in the existing Prisma
dependency chain (`prisma`, `@prisma/config`, `deepmerge-ts`, `effect`). No broad
dependency downgrade or forced audit fix was applied in this feature PR.
