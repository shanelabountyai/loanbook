import { requireOrg } from '@/core/authz/guards';
import { formatMoney } from '@/ledger/money';
import { loanStatement } from '@/ledger/views';
import { requireLoan, withLedger } from '../../access';

export const metadata = { title: 'Statement' };

// The borrower's statement (their own loan only) and the servicer's copy: payments with their split, balance owed.
export default async function StatementPage({ params }: { params: Promise<{ org: string; loanId: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { loanId } = await params;
  await requireLoan(ctx, loanId);
  const s = await withLedger((c) => loanStatement(c, loanId));
  const o = s.owed;
  return (
    <main>
      <div className="head">
        <h1>Statement for loan {loanId}</h1>
        <a className="dl" href={`/o/${ctx.slug}/loans/${loanId}/statement/csv`} download>Download CSV</a>
      </div>
      <section className="card scroll">
        <h2>Payments</h2>
        <table aria-label="Payments">
          <thead><tr><th>Date</th><th className="n">Paid</th><th className="n">Fees</th><th className="n">Interest</th><th className="n">Principal</th></tr></thead>
          <tbody>
            {s.payments.map((p) => (
              <tr key={p.entryId}>
                <td className="mono">{p.date}</td><td className="n">{formatMoney(p.cents)}</td><td className="n">{formatMoney(p.split.fees)}</td><td className="n">{formatMoney(p.split.interest)}</td><td className="n">{formatMoney(p.split.principal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.payments.length === 0 && <p className="empty">No payments yet.</p>}
        <p className="owed">Balance owed <strong className="n">{formatMoney(o.principal + o.interest + o.fees)}</strong>: principal <span className="n">{formatMoney(o.principal)}</span>, interest <span className="n">{formatMoney(o.interest)}</span>, fees <span className="n">{formatMoney(o.fees)}</span>.</p>
      </section>
    </main>
  );
}
