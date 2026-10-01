import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { LATE_FEE_CENTS, PAYMENT_ORDER } from '@/ledger/config';

// Task 3.6: the order (D7) and the late fee (open item 2) live in config.ts and nowhere else in product code.

it('holds the decided values', () => {
  expect(PAYMENT_ORDER).toEqual(['fees', 'interest', 'principal']);
  expect(LATE_FEE_CENTS).toBe(1500);
});

it('appears as a literal in no other src/ledger file or script', () => {
  const files = [
    ...readdirSync('src/ledger').map((f) => `src/ledger/${f}`),
    ...readdirSync('scripts').map((f) => `scripts/${f}`),
  ].filter((f) => f.endsWith('.ts') && f !== 'src/ledger/config.ts');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    expect(src, f).not.toMatch(/\[\s*'fees'\s*,\s*'interest'\s*,\s*'principal'\s*\](?! as const)/);
    expect(src, f).not.toMatch(/\b1500\b/);
  }
});
