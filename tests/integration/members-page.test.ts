// D29: a member is a borrower (D21), and the Members page is the lender's list of everyone's email: closed to that role.
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it } from 'vitest';
import OrgLayout from '@/app/o/[org]/layout';
import Members from '@/app/o/[org]/settings/members/page';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { resetAuthTables } from '../helpers/auth';

beforeEach(resetAuthTables);

const params = Promise.resolve({ org: 'acme' });
const page = async () => renderToStaticMarkup(await Members({ params }));
const nav = async () => renderToStaticMarkup(await OrgLayout({ children: null, params }));

it('a borrower gets not-found from the Members page and no link to it; servicers still see every member', async () => {
  const org = await makeOrg();
  const owner = await addMember(org.id, 'owner', 'owner@example.test');
  const admin = await addMember(org.id, 'admin', 'admin@example.test');
  const borrower = await addMember(org.id, 'member', 'borrower@example.test');
  await addMember(org.id, 'member', 'other-borrower@example.test');

  await actAs(borrower.id, org.slug);
  await expect(page()).rejects.toThrow('notFound');
  expect(await nav()).not.toContain('settings/members');

  for (const servicer of [owner, admin]) {
    await actAs(servicer.id, org.slug);
    const html = await page();
    for (const email of ['owner@example.test', 'admin@example.test', 'borrower@example.test', 'other-borrower@example.test']) expect(html).toContain(email);
    expect(await nav()).toContain('settings/members');
  }
});
