'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/primitives/Button';

interface Assessment {
  walletAddress: string;
  riskLevel: string;
  trustSignals: { name: string; description: string; source: string }[];
  riskFactors: { name: string; description: string; severity: string }[];
  assessment: { recommendation: 'HIRE' | 'DO_NOT_HIRE'; reasoning: string; caveat: string };
  dataSources: string[];
  intelligence: { mode: 'mock' | 'live'; chain: string; window: { from: string; to: string } };
  model: { mode: 'mock' | 'live'; id: string };
  timestamp: string;
  verdictHash: string;
}

export function TrustAssessmentPanel() {
  const [wallet, setWallet] = useState('');
  const [context, setContext] = useState('');
  const [role, setRole] = useState('seller');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Assessment | null>(null);

  async function assess(event: FormEvent) {
    event.preventDefault();
    setResult(null);
    setError(null);
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet.trim())) {
      setError('Enter a valid EVM wallet address.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/trust-assessment', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: wallet.trim(), taskContext: context, counterpartyRole: role }),
        signal: AbortSignal.timeout(50_000),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Assessment failed (${response.status})`);
      if (!payload.assessment || !['HIRE', 'DO_NOT_HIRE'].includes(payload.assessment.recommendation) ||
        !payload.intelligence || !payload.model || !Array.isArray(payload.trustSignals) ||
        !Array.isArray(payload.riskFactors) || !Array.isArray(payload.dataSources) ||
        payload.walletAddress !== wallet.trim().toLowerCase()) throw new Error('Invalid assessment response');
      setResult(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Assessment failed');
    } finally { setBusy(false); }
  }

  const fieldClass = 'w-full rounded border border-rule bg-panel-1 p-3 text-body text-hi';
  return (
    <div className="flex max-w-[60rem] flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-display text-hi">Agent Trust Intelligence</h1>
        <p className="text-lede text-muted">Assess a counterparty before creating an escrow. Nansen observations inform a probabilistic AI assessment; they do not guarantee reliable work.</p>
      </header>
      <form onSubmit={assess} className="flex flex-col gap-5" aria-busy={busy}>
        <label className="text-body text-primary">Counterparty wallet
          <input required value={wallet} disabled={busy} onChange={e => { setWallet(e.target.value); setResult(null); }} className={fieldClass} placeholder="0x…" />
        </label>
        <label className="text-body text-primary">Task context
          <textarea value={context} maxLength={4000} disabled={busy} onChange={e => { setContext(e.target.value); setResult(null); }} className={fieldClass} />
        </label>
        <label className="text-body text-primary">Counterparty role
          <select value={role} disabled={busy} onChange={e => { setRole(e.target.value); setResult(null); }} className={fieldClass}>
            <option value="seller">Seller</option><option value="buyer">Buyer</option>
          </select>
        </label>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? 'Assessing…' : 'Assess counterparty'}</Button>
      </form>
      {error && <p role="alert" className="text-body text-hi">{error}</p>}
      {result && <section aria-label="Trust assessment" aria-live="polite" className="flex flex-col gap-5 border border-rule bg-panel-1 p-6">
        {result.intelligence.mode === 'mock' && <p className="text-heading text-hi">MOCK DATA — no live Nansen request was made.</p>}
        {result.model.mode === 'mock' && <p className="text-heading text-hi">MOCK ASSESSMENT — no language model was called.</p>}
        <dl className="grid gap-2 text-body text-primary">
          <dt>Wallet</dt><dd className="break-all">{result.walletAddress}</dd>
          <dt>Data sources</dt><dd>{result.dataSources.join(', ')}</dd>
          <dt>Intelligence chain</dt><dd>{result.intelligence.chain}</dd>
          <dt>Observation window</dt><dd>{result.intelligence.window.from} to {result.intelligence.window.to}</dd>
          <dt>Risk level</dt><dd>{result.riskLevel}</dd>
          <dt>Recommendation</dt><dd>{result.assessment.recommendation}</dd>
          <dt>Model</dt><dd>{result.model.id}</dd>
          <dt>Timestamp</dt><dd>{result.timestamp}</dd>
        </dl>
        <h2 className="text-heading text-hi">Trust signals</h2>
        <ul className="list-disc space-y-2 pl-5 text-body text-primary">{result.trustSignals.map(signal => <li key={signal.name}>{signal.description} Source: {signal.source}</li>)}</ul>
        <h2 className="text-heading text-hi">Risk factors</h2>
        <ul className="list-disc space-y-2 pl-5 text-body text-primary">{result.riskFactors.map(factor => <li key={factor.name}>{factor.severity}: {factor.description}</li>)}</ul>
        <h2 className="text-heading text-hi">Assessment</h2>
        <p className="text-body text-primary">{result.assessment.reasoning}</p>
        <p className="text-body text-muted">{result.assessment.caveat}</p>
        <p className="break-all text-body text-muted">Assessment hash: {result.verdictHash}</p>
        <p className="text-body text-muted">The hash commits to the recorded assessment. It does not prove model correctness or independently prove what the model saw.</p>
        {result.assessment.recommendation === 'HIRE'
          ? <Link className="text-body text-accent-text underline" href={`/create?seller=${encodeURIComponent(result.walletAddress)}`}>Proceed to Escrow</Link>
          : <p className="text-body text-hi">Trust assessment recommends avoiding this counterparty.</p>}
      </section>}
    </div>
  );
}
