// The two configurable money rules (D7, open item 2). Everything that needs them imports from here;
// tests/unit/ledger-config.test.ts fails if either value appears as a literal elsewhere.

import type { Bucket } from './waterfall';

/** Payment waterfall order (D7). */
export const PAYMENT_ORDER: readonly Bucket[] = ['fees', 'interest', 'principal'];

/** Flat late fee in cents. Read by Phase 4's assessment; nothing assesses it yet. */
export const LATE_FEE_CENTS = 1500;
