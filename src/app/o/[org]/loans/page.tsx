import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { formatCents } from '@/ledger/money';
import { bookOverview } from '@/ledger/views';
import { viewDate, withLedger } from './access';

export const metadata = { title: 'Loans' };

// Servicers see the book; a borrower sees only the loans they borrow, each linking to its statement.
export default async function Loans({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const asOf = viewDate((await searchParams).asOf);
  const base = `/o/${ctx.slug}/loans`;

  if (ctx.role === 'member') {
    const mine = await db.loanAccess.findMany({ where: { orgId: ctx.orgId, borrowerUserId: ctx.userId }, orderBy: { createdAt: 'asc' } });
    return (
      <main>
        <h1>Your loans</h1>
        {mine.length === 0 && <p>No loans.</p>}
        <ul>
          {mine.map((l) => (
            <li key={l.loanId}><Link href={`${base}/${l.loanId}/statement`}>Statement for loan {l.loanId}</Link></li>
          ))}
        </ul>
      </main>
    );
  }

  const access = await db.loanAccess.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' }, select: { loanId: true } });
  const book = await withLedger((c) => bookOverview(c, { loanIds: access.map((a) => a.loanId), asOf }));
  const o = book.outstanding;
  return (
    <main>
      <h1>Book overview</h1>
      <p>As of {asOf}. Outstanding {formatCents(o.principal + o.interest + o.fees)}: principal {formatCents(o.principal)}, interest {formatCents(o.interest)}, fees {formatCents(o.fees)}.</p>
      <table aria-label="Delinquency buckets">
        <thead><tr><th>State</th><th>Loans</th><th>Outstanding</th></tr></thead>
        <tbody>
          {book.buckets.map((b) => (
            <tr key={b.state}><td>{b.state}</td><td>{b.count}</td><td>{formatCents(b.outstandingCents)}</td></tr>
          ))}
        </tbody>
      </table>
      <table aria-label="Loans">
        <thead><tr><th>Loan</th><th>State</th><th>DPD</th><th>Outstanding</th></tr></thead>
        <tbody>
          {book.loans.map((l) => (
            <tr key={l.loanId}>
              <td><Link href={`${base}/${l.loanId}?asOf=${asOf}`}>{l.loanId}</Link></td>
              <td>{l.state}</td><td>{l.dpd}</td><td>{formatCents(l.outstandingCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
