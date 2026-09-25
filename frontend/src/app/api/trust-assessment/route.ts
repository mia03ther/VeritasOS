import { NextResponse } from 'next/server';
import { serverEnv } from '@/lib/serverEnv';

export const dynamic = 'force-dynamic';

/** Always forwards to the Trust Engine; never falls back to bundled fixtures. */
export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }
  const base = serverEnv.trustBackendUrl;
  if (!base) return NextResponse.json({ error: 'ARBITRA_BACKEND_URL is not configured for Trust Intelligence' }, { status: 500 });
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/api/trust-assessment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45_000), cache: 'no-store',
    });
    const payload: unknown = await response.json();
    return NextResponse.json(payload, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Trust backend unavailable, timed out, or returned invalid JSON' }, { status: 502 });
  }
}
