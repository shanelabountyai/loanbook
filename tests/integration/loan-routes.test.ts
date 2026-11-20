// The two loan route handlers, called the way Next calls them: the servicer-only adjust POST (waive a fee, write a
// loan off; D24, D25, D21, D30) and the statement CSV GET (servicer or that loan's borrower). The ledger functions
// own every money rule and are tested on their own; this holds the route's guards, its refusal mapping, that a
// refused or forbidden request writes nothing, and the CSV's bytes. e2e/loans.spec.ts drives the same routes
// through a browser; this runs without one.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import LoanDetailPage from '@/app/o/[org]/loans/[loanId]/page';
import { POST as adjust } from '@/app/o/[org]/loans/[loanId]/adjust/route';
import { GET as csv } from '@/app/o/[org]/loans/[loanId]/statement/csv/route';
import { advanceClock } from '@/core/clock';
import { db } from '@/core/db';
import { runAccrual } from '@/ledger/accrue';
import { addDays } from '@/ledger/calendar';
import { PAYMENT_ORDER } from '@/ledger/config';
import { runStatus } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { postPayment } from '@/ledger/payment';
import { verifyLedger } from '@/ledger/verify';
import { actAs, addMember, makeOrg } from '../helpers/org';
import { resetAuthTables } from '../helpers/auth';

type Day = { date: string; dpd: number; state: string };
type Dq = { input: { payments: { date: string; cents: number }[] }; expected: { days: Day[]; fees: { installment: number; date: string; cents: number }[] } };
const am1 = JSON.parse(readFileSync('fixtures/amortization/AM1.json', 'utf8')).input;
const ac4 = JSON.parse(readFileSync('fixtures/accrual/AC4_first_installment_period.json', 'utf8'));
const dq2 = JSON.parse(readFileSync('fixtures/delinquency/DQ2.json', 'utf8')) as Dq;
const dq3 = JSON.parse(readFileSync('fixtures/delinquency/DQ3.json', 'utf8')) as Dq;
const terms = { principalCents: am1.principal_cents, aprBps: am1.apr_bps, termMonths: am1.term_months, disbursementDate: am1.disbursement_date };
const ORIGIN = 'http://localhost:4700';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
beforeAll(() => client.connect());
afterAll(() => client.end());
beforeEach(resetAuthTables);

/** The route posts "today" from the app clock: pin it to noon UTC on `date` (helpers/auth resets it after each test). */
const pinToday = (date: string) => advanceClock(Date.parse(`${date}T12:00:00Z`) - Date.now());

/** Accrual, then the late-fee job, then any payment dated that day: the order the jobs run (D22). Returns the fee entry ids. */
async function runThrough(loanId: string, through: string, payments: { date: string; cents: number }[] = []) {
  const fees: string[] = [];
  for (let d = terms.disbursementDate; d < through; ) {
    d = addDays(d, 1);
    await runAccrual(client, { asOf: d });
    for (const f of await runStatus(client, { asOf: d })) fees.push(f.entryId);
    for (const p of payments.filter((x) => x.date === d)) await postPayment(client, { loanId, date: d, paymentCents: p.cents, order: PAYMENT_ORDER });
  }
  return fees;
}

/** Org A: an owner (servicer), the loan's borrower and another member, one AM1 loan. Org B: its own owner and loan. */
async function world() {
  const a = await makeOrg('acme');
  const b = await makeOrg('bravo');
  const owner = await addMember(a.id, 'owner', 'owner@acme.test');
  const borrower = await addMember(a.id, 'member', 'borrower@acme.test');
  const stranger = await addMember(a.id, 'member', 'stranger@acme.test');
  const otherOwner = await addMember(b.id, 'owner', 'owner@bravo.test');
  const { loanId } = await createLoan(client, terms);
  const { loanId: otherLoan } = await createLoan(client, terms);
  await db.loanAccess.create({ data: { loanId, orgId: a.id, borrowerUserId: borrower.id } });
  await db.loanAccess.create({ data: { loanId: otherLoan, orgId: b.id, borrowerUserId: otherOwner.id } });
  return { a, b, owner, borrower, stranger, otherOwner, loanId, otherLoan };
}

const form = (slug: string, loanId: string, body: Record<string, string>, origin = ORIGIN) =>
  adjust(new Request(`${ORIGIN}/o/${slug}/loans/${loanId}/adjust`, { method: 'POST', headers: { origin, host: 'localhost:4700' }, body: new URLSearchParams(body) }), {
    params: Promise.resolve({ org: slug, loanId }),
  });

