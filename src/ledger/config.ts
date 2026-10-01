// The two configurable money rules (D7, open item 2). Everything that needs them imports from here;
// tests/unit/ledger-config.test.ts fails if either value appears as a literal elsewhere.

import type { Bucket } from './waterfall';

/** Payment waterfall order (D7). */
export const PAYMENT_ORDER: readonly Bucket[] = ['fees', 'interest', 'principal'];

/** Flat late fee in cents. Read by Phase 4's assessment; nothing assesses it yet. */
export const LATE_FEE_CENTS = 1500;

export type LoanState = 'current' | 'grace' | 'delinquent_30' | 'delinquent_60' | 'delinquent_90' | 'default_recommended';

/** Delinquency bands (D18): each state starts at its `minDpd`, ascending. */
export const DELINQUENCY_BANDS: readonly { minDpd: number; state: LoanState }[] = [
  { minDpd: 0, state: 'current' },
  { minDpd: 1, state: 'grace' },
  { minDpd: 11, state: 'delinquent_30' },
  { minDpd: 60, state: 'delinquent_60' },
  { minDpd: 90, state: 'delinquent_90' },
  { minDpd: 120, state: 'default_recommended' },
];
