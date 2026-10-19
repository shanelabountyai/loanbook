import type { Role } from '@/generated/prisma/enums';

// D30: who services and who borrows, as explicit lists on the template's roles. Pure (no db), so it is the one place
// every loan page, the adjust route, the org nav and the Members page ask. A role in neither list (scorekeeper, from
// saas-foundation v1.3.0, or any later one) gets no LoanBook access at all: never `role !== 'member'`.

/** An org's owners and admins service its loans (D21). */
export const isServicer = (role: Role): boolean => role === 'owner' || role === 'admin';

/** A member is a borrower (D21): they see only loans whose LoanAccess row names them. */
export const isBorrowerRole = (role: Role): boolean => role === 'member';

export type LoanRole = 'servicer' | 'borrower';

/** Pure. A loan outside the org (no row) is no one's; a member who is not the borrower gets nothing; a role that is
 *  neither servicer nor borrower (D30: scorekeeper) gets nothing. */
export const loanRole = (ctx: { role: Role; userId: string }, access: { borrowerUserId: string } | null): LoanRole | null =>
  !access ? null
  : isServicer(ctx.role) ? 'servicer'
  : isBorrowerRole(ctx.role) && access.borrowerUserId === ctx.userId ? 'borrower'
  : null;
