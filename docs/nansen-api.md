# Nansen adapter contract

Checked against the official documentation on 2026-09-25:

- [Current balances](https://docs.nansen.ai/api/profiler/address-current-balances)
- [Transactions](https://docs.nansen.ai/api/profiler/address-transactions)
- [API overview](https://docs.nansen.ai/api/overview)

Both calls use POST to `https://api.nansen.ai/api/v1/profiler/address/`, an
`apikey` header, and JSON containing `address`, `chain`, `hide_spam_token: true`
and `pagination: { page: 1, per_page: 100 }`.

`current-balance` consumes `data[].chain`, `address`, `token_address`,
`token_symbol`, and optional/nullable `value_usd`.
`transactions` adds `date: { from, to }` in ISO 8601 and
`order_by: [{ field: "block_timestamp", direction: "DESC" }]`; it consumes
`data[].chain`, `transaction_hash`, `block_timestamp`, `method`, `source_type`.
Both consume `pagination.page`, `per_page`, `is_last_page`.

The adapter deliberately supports `monad` and `ethereum` only. `monad` is
Nansen's intelligence chain, not a claim of Monad Testnet indexing. Escrow
execution has independent chain configuration.

One page per endpoint bounds request cost and latency. Counts and priced USD
value describe only returned rows. A false `is_last_page` produces a coverage
warning. Missing prices stay unknown; zero is a distinct observed value. No
wallet-age, entity-label, counterparty or scam classifications are invented.
An empty successful response is different from a failed response. Any failed
endpoint aborts assessment with HTTP 502; missing configuration is HTTP 500.
Upstream 401/403 are provider errors, not authentication failures by our caller.

`MOCK_NANSEN=true` feeds synthetic raw responses through the same normalization
path, labels all Nansen source identifiers `mock:nansen:*`, and exposes
`intelligence.mode=mock`. `MOCK_TRUST_LLM=true` is independent, emits
`model.mode=mock`, and explicitly states that no model ran. Neither is an
automatic fallback. Live adapters have contract tests with stub transports;
successful paid/live Nansen access still requires operator credentials.
