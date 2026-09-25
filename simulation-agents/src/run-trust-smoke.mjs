import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
async function freePort() {
  const socket = createServer(); socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
const backendPort = await freePort();
const frontendPort = await freePort();
const backendUrl = `http://127.0.0.1:${backendPort}`;
const frontendUrl = `http://127.0.0.1:${frontendPort}`;
const children = [];
// Consume every response and close HTTP connections, including readiness and
// error checks. Clear timeout handles on both success and failure.
async function request(url, init = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init,
      headers: { ...init.headers, Connection: 'close' }, signal: controller.signal });
    return { status: response.status, body: await response.text() };
  } finally { clearTimeout(timeout); }
}
function start(args, env) {
  const child = spawn(process.execPath, args, { cwd: root,
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { log = (log + data).slice(-8000); });
  let spawnError;
  child.on('error', error => { spawnError = error; log += error.message; });
  // `exit` can precede closure of stdout/stderr. Register immediately so an
  // early exit cannot race cleanup, and wait for `close` even if already exited.
  const closed = new Promise(resolve => child.once('close', resolve));
  const managed = { child, closed, log: () => log, error: () => spawnError };
  children.push(managed);
  return managed;
}
async function stop(process) {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill();
  await process.closed;
}
async function ready(process, url, expectedStatus) {
  let lastStatus;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (process.error() || process.child.exitCode !== null || process.child.signalCode !== null) throw new Error(process.log());
    try {
      lastStatus = (await request(url, {}, 500)).status;
      if (lastStatus === expectedStatus) return;
    } catch { /* Retry until the process is ready, not merely listening. */ }
    await delay(250);
  }
  throw new Error(`Startup timeout (HTTP ${lastStatus ?? 'unavailable'}): ${process.log()}`);
}
const wallet = '0x' + 'ab'.repeat(20);
const post = body => request(`${frontendUrl}/api/trust-assessment`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
async function main() {
try {
  const backend = start(['backend/dist/server.js'], { PORT: String(backendPort), ARBITRA_NO_LISTEN: 'false',
    MOCK_NANSEN: 'true', MOCK_TRUST_LLM: 'true', NANSEN_CHAIN: 'monad',
    NANSEN_API_KEY: '', LLM_API_KEY: '', ARBITER_ORACLE_PRIVATE_KEY: '', ARBITER_ESCROW_ADDRESS: '', ARBITER_RPC_URL: '' });
  await ready(backend, backendUrl, 404);
  const frontend = start(['node_modules/next/dist/bin/next', 'start', 'frontend', '--port', String(frontendPort), '--hostname', '127.0.0.1'],
    { ARBITRA_BACKEND_URL: backendUrl });
  await ready(frontend, `${frontendUrl}/trust`, 200);
  if (process.argv.includes('--exercise-failure-cleanup')) throw new Error('Intentional smoke failure to exercise cleanup');
  assert.match((await request(`${frontendUrl}/trust`)).body, /Agent Trust Intelligence/);
  const response = await post({ walletAddress: wallet, taskContext: 'Integration smoke', counterpartyRole: 'seller' });
  assert.equal(response.status, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.walletAddress, wallet);
  assert.equal(result.intelligence.mode, 'mock');
  assert.equal(result.model.mode, 'mock');
  assert.match(result.assessment.reasoning, /MOCK ASSESSMENT/);
  assert.ok(result.dataSources.some(source => source.startsWith('mock:nansen:')));
  assert.equal((await post({ walletAddress: 'invalid' })).status, 400);
  assert.match((await request(`${frontendUrl}/create?seller=${wallet}`)).body, new RegExp(wallet));
  await stop(backend);
  assert.equal((await post({ walletAddress: wallet })).status, 502);
  console.log('Trust smoke passed: production frontend -> REST -> mock Nansen normalization -> mock assessment; provenance, invalid input, escrow handoff, backend outage.');
} finally {
  await Promise.all(children.map(stop));
}
}

// Preserve failure while allowing Node to drain handles naturally on Windows.
await main().catch(error => { console.error(error); process.exitCode = 1; });
