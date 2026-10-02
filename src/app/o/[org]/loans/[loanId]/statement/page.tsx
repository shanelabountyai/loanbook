import { requireOrg } from '@/core/authz/guards';
import { formatCents } from '@/ledger/money';
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
      <h1>Statement for loan {loanId}</h1>
      <table aria-label="Payments">
        <thead><tr><th>Date</th><th>Paid</th><th>Fees</th><th>Interest</th><th>Principal</th></tr></thead>
        <tbody>
          {s.payments.map((p) => (
            <tr key={p.entryId}>
              <td>{p.date}</td><td>{formatCents(p.cents)}</td><td>{formatCents(p.split.fees)}</td><td>{formatCents(p.split.interest)}</td><td>{formatCents(p.split.principal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.payments.length === 0 && <p>No payments yet.</p>}
      <p>Balance owed {formatCents(o.principal + o.interest + o.fees)}: principal {formatCents(o.principal)}, interest {formatCents(o.interest)}, fees {formatCents(o.fees)}.</p>
    </main>
  );
}
