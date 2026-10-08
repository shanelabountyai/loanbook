import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { formatMoney } from '@/ledger/money';
import { bookOverview, loanDetail, nextDue, type BookLoan } from '@/ledger/views';
import { viewDate, withLedger } from './access';
import { AsOfBar } from './AsOfBar';
import { StateBadge } from './StateBadge';

export const metadata = { title: 'Loans' };

// Loan-list sort keys (`?sort=dpd`, `?sort=-dpd` for descending). Anything else in the URL is ignored.
const SORT = { loan: (l: BookLoan) => l.loanId, dpd: (l: BookLoan) => l.dpd, outstanding: (l: BookLoan) => l.outstandingCents };

// Servicers see the book; a borrower sees only the loans they borrow, each linking to its statement.
export default async function Loans({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ asOf?: string; sort?: string; state?: string }> }) {
  const ctx = await requireOrg((await params).org);
  const sp = await searchParams;
  const asOf = viewDate(sp.asOf);
  const base = `/o/${ctx.slug}/loans`;

  if (ctx.role === 'member') {
    const mine = await db.loanAccess.findMany({ where: { orgId: ctx.orgId, borrowerUserId: ctx.userId }, orderBy: { createdAt: 'asc' } });
    const today = viewDate(undefined);
    const loans = await withLedger(async (c) => {
      const out = [];
      for (const l of mine) out.push(await loanDetail(c, { loanId: l.loanId, asOf: today })); // one at a time: loanStatus holds a transaction on c
      return out;
    });
    return (
      <main>
        <div className="head"><h1>Your loans</h1></div>
        {loans.length === 0 ? <p>No loans.</p> : (
          <section className="card scroll">
            <table aria-label="Your loans">
              <thead><tr><th>Loan</th><th>Status</th><th>Next payment due</th><th className="n">Left to pay on it</th></tr></thead>
              <tbody>
                {loans.map((l) => {
                  const due = nextDue(l);
                  return (
                    <tr key={l.loanId}>
                      <td><Link href={`${base}/${l.loanId}/statement`}>Statement for loan {l.loanId}</Link></td>
                      <td><StateBadge state={l.status.state} /></td>
                      <td className="mono">{due?.dueDate ?? '—'}</td>
                      <td className="n">{due ? formatMoney(due.cents) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </main>
    );
  }

  const access = await db.loanAccess.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' }, select: { loanId: true } });
  const book = await withLedger((c) => bookOverview(c, { loanIds: access.map((a) => a.loanId), asOf }));
  const o = book.outstanding;
  const total = o.principal + o.interest + o.fees;
  const open = book.loans.filter((l) => l.outstandingCents > 0).length;

  const sort = typeof sp.sort === 'string' && Object.hasOwn(SORT, sp.sort.replace(/^-/, '')) ? sp.sort : undefined;
  const sortKey = sort?.replace(/^-/, '') as keyof typeof SORT | undefined;
  const desc = sort?.startsWith('-') ?? false;
  const state = book.buckets.find((b) => b.state === sp.state)?.state;
  const shown = book.loans.filter((l) => !state || l.state === state);
  if (sortKey) shown.sort((a, b) => { const [x, y] = [SORT[sortKey](a), SORT[sortKey](b)]; return (x < y ? -1 : x > y ? 1 : 0) * (desc ? -1 : 1); });
  const q = (over: { sort?: string; state?: string }) => {
    const p = new URLSearchParams({ asOf });
    for (const [k, v] of Object.entries({ sort, state, ...over })) if (v) p.set(k, v);
    return `${base}?${p}`;
  };
  const th = (key: keyof typeof SORT, label: string, num?: boolean) => {
    const cur = sortKey === key;
    return (
      <th className={num ? 'n' : undefined} aria-sort={cur ? (desc ? 'descending' : 'ascending') : undefined}>
        <Link href={q({ sort: cur && !desc ? `-${key}` : key })}>{label}{cur && <span aria-hidden="true">{desc ? ' ↓' : ' ↑'}</span>}</Link>
      </th>
    );
  };
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
            <div className="n">{formatMoney(total)}</div>
            <div className="kicker">{open} open of {book.loans.length} loans · <Link href={`${base}/aging?asOf=${asOf}`}>Trace by age ›</Link></div>
          </div>
          {([['Principal', o.principal, 'loans_receivable'], ['Interest', o.interest, 'interest_receivable'], ['Fees', o.fees, 'fees_receivable']] as const).map(([label, cents, acct]) => (
            <div className="stat" key={label}>
              <div className="label">{label}</div>
              <div className="n">{formatMoney(cents)}</div>
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
                <tr key={b.state}><th scope="row"><StateBadge state={b.state} showKey /></th><td className="n">{b.count}</td><td className="n">{formatMoney(b.outstandingCents)}</td></tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row">Total</th><td className="n">{book.loans.length}</td><td className="n">{formatMoney(total)}</td></tr></tfoot>
          </table>
        </section>
        <section className="card scroll">
          <div className="tools-head">
            <h2>Loans</h2>
            <nav className="filters" aria-label="Filter loans by state">
              <Link className="chip mono" aria-current={state ? undefined : 'true'} href={q({ state: undefined })}>all {book.loans.length}</Link>
              {book.buckets.filter((b) => b.count > 0).map((b) => (
                <Link key={b.state} className="chip mono" aria-current={state === b.state ? 'true' : undefined} href={q({ state: b.state })}>{b.state} {b.count}</Link>
              ))}
            </nav>
          </div>
          <table aria-label="Loans">
            <thead><tr>{th('loan', 'Loan')}<th>State</th>{th('dpd', 'Days past due', true)}{th('outstanding', 'Outstanding', true)}</tr></thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.loanId}>
                  <td><Link className="mono" href={`${base}/${l.loanId}?asOf=${asOf}`}>{l.loanId}</Link></td>
                  <td><StateBadge state={l.state} showKey /></td><td className="n">{l.dpd}</td><td className="n">{formatMoney(l.outstandingCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
