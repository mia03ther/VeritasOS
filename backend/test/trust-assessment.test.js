import assert from 'node:assert/strict';
import { once } from 'node:events';
import { before, after, beforeEach, afterEach, describe, it } from 'mocha';

process.env.ARBITRA_NO_LISTEN = 'true';
const { server } = await import('../dist/server.js');
const { NansenAdapter, normalizeIntelligence } = await import('../dist/nansen/adapter.js');
const { parseTrustInput, hashAssessment } = await import('../dist/trust-assessment.js');
const realFetch = globalThis.fetch;
const wallet = '0x' + 'ab'.repeat(20);
const vars = ['MOCK_NANSEN', 'MOCK_TRUST_LLM', 'NANSEN_API_KEY', 'NANSEN_BASE_URL', 'NANSEN_CHAIN', 'LLM_API_KEY', 'LLM_BASE_URL'];
let saved;
let base;
let providerStatus;
let providerMalformed;
let modelContent;
let requests;
const pagination = { page: 1, per_page: 100, is_last_page: true };

describe('Trust Intelligence API and engine', function () {
  before(async () => { server.listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; });
  after(async () => { await new Promise(resolve => server.close(resolve)); });
  beforeEach(() => {
    saved = Object.fromEntries(vars.map(key => [key, process.env[key]]));
    Object.assign(process.env, { MOCK_NANSEN: 'false', MOCK_TRUST_LLM: 'false', NANSEN_API_KEY: 'test-only-nansen',
      NANSEN_BASE_URL: 'http://nansen.test/api/v1', NANSEN_CHAIN: 'monad', LLM_API_KEY: 'test-only-llm', LLM_BASE_URL: 'http://trust-llm.test/v1' });
    requests = [];
    providerStatus = 200;
    providerMalformed = false;
    modelContent = { riskLevel: 'MEDIUM', recommendation: 'HIRE', reasoning: 'Test provider interpretation of supplied evidence.',
      keySignals: ['observedTransactions'], caveat: 'Synthetic test model output; no real model evaluation.' };
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('http://nansen.test/')) {
        const body = JSON.parse(init.body);
        requests.push({ url: String(url), ...init, body });
        if (providerMalformed) return Response.json({ data: 'bad' });
        const data = String(url).endsWith('current-balance')
          ? [{ chain: 'monad', address: body.address, token_address: 'test-token', token_symbol: 'TEST', value_usd: 20 }]
          : [{ chain: 'monad', transaction_hash: 'test-tx', block_timestamp: body.date.to, method: 'received', source_type: 'test' }];
        return Response.json({ pagination, data }, { status: providerStatus });
      }
      if (String(url).startsWith('http://trust-llm.test/')) {
        requests.push({ url: String(url), ...init, body: JSON.parse(init.body) });
        return Response.json({ choices: [{ message: { content: typeof modelContent === 'string' ? modelContent : JSON.stringify(modelContent) } }] });
      }
      return realFetch(url, init);
    };
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const key of vars) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key];
  });
  const post = body => realFetch(`${base}/api/trust-assessment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('uses documented Nansen POST bodies, normalizes observations, and requests structured AI output', async () => {
    const response = await post({ walletAddress: wallet, taskContext: 'Write a report', counterpartyRole: 'seller' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.assessment.recommendation, 'HIRE');
    assert.equal(result.intelligence.activity.observedTransactions, 1);
    assert.equal(result.intelligence.activity.observedValueUsd, 20);
    assert.equal(result.model.mode, 'live');
    assert.equal(requests.length, 3);
    for (const request of requests.slice(0, 2)) {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.apikey, 'test-only-nansen');
      assert.equal(request.body.address, wallet);
      assert.equal(request.body.chain, 'monad');
      assert.equal(request.body.pagination.per_page, 100);
    }
    assert.equal(requests[2].body.response_format.json_schema.strict, true);
    assert.equal(JSON.parse(requests[2].body.messages[1].content).input.taskContext, 'Write a report');
    const { success, verdictHash, ...payload } = result;
    assert.equal(hashAssessment(payload), verdictHash);
    assert.notEqual(hashAssessment({ ...payload, assessment: { ...payload.assessment, reasoning: 'tampered' } }), verdictHash);
    assert.notEqual(hashAssessment({ ...payload, model: { ...payload.model, id: 'tampered' } }), verdictHash);
  });

  it('returns a dynamic DO_NOT_HIRE model result', async () => {
    modelContent.riskLevel = 'UNKNOWN'; modelContent.recommendation = 'DO_NOT_HIRE';
    assert.equal((await (await post({ walletAddress: wallet })).json()).assessment.recommendation, 'DO_NOT_HIRE');
  });

  it('rejects invalid addresses and context types before querying providers', async () => {
    for (const body of [null, [], {}, { walletAddress: 'bad' }, { walletAddress: wallet, taskContext: 3 },
      { walletAddress: wallet, counterpartyRole: false }, { walletAddress: wallet, taskContext: 'x'.repeat(4001) }]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.equal(requests.length, 0);
    assert.equal(parseTrustInput({ walletAddress: '  ' + wallet.toUpperCase().replace('0X', '0x') + '  ' }).walletAddress, wallet);
  });

  it('returns 400 for malformed JSON', async () => {
    assert.equal((await realFetch(`${base}/api/trust-assessment`, { method: 'POST', body: '{' })).status, 400);
  });

  it('reports missing Nansen configuration as 500, never reputation-only success', async () => {
    delete process.env.NANSEN_API_KEY;
    const response = await post({ walletAddress: wallet });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /NANSEN_API_KEY is not configured/);
    assert.equal(requests.length, 0);
  });

  it('reports missing LLM configuration as 500', async () => {
    delete process.env.LLM_API_KEY;
    const response = await post({ walletAddress: wallet });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /LLM_API_KEY is not configured/);
  });

  it('labels both offline modes and never calls a provider', async () => {
    process.env.MOCK_NANSEN = 'true'; process.env.MOCK_TRUST_LLM = 'true';
    delete process.env.NANSEN_API_KEY; delete process.env.LLM_API_KEY;
    const response = await post({ walletAddress: wallet });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.intelligence.mode, 'mock');
    assert.equal(result.model.mode, 'mock');
    assert.match(result.assessment.reasoning, /MOCK ASSESSMENT/);
    assert.ok(result.dataSources.some(source => source.startsWith('mock:nansen:')));
    assert.ok(!result.dataSources.some(source => source.startsWith('nansen:')));
    assert.equal(requests.length, 0);
  });

  it('propagates Nansen auth, rate-limit and server failures as upstream errors', async () => {
    for (const status of [401, 403, 429, 500]) {
      providerStatus = status;
      const response = await post({ walletAddress: wallet });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, new RegExp(`HTTP ${status}`));
    }
  });

  it('rejects malformed Nansen responses and transport timeouts', async () => {
    providerMalformed = true;
    assert.equal((await post({ walletAddress: wallet })).status, 502);
    globalThis.fetch = async () => { throw new DOMException('timeout', 'TimeoutError'); };
    await assert.rejects(new NansenAdapter().getIntelligence(wallet), /timed out/);
  });

  it('rejects malformed, fabricated-signal and inconsistent AI output', async () => {
    for (const content of ['```json {} ```', {}, { ...modelContent, keySignals: ['invented-fraud'] },
      { ...modelContent, riskLevel: 'HIGH' }, { ...modelContent, confidence: 1 }]) {
      modelContent = content;
      assert.equal((await post({ walletAddress: wallet })).status, 502);
    }
  });

  it('returns 502 for a model provider HTTP failure without leaking its response body', async () => {
    process.env.MOCK_NANSEN = 'true';
    globalThis.fetch = async () => new Response('sensitive upstream diagnostic', { status: 403 });
    const response = await post({ walletAddress: wallet });
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.match(error, /Trust model provider failed.*403/);
    assert.ok(!error.includes('sensitive'));
  });

  it('returns 502 for a model transport timeout', async () => {
    process.env.MOCK_NANSEN = 'true';
    globalThis.fetch = async () => { throw new DOMException('timeout', 'TimeoutError'); };
    assert.equal((await post({ walletAddress: wallet })).status, 502);
  });

  it('distinguishes unknown valuation from zero and exposes bounded pagination', () => {
    const window = { from: '2026-01-01T00:00:00Z', to: '2026-01-31T00:00:00Z' };
    const raw = { balances: { pagination, data: [{ chain: 'monad', address: wallet, token_address: 'test', token_symbol: 'TEST' }] },
      transactions: { pagination: { ...pagination, is_last_page: false }, data: [] } };
    const unknown = normalizeIntelligence(raw, wallet, 'monad', 'live', window);
    assert.equal(unknown.activity.observedValueUsd, null);
    assert.equal(unknown.coverage.transactionsComplete, false);
    assert.equal(unknown.activity.latestObservedAt, null);
    raw.balances.data[0].value_usd = 0;
    assert.equal(normalizeIntelligence(raw, wallet, 'monad', 'live', window).activity.observedValueUsd, 0);
    raw.balances.data[0].value_usd = '20';
    assert.throws(() => normalizeIntelligence(raw, wallet, 'monad', 'live', window), /schema/);
  });
});
