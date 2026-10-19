import { expect, it } from 'vitest';
import { isBorrowerRole, isServicer, loanRole } from '@/app/o/[org]/loans/roles';
import type { Role } from '@/generated/prisma/enums';

// D30: servicer is an explicit owner/admin list. saas-foundation v1.3.0 added `scorekeeper`; under the old
// `role !== 'member'` rule it was a servicer. It must be neither servicer nor borrower.

const row = { borrowerUserId: 'u1' };
const roles: Role[] = ['owner', 'admin', 'member', 'scorekeeper' as Role];

it('servicer and borrower roles are explicit lists', () => {
  expect(roles.filter(isServicer)).toEqual(['owner', 'admin']);
  expect(roles.filter(isBorrowerRole)).toEqual(['member']);
});

it('a scorekeeper gets no loan role, even when the LoanAccess row names them', () => {
  for (const userId of ['u1', 'u2']) expect(loanRole({ role: 'scorekeeper' as Role, userId }, row)).toBeNull();
});

it('owner and admin service, the named member borrows, anyone else and any loan with no row gets nothing', () => {
  expect(loanRole({ role: 'owner', userId: 'x' }, row)).toBe('servicer');
  expect(loanRole({ role: 'admin', userId: 'x' }, row)).toBe('servicer');
  expect(loanRole({ role: 'member', userId: 'u1' }, row)).toBe('borrower');
  expect(loanRole({ role: 'member', userId: 'u2' }, row)).toBeNull();
  for (const role of roles) expect(loanRole({ role, userId: 'u1' }, null)).toBeNull();
});
