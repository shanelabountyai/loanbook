import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';
import { PAYMENT_ORDER } from '@/ledger/config';
import { runStatus } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { postPayment } from '@/ledger/payment';

// Task 4.4: the three servicing views and the borrower/servicer boundary (D21), against the production build.
// Each run seeds its own org: an owner (servicer), two members who each borrow one loan, and an owner elsewhere.
// Loan A follows DQ3 (short payment, late fee, cover on 03-01); loan B follows DQ2 (nothing paid). AM1's terms.

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
test.afterAll(() => db.end());

const am1 = JSON.parse(readFileSync('fixtures/amortization/AM1.json', 'utf8')).input;
const dq3 = JSON.parse(readFileSync('fixtures/delinquency/DQ3.json', 'utf8'));
const AS_OF = '2026-03-01';

async function user(orgId: string, role: 'owner' | 'member') {
  const [id, token] = [randomUUID(), randomBytes(32).toString('base64url')];
  await db.query('INSERT INTO "User" (id, email, "totpEnrolledAt", "updatedAt") VALUES ($1, $2, $3, now())', [id, `${id}@example.test`, role === 'owner' ? new Date() : null]);
  await db.query('INSERT INTO "Membership" ("orgId", "userId", role, "updatedAt") VALUES ($1, $2, $3, now())', [orgId, id, role]);
  await db.query(
    `INSERT INTO "Session" (hash, "userId", "authAt", "mfaAt", "createdAt", "expiresAt") VALUES ($1, $2, now(), now(), now(), now() + interval '1 hour')`,
    [createHash('sha256').update(token).digest('hex'), id],
  );
  return { id, token };
}

async function org() {
  const id = randomUUID();
  const slug = `e2e-loans-${id.slice(0, 8)}`;
  await db.query('INSERT INTO "Org" (id, slug, name, "updatedAt") VALUES ($1, $2, $2, now())', [id, slug]);
  return { id, slug };
}

async function seed() {
  const lender = await org();
  const elsewhere = await org();
  const [owner, alice, bob, stranger] = [await user(lender.id, 'owner'), await user(lender.id, 'member'), await user(lender.id, 'member'), await user(elsewhere.id, 'owner')];
  const terms = { principalCents: am1.principal_cents, aprBps: am1.apr_bps, termMonths: am1.term_months, disbursementDate: am1.disbursement_date };
  const c = await db.connect();
  try {
    const a = (await createLoan(c, terms)).loanId;
    const b = (await createLoan(c, terms)).loanId;
    for (const [loanId, borrower] of [[a, alice.id], [b, bob.id]]) {
      await c.query('INSERT INTO "LoanAccess" ("loanId", "orgId", "borrowerUserId") VALUES ($1, $2, $3)', [loanId, lender.id, borrower]);
    }
    for (const p of dq3.input.payments as { date: string; cents: number }[]) {
      await runAccrual(c, { asOf: p.date });
      await runStatus(c, { asOf: p.date });
      await postPayment(c, { loanId: a, date: p.date, paymentCents: p.cents, order: PAYMENT_ORDER });
    }
    await runStatus(c, { asOf: AS_OF });
    return { lender, elsewhere, owner, alice, stranger, a, b };
  } finally {
    c.release();
  }
}

let s: Awaited<ReturnType<typeof seed>>;
test.beforeAll(async () => { s = await seed(); });

const as = (context: BrowserContext, who: { token: string }) =>
  context.addCookies([{ name: '__Host-session', value: who.token, domain: 'localhost', path: '/', secure: true }]);
const notFound = async (page: Page, url: string) => expect((await page.goto(url))!.status()).toBe(404);
const row = (page: Page, table: string, text: string) => page.getByRole('table', { name: table }).getByRole('row').filter({ hasText: text });

test('book overview: both loans in their D18 bands, linked to their detail', async ({ page, context }) => {
  await as(context, s.owner);
  await page.goto(`/o/${s.lender.slug}/loans?asOf=${AS_OF}`);
  await expect(page.getByRole('heading', { name: 'Book overview' })).toBeVisible();
  await expect(row(page, 'Delinquency buckets', 'current')).toContainText('1');
  await expect(row(page, 'Delinquency buckets', 'delinquent_30')).toContainText('1');
  await expect(row(page, 'Loans', s.b)).toContainText('delinquent_30');
  await expect(row(page, 'Loans', s.b)).toContainText('14');
  await page.getByRole('link', { name: s.a }).click();
  await expect(page.getByRole('heading', { name: `Loan ${s.a}` })).toBeVisible();
});

