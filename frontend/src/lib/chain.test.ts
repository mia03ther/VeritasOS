import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from './env';

process.env.NEXT_PUBLIC_CHAIN = 'monad-testnet';
const { ARC_TESTNET: target, MONAD_TESTNET, isOnArc, rpcUrls, USDC_DECIMALS } = await import('./chain');

test('Monad opt-in reaches the existing wallet chain guards and preserves token units', () => {
  assert.equal(target, MONAD_TESTNET);
  assert.equal(Number(target.chainIdHex), target.chainId);
  assert.equal(isOnArc(target.chainIdHex), true);
  assert.equal(isOnArc(1), false);
  assert.equal(target.nativeCurrency.symbol, 'MON');
  assert.equal(target.nativeCurrency.decimals, 18);
  assert.equal(USDC_DECIMALS, 6);
});

test('Monad never falls back to the Arc RPC when its RPC is missing', () => {
  process.env.NEXT_PUBLIC_ARC_RPC_URL = 'https://arc.invalid';
  delete process.env.NEXT_PUBLIC_MONAD_RPC_URL;
  assert.deepEqual(rpcUrls(), []);
  process.env.NEXT_PUBLIC_MONAD_RPC_URL = 'https://monad.invalid';
  assert.deepEqual(rpcUrls(), ['https://monad.invalid']);
  delete process.env.NEXT_PUBLIC_CHAIN;
  assert.equal(env.arcRpcUrl, 'https://arc.invalid');
});
