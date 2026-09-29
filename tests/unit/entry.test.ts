import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/ledger/entry_validation.json';
import { assertValidEntry, EntryError, type EntryInput } from '@/ledger/entry';
import { MoneyError } from '@/ledger/money';

type FixtureEntry = (typeof fixture.valid)[number]['entry'] | (typeof fixture.invalid)[number]['entry'];

const toInput = (e: FixtureEntry): EntryInput => ({
  loanId: e.loan_id,
  lines: e.lines.map((l) => ({ account: l.account, debitCents: l.debit, creditCents: l.credit })),
});

const code = (entry: EntryInput) => {
  try {
    assertValidEntry(entry);
  } catch (e) {
    if (e instanceof EntryError || e instanceof MoneyError) return e.code;
    throw e;
  }
  return 'accepted';
};

const line = (account: string, debitCents: number, creditCents: number) => ({ account, debitCents, creditCents });

describe('entry validation (entry_validation.json)', () => {
  it.each(fixture.valid.map((c) => [c.id, c.note, c.entry] as const))('accepts %s: %s', (_id, _note, entry) => {
    expect(code(toInput(entry))).toBe('accepted');
  });

  it.each(fixture.invalid.map((c) => [c.id, c.error, c.note, c.entry] as const))(
    'rejects %s as %s: %s',
    (_id, error, _note, entry) => {
      expect(code(toInput(entry))).toBe(error);
    },
  );
});

describe('entry validation, beyond the fixture', () => {
  it.each([
    ['a negative side beside a positive one', line('cash', 100, -100), 'non_positive_amount'],
    ['NaN', line('cash', NaN, 0), 'non_integer_amount'],
    ['a string amount', line('cash', '100' as unknown as number, 0), 'non_integer_amount'],
    ['an inherited property name as account', line('toString', 100, 0), 'unknown_account'],
  ])('rejects %s', (_label, bad, error) => {
    expect(code({ loanId: 'L1', lines: [bad, line('lender_capital', 0, 100)] })).toBe(error);
  });

  it.each([null, undefined, ''])('rejects loan id %j on a receivable entry', (loanId) => {
    const lines = [line('loans_receivable', 100, 0), line('cash', 0, 100)];
    expect(code({ loanId, lines })).toBe('missing_loan_id');
  });

  it('needs no loan id when no line touches a per-loan account', () => {
    expect(code({ loanId: null, lines: [line('cash', 100, 0), line('lender_capital', 0, 100)] })).toBe('accepted');
  });

  it('rejects lines that are not an array', () => {
    expect(code({ loanId: 'L1', lines: undefined as unknown as [] })).toBe('too_few_lines');
  });

  it('rejects totals past the safe integer range rather than comparing them', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const lines = [line('cash', big, 0), line('cash', big, 0), line('lender_capital', 0, big), line('lender_capital', 0, big)];
    expect(code({ loanId: null, lines })).toBe('non_integer_amount');
  });
});
