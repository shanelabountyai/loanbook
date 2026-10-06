import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { formatMoney } from '@/ledger/money';
import { loanDetail } from '@/ledger/views';
import { requireLoan, viewDate, withLedger } from '../access';
import { AsOfBar } from '../AsOfBar';
import { StateBadge } from '../StateBadge';

export const metadata = { title: 'Loan detail' };

// Servicer only: schedule against cash received, every ledger line, state as of the day.
export default async function LoanDetailPage({ params, searchParams }: { params: Promise<{ org: string; loanId: string }>; searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { loanId } = await params;
  await requireLoan(ctx, loanId, 'servicer');
  const asOf = viewDate((await searchParams).asOf);
  const d = await withLedger((c) => loanDetail(c, { loanId, asOf }));
  const o = d.owed;
  const status = (r: { dueDate: string; paymentCents: number; coveredCents: number }) =>
    r.coveredCents >= r.paymentCents ? ['●', 'Paid', ''] : r.coveredCents > 0 ? ['◐', 'Partly paid', ''] : r.dueDate < asOf ? ['○', 'Missed', 'missed'] : ['·', 'Upcoming', 'muted'];
  return (
    <>
      <AsOfBar asOf={asOf} path={`/o/${ctx.slug}/loans/${loanId}`} />
      <main>
        <div className="head">
          <div>
            <div className="kicker"><Link href={`/o/${ctx.slug}/loans?asOf=${asOf}`}>Book overview</Link> ›</div>
            <h1>Loan {loanId}</h1>
          </div>
          <StateBadge state={d.status.state} showKey />
        </div>
        <section className="card" style={{ padding: '14px 16px' }}>
          <p style={{ margin: 0 }}>
            <span className="n">{formatMoney(d.terms.principalCents)}</span> at <span className="n">{(d.terms.aprBps / 100).toFixed(2)}%</span> APR ({d.terms.aprBps} bps) over {d.terms.termMonths} months, disbursed <span className="mono">{d.terms.disbursementDate}</span>.{' '}
            <Link href={`/o/${ctx.slug}/loans/${loanId}/statement`}>Statement</Link>
          </p>
          <p>As of {asOf}: <strong>{d.status.state}</strong>, {d.status.dpd} days past due.</p>
          <p style={{ margin: 0 }}>Owed: principal <span className="n">{formatMoney(o.principal)}</span>, interest <span className="n">{formatMoney(o.interest)}</span>, fees <span className="n">{formatMoney(o.fees)}</span>.</p>
        </section>
        <section className="card scroll">
          <h2>Schedule</h2>
          <table aria-label="Schedule">
            <thead><tr><th>#</th><th>Due</th><th className="n">Scheduled</th><th className="n">Covered</th><th>Status</th></tr></thead>
            <tbody>
              {d.schedule.map((r) => {
                const [glyph, word, cls] = status(r);
                return (
                  <tr key={r.n}>
                    <td>{r.n}</td><td className="mono">{r.dueDate}</td><td className="n">{formatMoney(r.paymentCents)}</td><td className="n">{formatMoney(r.coveredCents)}</td>
                    <td className={cls}><span aria-hidden="true">{glyph}</span> {word}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
        <section className="card scroll">
          <h2>Ledger</h2>
          <table aria-label="Ledger">
            <thead><tr><th>Date</th><th>Memo</th><th>Account</th><th className="n">Debit</th><th className="n">Credit</th></tr></thead>
            <tbody>
              {d.ledger.map((l, i) => (
                <tr key={i}>
                  <td className="mono">{l.date}</td><td>{l.memo}</td><td className={`mono${l.creditCents ? ' acct-credit' : ''}`}>{l.account}</td>
                  <td className="n">{l.debitCents ? formatMoney(l.debitCents) : ''}</td><td className="n">{l.creditCents ? formatMoney(l.creditCents) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
