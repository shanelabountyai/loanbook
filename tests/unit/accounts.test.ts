import { describe, expect, it } from 'vitest';
import fixture from '../../fixtures/ledger/chart_of_accounts.json';
import { CHART, isAccount } from '@/ledger/accounts';

describe('chart of accounts (D8)', () => {
  it('matches the frozen fixture exactly', () => {
    const expected = Object.fromEntries(
      fixture.accounts.map((a) => [
        a.account,
        { type: a.type, normal: a.normal, requiresLoanId: a.requires_loan_id ?? false },
      ]),
    );
    expect(CHART).toEqual(expected);
  });

  it.each(fixture.accounts.map((a) => a.account))('knows %s', (name) => {
    expect(isAccount(name)).toBe(true);
  });

  it.each([
    ['an account not in the chart (I7)', 'petty_cash'],
    ['an inherited property name', 'toString'],
    ['constructor', 'constructor'],
    ['__proto__', '__proto__'],
    ['a different case', 'Cash'],
    ['an empty string', ''],
    ['a number', 42],
    ['undefined', undefined],
    ['null', null],
  ])('rejects %s', (_label, name) => {
    expect(isAccount(name)).toBe(false);
  });
});
