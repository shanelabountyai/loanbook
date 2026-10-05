import pg from 'pg';
import { now } from '@/core/clock';
import { db } from '@/core/db'; // importing it is what refuses a cloud database (INV-18, INV-27)
import { env } from '@/core/env';
import { runAccrual } from '@/ledger/accrue';
import { PAYMENT_ORDER } from '@/ledger/config';
import { runStatus, writeOff } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { postPayment } from '@/ledger/payment';
import { payoffQuote } from '@/ledger/payoff';
import { buildSchedule } from '@/ledger/schedule';

// Demo book for Acme Studio (synthetic): seven loans in different states as of today, serviced by the seeded
// owner/admin, each borrowed by a seeded member account. Posts only through the real ledger functions.
// Idempotent: does nothing once Acme has any LoanAccess row.
const BORROWERS = [
  ['mara', 'Mara Lindqvist'], ['devon', 'Devon Okafor'], ['priya', 'Priya Raman'], ['tomas', 'Tomás Ibarra'], ['ines', 'Ines Falk'], ['jonas', 'Jonas Weber'],
] as const;

type Plan = { borrower: string; principalCents: number; aprBps: number; termMonths: number; disbursementDate: string; pays: 'all' | number; writeOffOn?: string };
const LOANS: Plan[] = [
  { borrower: 'mara', principalCents: 100_000, aprBps: 1200, termMonths: 6, disbursementDate: '2026-02-15', pays: 'all' }, // paid off on schedule
  { borrower: 'mara', principalCents: 200_000, aprBps: 1800, termMonths: 12, disbursementDate: '2026-07-01', pays: 'all' }, // current
  { borrower: 'devon', principalCents: 150_000, aprBps: 1400, termMonths: 9, disbursementDate: '2026-05-10', pays: 2 }, // two on time, then stopped
  { borrower: 'priya', principalCents: 80_000, aprBps: 2400, termMonths: 6, disbursementDate: '2026-04-01', pays: 0 }, // never paid: default recommended
  { borrower: 'tomas', principalCents: 120_000, aprBps: 1200, termMonths: 6, disbursementDate: '2026-08-25', pays: 0 }, // first installment just missed: grace
  { borrower: 'ines', principalCents: 70_000, aprBps: 2400, termMonths: 6, disbursementDate: '2026-01-20', pays: 0, writeOffOn: '2026-08-01' }, // written off
  { borrower: 'jonas', principalCents: 250_000, aprBps: 1000, termMonths: 12, disbursementDate: '2026-06-05', pays: 'all' },
];

export async function seedDemoBook(): Promise<string> {
  const org = await db.org.findUnique({ where: { slug: 'acme' } });
  if (!org) return 'Demo book skipped: run the account seed first.';
  if (await db.loanAccess.findFirst({ where: { orgId: org.id } })) return 'Demo book already seeded.';

  const users: Record<string, string> = {};
  for (const [key, name] of BORROWERS) {
    const email = `${key}@acme.demo.test`;
    const user = await db.user.upsert({ where: { email }, create: { email, name, isDemo: true }, update: { name, isDemo: true } });
    await db.membership.upsert({ where: { orgId_userId: { orgId: org.id, userId: user.id } }, create: { orgId: org.id, userId: user.id, role: 'member' }, update: {} });
    users[key] = user.id;
  }

  const today = now().toISOString().slice(0, 10);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    const loans = [];
    for (const p of LOANS) {
      const terms = { principalCents: p.principalCents, aprBps: p.aprBps, termMonths: p.termMonths, disbursementDate: p.disbursementDate };
      const { loanId } = await createLoan(c, terms);
      await db.loanAccess.create({ data: { loanId, orgId: org.id, borrowerUserId: users[p.borrower]! } });
      const rows = buildSchedule(terms).rows;
      const due = (p.pays === 'all' ? rows : rows.slice(0, p.pays)).filter((r) => r.dueDate <= today);
      loans.push({ loanId, p, due, last: rows[rows.length - 1]!.dueDate });
    }
    // One event per date, oldest first: accrue and assess through the day, then take that day's payments / write-offs.
    const dates = [...new Set(loans.flatMap((l) => [...l.due.map((r) => r.dueDate), ...(l.p.writeOffOn ? [l.p.writeOffOn] : [])]))].filter((d) => d <= today).sort();
    for (const date of dates) {
      await runAccrual(c, { asOf: date });
      await runStatus(c, { asOf: date });
      for (const l of loans) {
        const row = l.due.find((r) => r.dueDate === date);
        if (row) {
          const cents = date === l.last ? (await payoffQuote(c, { loanId: l.loanId, asOf: date })).totalCents : row.paymentCents; // D9: the final payment closes at the quote
          await postPayment(c, { loanId: l.loanId, date, paymentCents: cents, order: PAYMENT_ORDER });
        }
        if (l.p.writeOffOn === date) await writeOff(c, { loanId: l.loanId, date, reason: 'Demo: borrower unreachable, no payments since disbursement' });
      }
    }
    await runAccrual(c, { asOf: today });
    await runStatus(c, { asOf: today });
  } finally {
    c.release();
    await pool.end();
  }
  return `Demo book: ${LOANS.length} loans in Acme Studio, as of ${today}.`;
}
