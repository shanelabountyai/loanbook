// D30: the scorekeeper role (saas-foundation v1.3.0) is neither servicer nor borrower, so it gets no LoanBook access:
// no book, no aging report, no statement, no adjust route, no Members page or link. Under the old `role !== 'member'`
// rule it was a servicer and every one of these let it in.
import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it } from 'vitest';
import OrgLayout from '@/app/o/[org]/layout';
import Loans from '@/app/o/[org]/loans/page';
import AgingPage from '@/app/o/[org]/loans/aging/page';
import { loanRole } from '@/app/o/[org]/loans/access';
import { POST as adjust } from '@/app/o/[org]/loans/[loanId]/adjust/route';
import Statement from '@/app/o/[org]/loans/[loanId]/statement/page';
import Members from '@/app/o/[org]/settings/members/page';
import { db } from '@/core/db';
import type { Role } from '@/generated/prisma/enums';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { resetAuthTables } from '../helpers/auth';

beforeEach(resetAuthTables);

it('a scorekeeper is refused every loan screen, the adjust route and the Members page', async () => {
  const org = await makeOrg();
  await addMember(org.id, 'owner', 'owner@example.test');
  const borrower = await addMember(org.id, 'member', 'borrower@example.test');
  const scorekeeper = await addMember(org.id, 'scorekeeper' as Role, 'scorekeeper@example.test');
  const loanId = randomUUID();
  await db.loanAccess.create({ data: { loanId, orgId: org.id, borrowerUserId: borrower.id } });

  const ctx = await actAs(scorekeeper.id, org.slug);
  expect(ctx.role).toBe('scorekeeper');
  expect(loanRole(ctx, { borrowerUserId: borrower.id })).toBeNull();

  const params = Promise.resolve({ org: org.slug });
  const loanParams = Promise.resolve({ org: org.slug, loanId });
  const searchParams = Promise.resolve({});
  await expect(Loans({ params, searchParams })).rejects.toThrow('notFound');
  await expect(AgingPage({ params, searchParams })).rejects.toThrow('notFound');
  await expect(Statement({ params: loanParams })).rejects.toThrow('notFound');
  const req = new Request(`http://localhost:4700/o/${org.slug}/loans/${loanId}/adjust`, {
    method: 'POST', headers: { origin: 'http://localhost:4700', host: 'localhost:4700' }, body: new URLSearchParams({ confirm: 'yes', reason: 'x' }),
  });
  await expect(adjust(req, { params: loanParams })).rejects.toThrow('notFound');
  await expect(Members({ params })).rejects.toThrow('notFound');
  expect(renderToStaticMarkup(await OrgLayout({ children: null, params }))).not.toContain('settings/members');
});
