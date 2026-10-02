import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { formatCents } from '@/ledger/money';
import { bookOverview } from '@/ledger/views';
import { viewDate, withLedger } from './access';
import { AsOfBar } from './AsOfBar';
import { StateBadge } from './StateBadge';

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
        <div className="head"><h1>Your loans</h1></div>
        {mine.length === 0 && <p>No loans.</p>}
        <ul className="card" style={{ listStyle: 'none', padding: '8px 16px' }}>
          {mine.map((l) => (
            <li key={l.loanId} style={{ padding: '6px 0' }}><Link href={`${base}/${l.loanId}/statement`}>Statement for loan {l.loanId}</Link></li>
          ))}
        </ul>
      </main>
    );
  }

  const access = await db.loanAccess.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' }, select: { loanId: true } });
  const book = await withLedger((c) => bookOverview(c, { loanIds: access.map((a) => a.loanId), asOf }));
  const o = book.outstanding;
  const total = o.principal + o.interest + o.fees;
  const open = book.loans.filter((l) => l.outstandingCents > 0).length;
  return (
    <>
      <AsOfBar asOf={asOf} path={base} />
      <main>
        <div className="head">
          <div>
            <div className="kicker">Servicing</div>
            <h1>Book overview</h1>
          </div>
          <span className={`chip mono${asOf < viewDate(undefined) ? ' past' : ''}`}>As of {asOf}</span>
        </div>
        <section className="card stats" aria-label="Total outstanding">
          <div className="stat big">
            <div className="label">Total outstanding</div>
            <div className="n">{formatCents(total)}</div>
            <div className="kicker">{open} open of {book.loans.length} loans</div>
          </div>
          {([['Principal', o.principal, 'loans_receivable'], ['Interest', o.interest, 'interest_receivable'], ['Fees', o.fees, 'fees_receivable']] as const).map(([label, cents, acct]) => (
            <div className="stat" key={label}>
              <div className="label">{label}</div>
              <div className="n">{formatCents(cents)}</div>
              <div className="acct mono">{acct}</div>
            </div>
          ))}
        </section>
        <section className="card">
          <h2>Delinquency</h2>
          <table aria-label="Delinquency buckets">
            <thead><tr><th>State</th><th className="n">Loans</th><th className="n">Outstanding</th></tr></thead>
            <tbody>
              {book.buckets.map((b) => (
                <tr key={b.state}><th scope="row"><StateBadge state={b.state} showKey /></th><td className="n">{b.count}</td><td className="n">{formatCents(b.outstandingCents)}</td></tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row">Total</th><td className="n">{book.loans.length}</td><td className="n">{formatCents(total)}</td></tr></tfoot>
          </table>
        </section>
        <section className="card scroll">
          <h2>Loans</h2>
          <table aria-label="Loans">
            <thead><tr><th>Loan</th><th>State</th><th className="n">Days past due</th><th className="n">Outstanding</th></tr></thead>
            <tbody>
              {book.loans.map((l) => (
                <tr key={l.loanId}>
                  <td><Link className="mono" href={`${base}/${l.loanId}?asOf=${asOf}`}>{l.loanId}</Link></td>
                  <td><StateBadge state={l.state} showKey /></td><td className="n">{l.dpd}</td><td className="n">{formatCents(l.outstandingCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
