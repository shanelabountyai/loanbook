import { notFound } from 'next/navigation';
import pg from 'pg';
import type { OrgCtx } from '@/core/authz/guards';
import { now } from '@/core/clock';
import { db } from '@/core/db';
import { env } from '@/core/env';
import { assertDate } from '@/ledger/calendar';

// The borrower/servicer split (task 4.4, D21), on the template's roles: an org's owner and admins service its
// loans; a member sees a loan only as the borrower named on its LoanAccess row. "Not yours" is notFound.

export type LoanRole = 'servicer' | 'borrower';

/** Pure. A loan outside the org (no row) is no one's; a member who is not the borrower gets nothing. */
export const loanRole = (ctx: Pick<OrgCtx, 'role' | 'userId'>, access: { borrowerUserId: string } | null): LoanRole | null =>
  !access ? null : ctx.role !== 'member' ? 'servicer' : access.borrowerUserId === ctx.userId ? 'borrower' : null;

/** Right after requireOrg on every loan page (FR-06 wants requireOrg first). `need: 'servicer'` refuses a borrower too. */
export async function requireLoan(ctx: OrgCtx, loanId: string, need?: LoanRole): Promise<LoanRole> {
  const access = await db.loanAccess.findFirst({ where: { loanId, orgId: ctx.orgId }, select: { borrowerUserId: true } });
  const role = loanRole(ctx, access);
  if (!role || (need && role !== need)) notFound();
  return role;
}

/** The date the views are computed for: `?asOf=YYYY-MM-DD`, else today (UTC) from the app clock. Domain code never reads it. */
export function viewDate(asOf: string | string[] | undefined): string {
  if (asOf === undefined) return now().toISOString().slice(0, 10);
  try {
    return assertDate(asOf);
  } catch {
    notFound();
  }
}

// The ledger functions take a pg connection of their own (loanStatus opens a read-only transaction on it).
const g = globalThis as unknown as { ledgerPool?: pg.Pool };
const pool = (g.ledgerPool ??= new pg.Pool({ connectionString: env.DATABASE_URL, max: 3 }));

export async function withLedger<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    return await fn(c);
  } finally {
    c.release();
  }
}
