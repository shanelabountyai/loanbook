'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { LoanState } from '@/ledger/config';
import { formatMoney } from '@/ledger/money';
import { StateBadge } from '../StateBadge';

export type AgingLoan = { loanId: string; state: LoanState; dpd: number; principal: number; interest: number; fees: number };
export type AgingBand = { state: LoanState; label: string; range: string; loans: AgingLoan[] };

const sum = (ls: AgingLoan[], k: 'principal' | 'interest' | 'fees') => ls.reduce((a, l) => a + l[k], 0);

/** The only client island on the report: which bands are open. Everything shown is computed on the server. */
export function AgingTable({ bands, base, asOf }: { bands: AgingBand[]; base: string; asOf: string }) {
  const [open, setOpen] = useState<Set<LoanState>>(new Set());
  const toggle = (s: LoanState) => setOpen((o) => { const n = new Set(o); if (!n.delete(s)) n.add(s); return n; });
  const all = bands.flatMap((b) => b.loans);
  const total = sum(all, 'principal') + sum(all, 'interest') + sum(all, 'fees');
  const pct = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  return (
    <>
      <div className="tools">
        <button type="button" onClick={() => setOpen(new Set(bands.filter((b) => b.loans.length).map((b) => b.state)))}>Expand all</button>
        <button type="button" onClick={() => setOpen(new Set())}>Collapse all</button>
      </div>
      <div className="scroll">
        <table aria-label="Aging" style={{ minWidth: 860 }}>
          <thead><tr><th>Days past due</th><th className="n">Loans</th><th className="n">Principal</th><th className="n">Interest</th><th className="n">Fees</th><th className="n">Total</th><th style={{ width: '24%' }}>Share of book</th></tr></thead>
          {bands.map((b) => {
            const [p, i, f] = [sum(b.loans, 'principal'), sum(b.loans, 'interest'), sum(b.loans, 'fees')];
            const isOpen = open.has(b.state) && b.loans.length > 0;
            return (
              <tbody key={b.state}>
                <tr className="band">
                  <th scope="row">
                    <button type="button" className="twisty" aria-expanded={isOpen} disabled={!b.loans.length} onClick={() => toggle(b.state)}>
                      <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> {b.label}
                    </button>
                    <span className="key mono">{b.state} · {b.range}</span>
                  </th>
                  <td className="n">{b.loans.length}</td><td className="n">{formatMoney(p)}</td><td className="n">{formatMoney(i)}</td><td className="n">{formatMoney(f)}</td><td className="n"><strong>{formatMoney(p + i + f)}</strong></td>
                  <td>
                    <div className="share"><div className="bar" aria-hidden="true"><i style={{ width: pct(p), background: 'var(--ink2)' }} /><i style={{ width: pct(i), background: 'var(--accent)' }} /><i style={{ width: pct(f), background: 'var(--paststripe)' }} /></div><span className="mono">{total ? (((p + i + f) / total) * 100).toFixed(1) : '0.0'}%</span></div>
                  </td>
                </tr>
                {b.state === 'written_off' && b.loans.length > 0 && <tr><td colSpan={7} className="muted fold-note">Written off to the write_offs account, so it is not part of outstanding. Days past due stays frozen at the write-off date.</td></tr>}
                {isOpen && b.loans.map((l) => (
                  <tr key={l.loanId} className="fold">
                    <th scope="row"><Link className="mono" href={`${base}/${l.loanId}?asOf=${asOf}`}>{l.loanId}</Link></th>
                    <td className="n muted">{l.dpd} days</td><td className="n">{formatMoney(l.principal)}</td><td className="n">{formatMoney(l.interest)}</td><td className="n">{formatMoney(l.fees)}</td><td className="n">{formatMoney(l.principal + l.interest + l.fees)}</td>
                    <td><StateBadge state={l.state} /></td>
                  </tr>
                ))}
              </tbody>
            );
          })}
          <tfoot><tr><th scope="row">Total outstanding</th><td className="n">{all.length}</td><td className="n">{formatMoney(sum(all, 'principal'))}</td><td className="n">{formatMoney(sum(all, 'interest'))}</td><td className="n">{formatMoney(sum(all, 'fees'))}</td><td className="n">{formatMoney(total)}</td><td>100.0%</td></tr></tfoot>
        </table>
      </div>
    </>
  );
}
