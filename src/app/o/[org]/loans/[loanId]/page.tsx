import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { formatMoney } from '@/ledger/money';
import { foldLedger, loanDetail } from '@/ledger/views';
import { requireLoan, viewDate, withLedger } from '../access';
import { AsOfBar } from '../AsOfBar';
import { StateBadge } from '../StateBadge';
import { LedgerTable } from './LedgerTable';

export const metadata = { title: 'Loan detail' };

const ADJUST_MSG = /^(Fee waived\.|Loan written off\.|Refused: [a-z_]+)$/;

// Servicer only: schedule against cash received, every ledger line, state as of the day.
export default async function LoanDetailPage({ params, searchParams }: { params: Promise<{ org: string; loanId: string }>; searchParams: Promise<{ asOf?: string; msg?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { loanId } = await params;
  await requireLoan(ctx, loanId, 'servicer');
  const sp = await searchParams;
  const asOf = viewDate(sp.asOf);
  const d = await withLedger((c) => loanDetail(c, { loanId, asOf }));
  const o = d.owed;
  const dates = Object.fromEntries(d.ledger.map((l) => [l.entryId, l.date]));
  const reversed = d.ledger.filter((l) => l.reversesEntryId).map((l) => l.reversesEntryId!);
  const waivable = d.ledger.filter((l) => l.kind === 'late_fee' && !reversed.includes(l.entryId)).map((l) => l.entryId);
  const action = `/o/${ctx.slug}/loans/${loanId}/adjust`;
  // `?msg=` is the adjust route's result; show only the shapes it sends, so a crafted link cannot put its own words here
  const msg = typeof sp.msg === 'string' && ADJUST_MSG.test(sp.msg) ? sp.msg : null;
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
        {msg && <p role="status" className="card" style={{ padding: '10px 16px', margin: 0 }}>{msg}</p>}
        {d.status.state === 'default_recommended' && (
          <section className="card" style={{ padding: '14px 16px' }}>
            <h2>Write off</h2>
            <form method="post" action={action}>
              <p style={{ margin: '0 0 8px' }}>Moves principal, interest and fees out of receivables. It cannot be undone, and later payments are refused.</p>
              <input name="reason" required placeholder="Reason" aria-label="Reason for write-off" />{' '}
              <label><input type="checkbox" name="confirm" value="yes" required /> I understand this cannot be undone</label>{' '}
              <button type="submit">Write off loan</button>
            </form>
          </section>
        )}
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
          <LedgerTable items={foldLedger(d.ledger)} dates={dates} reversed={reversed} waivable={waivable} action={action} />
        </section>
      </main>
    </>
  );
}
