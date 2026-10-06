import { requireOrg } from '@/core/authz/guards';
import { decimalCents } from '@/ledger/money';
import { loanStatement } from '@/ledger/views';
import { requireLoan, withLedger } from '../../../access';

// The statement's payments as CSV: same guard as the page (servicer, or that loan's borrower). Dates and decimal dollars only, so nothing needs quoting.
export async function GET(_req: Request, { params }: { params: Promise<{ org: string; loanId: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { loanId } = await params;
  await requireLoan(ctx, loanId);
  const s = await withLedger((c) => loanStatement(c, loanId));
  const lines = ['date,paid,fees,interest,principal', ...s.payments.map((p) => [p.date, ...[p.cents, p.split.fees, p.split.interest, p.split.principal].map(decimalCents)].join(','))];
  return new Response(`${lines.join('\r\n')}\r\n`, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="statement-${loanId}.csv"`, 'Cache-Control': 'private, no-store' },
  });
}
