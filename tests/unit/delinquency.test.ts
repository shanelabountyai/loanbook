import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DELINQUENCY_BANDS } from '@/ledger/config';
import { dpd, stateFromDpd } from '@/ledger/delinquency';

// Task 4.2: DQ1-DQ5 on every simulated day, and the bands read from config (D18), not the fixture.

const dir = 'fixtures/delinquency';
for (const f of readdirSync(dir)) {
  const fx = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
  it(`${fx.id}: dpd and state on every day`, () => {
    const schedule = fx.input.schedule.map((r: { due_date: string; payment_cents: number }) => ({ dueDate: r.due_date, paymentCents: r.payment_cents }));
    for (const d of fx.expected.days) {
      const days = dpd(schedule, fx.input.payments, d.date);
      expect([d.date, days, stateFromDpd(days)]).toEqual([d.date, d.dpd, d.state]);
    }
  });
}

it('config bands equal the fixture bands', () => {
  const fx = JSON.parse(readFileSync(`${dir}/DQ1.json`, 'utf8'));
  expect(DELINQUENCY_BANDS.map((b) => ({ min_dpd: b.minDpd, state: b.state }))).toEqual(fx.input.bands);
});

it('band boundaries', () => {
  const at = (n: number) => stateFromDpd(n);
  expect([0, 1, 10, 11, 59, 60, 89, 90, 119, 120].map(at)).toEqual([
    'current', 'grace', 'grace', 'delinquent_30', 'delinquent_30', 'delinquent_60', 'delinquent_60', 'delinquent_90', 'delinquent_90', 'default_recommended',
  ]);
});