/** The message the route redirects back with (303 to the loan page). */
async function msgOf(res: Response, slug: string, loanId: string) {
  expect(res.status).toBe(303);
  const to = new URL(res.headers.get('location')!);
  expect(to.pathname).toBe(`/o/${slug}/loans/${loanId}`);
  return to.searchParams.get('msg');
}

const entryCount = async () => Number((await client.query<{ n: string }>('SELECT count(*) AS n FROM "LedgerEntry"')).rows[0]!.n);
const getCsv = (slug: string, loanId: string) => csv(new Request(`${ORIGIN}/o/${slug}/loans/${loanId}/statement/csv`), { params: Promise.resolve({ org: slug, loanId }) });

it('adjust: a servicer waives a late fee through the route, as one reversal, and the book still verifies', async () => {
  const w = await world();
  const feeDay = dq2.expected.fees[0]!.date;
  const [feeId] = await runThrough(w.loanId, feeDay);
  expect(feeId).toBeDefined();
  pinToday(feeDay);
  await actAs(w.owner.id, w.a.slug);

  expect(await msgOf(await form(w.a.slug, w.loanId, { entryId: feeId!, reason: 'first late payment' }), w.a.slug, w.loanId)).toBe('Fee waived.');
  const { rows } = await client.query<{ date: string; memo: string }>('SELECT "date"::text AS date, "memo" FROM "LedgerEntry" WHERE "reversesEntryId" = $1', [feeId]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.date).toBe(feeDay); // dated today, from the app clock
  expect(rows[0]!.memo).toContain('first late payment');
  expect((await owedCents(client, w.loanId)).fees).toBe(0);
  // a second waiver of the same fee is the ledger's refusal, shown on the page
  expect(await msgOf(await form(w.a.slug, w.loanId, { entryId: feeId!, reason: 'again' }), w.a.slug, w.loanId)).toBe('Refused: already_reversed');
  expect((await verifyLedger(client)).findings).toEqual([]);
});

it('adjust: a servicer writes off a loan on the day it reaches default, and every receivable is zero', async () => {
  const w = await world();
  const defaultDay = dq2.expected.days.find((d) => d.state === 'default_recommended')!.date;
  await runThrough(w.loanId, addDays(defaultDay, -1));
  pinToday(addDays(defaultDay, -1));
  await actAs(w.owner.id, w.a.slug);
  // the day before default the ledger refuses; the route reports it and writes nothing
  const before = await entryCount();
  expect(await msgOf(await form(w.a.slug, w.loanId, { confirm: 'yes', reason: 'uncollectable' }), w.a.slug, w.loanId)).toBe('Refused: not_in_default');
  expect(await entryCount()).toBe(before);

  await runAccrual(client, { asOf: defaultDay }); // the jobs for the default day, then the write-off
  await runStatus(client, { asOf: defaultDay });
  pinToday(defaultDay);
  expect(await msgOf(await form(w.a.slug, w.loanId, { confirm: 'yes', reason: 'uncollectable' }), w.a.slug, w.loanId)).toBe('Loan written off.');
  expect(await owedCents(client, w.loanId)).toEqual({ fees: 0, interest: 0, principal: 0 });
  expect((await verifyLedger(client)).findings).toEqual([]);
});

it('adjust: every refusal is a message on the page and writes nothing', async () => {
  const w = await world();
  const feeDay = dq2.expected.fees[0]!.date;
  await runThrough(w.loanId, feeDay); // the late-fee job charges both loans
  const { rows } = await client.query<{ id: string }>(`SELECT "id" FROM "LedgerEntry" WHERE "loanId" = $1 AND "kind" = 'late_fee'`, [w.otherLoan]);
  pinToday(feeDay);
  await actAs(w.owner.id, w.a.slug);
  const before = await entryCount();
  const cases: [Record<string, string>, string][] = [
    [{ entryId: rows[0]!.id, reason: 'x' }, 'Refused: dangling_reversal'], // a fee of a loan in another org
    [{ entryId: 'not-a-uuid', reason: 'x' }, 'Refused: dangling_reversal'], // malformed id: unknown, not a server error
    [{ entryId: '', reason: 'x' }, 'Refused: dangling_reversal'],
    [{ reason: 'x' }, 'Refused: reason_required'], // neither a fee nor a confirmed write-off
    [{ confirm: 'yes', reason: '   ' }, 'Refused: reason_required'],
    [{ confirm: 'yes', reason: 'early' }, 'Refused: not_in_default'],
  ];
  for (const [body, msg] of cases) expect(await msgOf(await form(w.a.slug, w.loanId, body), w.a.slug, w.loanId), JSON.stringify(body)).toBe(msg);
  expect(await entryCount()).toBe(before);
});

