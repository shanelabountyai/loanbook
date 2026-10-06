import { expect, it } from 'vitest';
import { foldLedger, type LedgerRow } from '@/ledger/views';

const line = (entryId: string, date: string, kind: string | null, account: LedgerRow['account'], debitCents: number, creditCents: number): LedgerRow =>
  ({ entryId, date, memo: null, account, debitCents, creditCents, kind, reversesEntryId: null });
const accrual = (id: string, date: string, c: number) => [line(id, date, 'accrual', 'interest_receivable', c, 0), line(id, date, 'accrual', 'interest_income', 0, c)];

it('folds runs of two or more accrual entries and sums the interest once', () => {
  const rows = [...accrual('a', '01-16', 33), ...accrual('b', '01-17', 33), line('p', '01-18', null, 'cash', 500, 0), ...accrual('c', '01-19', 34)];
  const items = foldLedger(rows);
  expect(items.map((i) => i.type)).toEqual(['fold', 'line', 'line', 'line']); // the lone accrual keeps both its lines
  expect(items[0]).toMatchObject({ type: 'fold', from: '01-16', to: '01-17', days: 2, cents: 66 });
  expect(items.filter((i) => i.type === 'line')).toHaveLength(3);
});
