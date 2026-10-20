import { requireOrg } from '@/core/authz/guards';
import { isSameOrigin } from '@/core/http';
import { EntryError } from '@/ledger/entry';
import { waiveFee, writeOff } from '@/ledger/delinquency';
import { requireLoan, viewDate, withLedger } from '../../access';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Servicer-only POST from the loan page: waive a late fee (field `entryId`) or write the loan off (field `confirm`).
// Posts dated today; the ledger functions do every refusal, this only maps them to a message on the page.
export async function POST(req: Request, { params }: { params: Promise<{ org: string; loanId: string }> }) {
  const ctx = await requireOrg((await params).org);
  const { loanId } = await params;
  await requireLoan(ctx, loanId, 'servicer');
  if (!isSameOrigin(req.headers)) return new Response(null, { status: 403 });
  const f = await req.formData();
  const str = (k: string) => (typeof f.get(k) === 'string' ? (f.get(k) as string) : '');
  const date = viewDate(undefined);
  let msg = '';
  try {
    await withLedger(async (c) => {
      if (f.has('entryId')) {
        // a malformed id names no entry: refuse it here, before Postgres's uuid cast turns it into a 500
        if (!UUID.test(str('entryId'))) throw new EntryError('dangling_reversal');
        const { rowCount } = await c.query('SELECT 1 FROM "LedgerEntry" WHERE "id" = $1::uuid AND "loanId" = $2', [str('entryId'), loanId]);
        if (!rowCount) throw new EntryError('dangling_reversal'); // an entry of another loan is the same as no entry
        await waiveFee(c, { entryId: str('entryId'), date, reason: str('reason') });
      } else if (str('confirm') === 'yes') await writeOff(c, { loanId, date, reason: str('reason') });
      else throw new EntryError('reason_required');
    });
    msg = f.has('entryId') ? 'Fee waived.' : 'Loan written off.';
  } catch (e) {
    if (!(e instanceof EntryError)) throw e;
    msg = `Refused: ${e.code}`;
  }
  return Response.redirect(new URL(`/o/${ctx.slug}/loans/${loanId}?msg=${encodeURIComponent(msg)}`, req.url), 303);
}