test('loan detail: state, schedule covered against cash, ledger lines', async ({ page, context }) => {
  await as(context, s.owner);
  await page.goto(`/o/${s.lender.slug}/loans/${s.a}?asOf=${AS_OF}`);
  await expect(page.getByText('current, 0 days past due')).toBeVisible();
  await expect(row(page, 'Schedule', '2026-02-15')).toContainText('$172.55');
  await expect(row(page, 'Schedule', '2026-02-15').getByRole('cell').nth(3)).toHaveText('$172.55');
  await expect(row(page, 'Schedule', '2026-03-15').getByRole('cell').nth(3)).toHaveText('$0.00');
  await expect(row(page, 'Ledger', 'fees_receivable').first()).toContainText('$15.00');
});

test('borrower statement: each payment with its split, the late fee first', async ({ page, context }) => {
  await as(context, s.alice);
  await page.goto(`/o/${s.lender.slug}/loans`);
  await page.getByRole('link', { name: `Statement for loan ${s.a}` }).click();
  await expect(page.getByRole('heading', { name: `Statement for loan ${s.a}` })).toBeVisible();
  await expect(row(page, 'Payments', '2026-02-15').getByRole('cell').nth(1)).toHaveText('$100.00');
  await expect(row(page, 'Payments', '2026-02-15').getByRole('cell').nth(2)).toHaveText('$0.00');
  await expect(row(page, 'Payments', '2026-03-01').getByRole('cell').nth(1)).toHaveText('$72.55');
  await expect(row(page, 'Payments', '2026-03-01').getByRole('cell').nth(2)).toHaveText('$15.00');
  await expect(page.getByText(/^Balance owed/)).toContainText('fees $0.00');
});

test('role boundary: a borrower sees only their own loan, and only its statement', async ({ page, context }) => {
  await as(context, s.alice);
  await page.goto(`/o/${s.lender.slug}/loans`);
  await expect(page.getByRole('heading', { name: 'Your loans' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Statement for loan/ })).toHaveCount(1);
  await expect(page.getByText('Book overview')).toHaveCount(0);
  await notFound(page, `/o/${s.lender.slug}/loans/${s.b}/statement`); // someone else's loan
  await notFound(page, `/o/${s.lender.slug}/loans/${s.a}`); // own loan, servicer view
  await notFound(page, `/o/${s.lender.slug}/loans/${s.b}`);
});

test('role boundary: a servicer of another org sees nothing of this book', async ({ page, context }) => {
  await as(context, s.stranger);
  await notFound(page, `/o/${s.lender.slug}/loans`);
  await notFound(page, `/o/${s.lender.slug}/loans/${s.a}/statement`);
  await notFound(page, `/o/${s.elsewhere.slug}/loans/${s.a}/statement`); // their own org, this book's loan id
  await notFound(page, `/o/${s.elsewhere.slug}/loans/${s.a}`);
});

test('aging report: loans regrouped by band, reconciles to the book, expands to loans, servicer only', async ({ page, context }) => {
  await as(context, s.owner);
  await page.goto(`/o/${s.lender.slug}/loans/aging?asOf=${AS_OF}`);
  await expect(page.getByRole('heading', { name: 'Aging report' })).toBeVisible();
  await expect(row(page, 'Aging', 'delinquent_30').getByRole('cell').first()).toHaveText('1');
  await expect(page.getByRole('status')).toContainText('Reconciles.');
  await expect(page.getByRole('link', { name: s.b })).toHaveCount(0); // bands start collapsed
  await page.getByRole('button', { name: 'Expand all' }).click();
  await expect(row(page, 'Aging', s.b)).toContainText('Delinquent 30+');
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.getByRole('link', { name: s.b })).toHaveCount(0);
  await as(context, s.alice);
  await notFound(page, `/o/${s.lender.slug}/loans/aging`);
});
