import Link from 'next/link';
import { requireOrg } from '@/core/authz/guards';
import { db } from '@/core/db';
import { formatMoney } from '@/ledger/money';
import { bookOverview } from '@/ledger/views';
import { isServicer, viewDate, withLedger } from '../access';
import { AsOfBar } from '../AsOfBar';
import { AgingTable, type AgingBand } from './AgingTable';
import { notFound } from 'next/navigation';

export const metadata = { title: 'Aging report' };

const BANDS: Record<string, [string, string]> = {
  current: ['Current', '0 days'], grace: ['1–10 days', '1–10 days'], delinquent_30: ['11–59 days', '11–59 days'], delinquent_60: ['60–89 days', '60–89 days'],
  delinquent_90: ['90–119 days', '90–119 days'], default_recommended: ['120+ days', '120+ days'], written_off: ['Written off', 'terminal, dpd frozen'],
};

// Servicer only. The bands are the D18 states, so this is the book overview's loans regrouped with each loan's principal/interest/fees split.
export default async function AgingPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireOrg((await params).org);
  if (!isServicer(ctx.role)) notFound(); // D30: borrowers and any non-servicer role
  const asOf = viewDate((await searchParams).asOf);
  const base = `/o/${ctx.slug}/loans`;
  const access = await db.loanAccess.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: 'asc' }, select: { loanId: true } });
  const book = await withLedger((c) => bookOverview(c, { loanIds: access.map((a) => a.loanId), asOf }));
  const bands: AgingBand[] = book.buckets.map((b) => ({
    state: b.state, label: BANDS[b.state]![0], range: BANDS[b.state]![1],
    loans: book.loans.filter((l) => l.state === b.state).sort((x, y) => y.dpd - x.dpd).map((l) => ({ loanId: l.loanId, state: l.state, dpd: l.dpd, principal: l.owed.principal, interest: l.owed.interest, fees: l.owed.fees })),
  }));
  const bandSum = book.buckets.reduce((a, b) => a + b.outstandingCents, 0);
  const total = book.outstanding.principal + book.outstanding.interest + book.outstanding.fees;
  return (
    <>
      <AsOfBar asOf={asOf} path={`${base}/aging`} />
      <main>
        <div className="head">
          <div>
            <div className="kicker"><Link href={`${base}?asOf=${asOf}`}>Book overview</Link> ›</div>
            <h1>Aging report</h1>
          </div>
          <span className={`chip mono${asOf < viewDate(undefined) ? ' past' : ''}`}>As of {asOf}</span>
        </div>
        <section className="card">
          <div className="tools-head">
            <h2>Outstanding by days past due</h2>
            <div className="legend muted" aria-hidden="true"><span><i style={{ background: 'var(--ink2)' }} />Principal</span><span><i style={{ background: 'var(--accent)' }} />Interest</span><span><i style={{ background: 'var(--paststripe)' }} />Fees</span></div>
          </div>
          <AgingTable bands={bands} base={base} asOf={asOf} />
          <p className="owed" role="status">
            <strong>{bandSum === total ? 'Reconciles.' : 'Does not reconcile.'}</strong>{' '}
            <span className="muted">Sum of bands {formatMoney(bandSum)} {bandSum === total ? 'equals' : 'vs'} the book overview total {formatMoney(total)} as of {asOf}.</span>
          </p>
        </section>
      </main>
    </>
  );
}
