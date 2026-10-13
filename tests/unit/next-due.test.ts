import { expect, it } from 'vitest';
import { nextDue, scheduleActuals } from '@/ledger/views';

const rows = ['02-15', '03-15', '04-15'].map((dueDate, i) => ({ n: i + 1, dueDate, paymentCents: 100, interestCents: 10, principalCents: 90, remainingBalanceCents: 0 }));
const owed = { fees: 0, interest: 5, principal: 100 };

it('names the oldest installment cash has not covered, and what is left of it', () => {
  expect(nextDue({ schedule: scheduleActuals(rows, 0), owed })).toEqual({ dueDate: '02-15', cents: 100 });
  expect(nextDue({ schedule: scheduleActuals(rows, 130), owed })).toEqual({ dueDate: '03-15', cents: 70 });
});

it('every row covered and money still owed: the final installment, for all that is owed (D27)', () => {
  expect(nextDue({ schedule: scheduleActuals(rows, 300), owed })).toEqual({ dueDate: '04-15', cents: 105 });
});

it('is nothing once nothing is owed, even with installments uncovered (early payoff, write-off)', () => {
  expect(nextDue({ schedule: scheduleActuals(rows, 130), owed: { fees: 0, interest: 0, principal: 0 } })).toBeNull();
});