it('adjust: only a servicer of the loan\'s own org, from the same origin, gets in', async () => {
  const w = await world();
  const feeDay = dq2.expected.fees[0]!.date;
  const [feeId] = await runThrough(w.loanId, feeDay);
  pinToday(feeDay);
  const before = await entryCount();
  const body = { entryId: feeId!, reason: 'x' };

  await actAs(w.borrower.id, w.a.slug); // the loan's own borrower: servicer-only
  await expect(form(w.a.slug, w.loanId, body)).rejects.toThrow('notFound');
  await actAs(w.otherOwner.id, w.b.slug); // a servicer of another org, through their own org's URL
  await expect(form(w.b.slug, w.loanId, body)).rejects.toThrow('notFound');
  await expect(form(w.a.slug, w.loanId, body)).rejects.toThrow(); // and not a member of the loan's org at all
  await actAs(w.owner.id, w.a.slug); // the right servicer, from another site
  expect((await form(w.a.slug, w.loanId, body, 'https://evil.example')).status).toBe(403);
  expect(await entryCount()).toBe(before);
});

it('statement CSV: the borrower gets their payments with the waterfall split in plain decimal dollars', async () => {
  const w = await world();
  const payments = dq3.input.payments;
  await runThrough(w.loanId, payments.at(-1)!.date, payments);
  await actAs(w.borrower.id, w.a.slug);
  const res = await getCsv(w.a.slug, w.loanId);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(res.headers.get('content-disposition')).toBe(`attachment; filename="statement-${w.loanId}.csv"`);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  const text = await res.text();
  expect(text.endsWith('\r\n')).toBe(true);
  const [head, ...rows] = text.trimEnd().split('\r\n');
  expect(head).toBe('date,paid,fees,interest,principal');
  expect(rows).toHaveLength(payments.length);
  const dollars = (c: number) => `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, '0')}`;
  // first payment: on the first due date, no fee yet, the whole first period's accrual (AC4) then principal
  const [p1, p2] = payments as [{ date: string; cents: number }, { date: string; cents: number }];
  expect(rows[0]).toBe([p1.date, dollars(p1.cents), '0.00', dollars(ac4.expected.total_cents), dollars(p1.cents - ac4.expected.total_cents)].join(','));
  // second: the DQ3 late fee is taken first, and the three parts sum to the payment
  const [date, paid, fees, interest, principal] = rows[1]!.split(',');
  expect([date, paid, fees]).toEqual([p2.date, dollars(p2.cents), dollars(dq3.expected.fees[0]!.cents)]);
  const cents = (s: string) => Number(s.replace('.', ''));
  expect(cents(fees!) + cents(interest!) + cents(principal!)).toBe(p2.cents);
});

it('statement CSV: no one else\'s borrower, and no other org\'s servicer', async () => {
  const w = await world();
  await actAs(w.stranger.id, w.a.slug); // a member of the same org, not this loan's borrower
  await expect(getCsv(w.a.slug, w.loanId)).rejects.toThrow('notFound');
  await actAs(w.otherOwner.id, w.b.slug); // servicer of org B asking for org A's loan through org B
  await expect(getCsv(w.b.slug, w.loanId)).rejects.toThrow('notFound');
  await actAs(w.owner.id, w.a.slug); // servicer of org A asking for org B's loan through org A
  await expect(getCsv(w.a.slug, w.otherLoan)).rejects.toThrow('notFound');
  expect((await getCsv(w.a.slug, w.loanId)).status).toBe(200); // and the right servicer does get it
});

it('loan page: shows the adjust route\'s own messages, and nothing a crafted link puts in ?msg=', async () => {
  const w = await world();
  await actAs(w.owner.id, w.a.slug);
  const render = async (msg: string) =>
    renderToStaticMarkup(await LoanDetailPage({ params: Promise.resolve({ org: w.a.slug, loanId: w.loanId }), searchParams: Promise.resolve({ asOf: terms.disbursementDate, msg }) }));
  for (const ok of ['Fee waived.', 'Loan written off.', 'Refused: fee_paid']) expect(await render(ok)).toContain(`role="status" class="card" style="padding:10px 16px;margin:0">${ok}<`);
  for (const bad of ['Your account is locked. Call 555-0100 to verify.', 'Refused: call 555-0100', 'Fee waived. Now re-enter your password']) {
    const html = await render(bad);
    expect(html).not.toContain('555-0100');
    expect(html).not.toContain('re-enter');
  }
});
