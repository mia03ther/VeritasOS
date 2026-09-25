import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { before, after, describe, it } from 'mocha';

const wallet = '0x' + 'ab'.repeat(20);
let backend;
let backendUrl;
let saved;
async function invoke(method, params) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    env: { ...process.env, ARBITRA_BACKEND_URL: backendUrl, GRAPH_API_KEY: '', LLM_API_KEY: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', data => output.push(data.toString()));
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
  const timeout = setTimeout(() => child.kill(), 8000);
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0);
    return JSON.parse(output.join('')).result;
  } finally { clearTimeout(timeout); }
}

describe('assess_agent_risk through real backend and stdio', function () {
  this.timeout(10_000);
  before(async () => {
    const keys = ['ARBITRA_NO_LISTEN', 'MOCK_NANSEN', 'MOCK_TRUST_LLM'];
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, { ARBITRA_NO_LISTEN: 'true', MOCK_NANSEN: 'true', MOCK_TRUST_LLM: 'true' });
    backend = (await import('../../backend/dist/server.js')).server;
    backend.listen(0);
    await once(backend, 'listening');
    backendUrl = `http://127.0.0.1:${backend.address().port}`;
  });
  after(async () => {
    await new Promise(resolve => backend.close(resolve));
    const { prisma } = await import('../../backend/dist/lib/prisma.js');
    await prisma.$disconnect();
    for (const [key, value] of Object.entries(saved)) value === undefined ? delete process.env[key] : process.env[key] = value;
  });
  it('retains every existing tool name', async () => {
    const { tools } = await invoke('tools/list');
    for (const name of ['get_agent_reputation', 'verify_deal_verdict', 'get_indexed_deal', 'assess_seller_risk', 'assess_agent_risk', 'verify_verdict_onchain',
      'escrow_market_insights', 'search_defi_subgraphs', 'query_wallet_activity']) {
      assert.ok(tools.some(tool => tool.name === name), name);
    }
  });
  it('passes context to the shared engine and preserves mock provenance and the hashed payload', async () => {
    const result = await invoke('tools/call', { name: 'assess_agent_risk', arguments: { walletAddress: wallet, taskContext: 'Report', counterpartyRole: 'seller' } });
    assert.ok(!result.isError, JSON.stringify(result));
    const data = result.structuredContent;
    assert.equal(data.walletAddress, wallet);
    assert.equal(data.input.taskContext, 'Report');
    assert.equal(data.intelligence.mode, 'mock');
    assert.equal(data.model.mode, 'mock');
    assert.equal(data.recommendation, 'DO_NOT_HIRE');
    assert.ok(data.dataSources.some(source => source.startsWith('mock:nansen:')));
    assert.deepEqual(JSON.parse(result.content[0].text), data);
    const { hashAssessment } = await import('../../backend/dist/trust-assessment.js');
    const { success, recommendation, reasoning, topSignals, verdictHash, ...payload } = data;
    assert.equal(hashAssessment(payload), verdictHash);
  });
  it('returns MCP tool errors for invalid address and optional input', async () => {
    for (const args of [{ walletAddress: 'bad' }, { walletAddress: wallet, taskContext: 42 }]) {
      const result = await invoke('tools/call', { name: 'assess_agent_risk', arguments: args });
      assert.equal(result.isError, true);
    }
  });
  it('propagates provider configuration failures instead of issuing a recommendation', async () => {
    const oldKey = process.env.NANSEN_API_KEY;
    process.env.MOCK_NANSEN = 'false'; delete process.env.NANSEN_API_KEY;
    try {
      const result = await invoke('tools/call', { name: 'assess_agent_risk', arguments: { walletAddress: wallet } });
      assert.equal(result.isError, true);
      assert.match(result.structuredContent.error, /500.*NANSEN_API_KEY/);
    } finally {
      process.env.MOCK_NANSEN = 'true';
      oldKey === undefined ? delete process.env.NANSEN_API_KEY : process.env.NANSEN_API_KEY = oldKey;
    }
  });
});
