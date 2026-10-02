import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { formatCents } from '@/ledger/money';
import { loanDetail } from '@/ledger/views';
import { requireLoan, viewDate, withLedger } from '../access';

export const metadata = { title: 'Loan detail' };

// Servicer only: schedule against cash received, every ledger line, state as of the day.
export default async function LoanDetailPage({ params, searchParams }: { params: Promise<{ org: string; loanId: string }>; searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { loanId } = await params;
  await requireLoan(ctx, loanId, 'servicer');
  const asOf = viewDate((await searchParams).asOf);
  const d = await withLedger((c) => loanDetail(c, { loanId, asOf }));
  const o = d.owed;
  return (
    <main>
      <h1>Loan {loanId}</h1>
      <p>
        {formatCents(d.terms.principalCents)} at {d.terms.aprBps} bps over {d.terms.termMonths} months, disbursed {d.terms.disbursementDate}.{' '}
        <Link href={`/o/${ctx.slug}/loans/${loanId}/statement`}>Statement</Link>
      </p>
      <p>As of {asOf}: <strong>{d.status.state}</strong>, {d.status.dpd} days past due.</p>
      <p>Owed: principal {formatCents(o.principal)}, interest {formatCents(o.interest)}, fees {formatCents(o.fees)}.</p>
      <table aria-label="Schedule">
        <thead><tr><th>#</th><th>Due</th><th>Scheduled</th><th>Covered</th></tr></thead>
        <tbody>
          {d.schedule.map((r) => (
            <tr key={r.n}><td>{r.n}</td><td>{r.dueDate}</td><td>{formatCents(r.paymentCents)}</td><td>{formatCents(r.coveredCents)}</td></tr>
          ))}
        </tbody>
      </table>
      <table aria-label="Ledger">
        <thead><tr><th>Date</th><th>Memo</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
        <tbody>
          {d.ledger.map((l, i) => (
            <tr key={i}><td>{l.date}</td><td>{l.memo}</td><td>{l.account}</td><td>{l.debitCents ? formatCents(l.debitCents) : ''}</td><td>{l.creditCents ? formatCents(l.creditCents) : ''}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
