import { afterAll, beforeAll, expect, it } from 'vitest';
import pg from 'pg';
import { runAccrual } from '@/ledger/accrue';
import { PAYMENT_ORDER } from '@/ledger/config';
import { loanStatus, runStatus, writeOff } from '@/ledger/delinquency';
import { createLoan } from '@/ledger/loan';
import { owedCents } from '@/ledger/owed';
import { postPayment } from '@/ledger/payment';
import { verifyLedger } from '@/ledger/verify';
import { loanDetail, nextDue } from '@/ledger/views';

// D27: a loan that paid every printed amount but still owes principal is past due on its final installment (D9).
// Worked by hand from D4/D5 (actual/365 on principal, half up), not from the oracle, which shared the old rule.
// L1: 100000 at 12%, 6 months from 2026-01-15; printed rows 5 x 17255 then 17253 (AM1). Interest = P x days x 12 / 36500.
//   02-15  31 days on 100000 = 1019.18 -> 1019   pay 17255: interest 1019, principal 16236            -> 83764
//   03-26  installment 2 unpaid at grace exit: late fee 1500
//   03-30  43 days on  83764 = 1184.17 -> 1184   pay 17255: fees 1500, interest 1184, principal 14571 -> 69193
//   04-15  16 days on  69193 =  363.97 ->  364   pay 17255: principal 16891                           -> 52302
//   05-15  30 days on  52302 =  515.85 ->  516   pay 17255: principal 16739                           -> 35563
//   06-15  31 days on  35563 =  362.45 ->  362   pay 17255: principal 16893                           -> 18670
//   07-15  30 days on  18670 =  184.14 ->  184   pay 17253: principal 17069                           ->  1601
// Cash 103528 is the schedule's total, and 1601 of principal is still owed.
//   07-26  final installment unpaid at grace exit: late fee 1500
//   11-12  DPD 120; 120 days on 1601 = 63.16 -> 63; written off 1601 + 63 + 1500

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
afterAll(() => client.end());

let loanId = '';
const fees: unknown[] = [];
const day = async (asOf: string, paymentCents?: number) => {
  await runAccrual(client, { asOf });
  for (const f of await runStatus(client, { asOf })) fees.push({ installment: f.installment, date: f.date, cents: f.cents });
  if (paymentCents) await postPayment(client, { loanId, date: asOf, paymentCents, order: PAYMENT_ORDER });
};
const status = async (asOf: string) => {
  const s = await loanStatus(client, { loanId, asOf });
  return [s.dpd, s.state];
};

beforeAll(async () => {
  await client.connect();
  await client.query('TRUNCATE "LedgerLine", "LedgerEntry", "Loan"');
  ({ loanId } = await createLoan(client, { principalCents: 100000, aprBps: 1200, termMonths: 6, disbursementDate: '2026-01-15' }));
  await day('2026-02-15', 17255);
  await day('2026-03-30', 17255);
  await day('2026-04-15', 17255);
  await day('2026-05-15', 17255);
  await day('2026-06-15', 17255);
  await day('2026-07-15', 17253);
}, 120_000);

it('every printed amount paid, principal still owed: current only until the last due date, then past due on the final installment', async () => {
  expect(fees).toEqual([{ installment: 2, date: '2026-03-26', cents: 1500 }]);
  expect(await owedCents(client, loanId)).toEqual({ fees: 0, interest: 0, principal: 1601 });
  expect(await status('2026-07-15')).toEqual([0, 'current']);
  expect(await status('2026-07-16')).toEqual([1, 'grace']);
  expect(await status('2026-07-26')).toEqual([11, 'delinquent_30']);
  expect(await status('2026-11-12')).toEqual([120, 'default_recommended']);
  expect(nextDue(await loanDetail(client, { loanId, asOf: '2026-07-16' }))).toEqual({ dueDate: '2026-07-15', cents: 1601 });
});

it('the final installment takes its late fee at grace exit, and the loan can be written off at DPD 120', async () => {
  fees.length = 0;
  await day('2026-11-12');
  expect(fees).toEqual([{ installment: 6, date: '2026-07-26', cents: 1500 }]);
  const w = await writeOff(client, { loanId, date: '2026-11-12', reason: 'residual never paid' });
  expect(w.writtenOff).toEqual({ fees: 1500, interest: 63, principal: 1601 });
  expect(await status('2026-12-31')).toEqual([120, 'written_off']);
  expect(nextDue(await loanDetail(client, { loanId, asOf: '2026-12-31' }))).toBeNull();
  expect((await verifyLedger(client)).findings).toEqual([]);
}, 120_000);

// D28: the final installment's late fee is capped at the principal still owed on its grace-exit day. Worked by hand as above.
// L1 again, installment 1 ten days late (DPD 10, inside grace, no fee), the rest on their due dates:
//   02-25  41 days on 100000 = 1347.95 -> 1348   pay 17255: interest 1348, principal 15907 -> 84093
//   03-15  18 days on  84093 =  497.65 ->  498   pay 17255: principal 16757                -> 67336
//   04-15  31 days on  67336 =  686.27 ->  686   pay 17255: principal 16569                -> 50767
//   05-15  30 days on  50767 =  500.72 ->  501   pay 17255: principal 16754                -> 34013
//   06-15  31 days on  34013 =  346.65 ->  347   pay 17255: principal 16908                -> 17105
//   07-15  30 days on  17105 =  168.71 ->  169   pay 17253: principal 17084                ->    21
//   07-26  final installment unpaid at grace exit: late fee min(1500, 21) = 21; 11 days on 21 = 0.08 -> 0
it('a residue smaller than the late fee is charged a fee equal to the residue', async () => {
  ({ loanId } = await createLoan(client, { principalCents: 100000, aprBps: 1200, termMonths: 6, disbursementDate: '2026-01-15' }));
  fees.length = 0;
  await day('2026-02-25', 17255);
  await day('2026-03-15', 17255);
  await day('2026-04-15', 17255);
  await day('2026-05-15', 17255);
  await day('2026-06-15', 17255);
  await day('2026-07-15', 17253);
  expect(fees).toEqual([]);
  expect(await owedCents(client, loanId)).toEqual({ fees: 0, interest: 0, principal: 21 });
  await day('2026-07-26');
  expect(fees).toEqual([{ installment: 6, date: '2026-07-26', cents: 21 }]);
  expect(await owedCents(client, loanId)).toEqual({ fees: 21, interest: 0, principal: 21 });
  expect((await verifyLedger(client)).findings).toEqual([]);
}, 120_000);
