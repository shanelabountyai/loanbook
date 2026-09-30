import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const ROUNDING = [
  { selector: "BinaryExpression[operator='/'], AssignmentExpression[operator='/=']", message: 'No division in src/ledger outside money.ts: build an exact bigint numerator and denominator and call roundHalfUp (D11).' },
  { selector: "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil|trunc)$/], CallExpression[callee.property.name=/^(toFixed|parseFloat)$/], CallExpression[callee.name='parseFloat']", message: 'No ad-hoc rounding or float parsing in src/ledger: roundHalfUp in money.ts is the one rounding rule (D2).' },
];
const WRITES = [
  { selector: "Literal[value=/INSERT\\s+INTO\\s+\"?Ledger/i], TemplateElement[value.raw=/INSERT\\s+INTO\\s+\"?Ledger/i]", message: 'Only src/ledger/post.ts writes the ledger: call postEntry (task 1.6).' },
  { selector: "MemberExpression[property.name=/^ledger(Entry|Line)$/]", message: 'No Prisma access to the ledger: write through postEntry, read through src/ledger (task 1.6).' },
];

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: ['.next/**', 'src/generated/**', 'spikes/**', 'next-env.d.ts'] },
  // Spec §4: core never reaches into modules or app. This is what keeps the D-7
  // package extraction mechanical, so it is an error from the first commit.
  {
    files: ['src/core/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/modules/*', '@/modules/**', '**/modules/**'], message: 'src/core must not import from src/modules (spec §4).' },
          { group: ['@/app/*', '@/app/**', '**/app/**'], message: 'src/core must not import from src/app (spec §4).' },
        ],
      }],
    },
  },
  // Task 1.6: the posting service is the one write path. Raw SQL and Prisma's model accessors are
  // both refused elsewhere; tests are outside this rule, since tampered books are loaded below it.
  {
    files: ['src/**', 'scripts/**'],
    rules: { 'no-restricted-syntax': ['error', ...WRITES] },
  },
  // Decisions D2, D11: money divides and rounds in exactly one module. Flat config replaces a rule
  // set twice rather than merging it, so each block below carries the full list for its files.
  {
    files: ['src/ledger/**'],
    ignores: ['src/ledger/money.ts'],
    rules: { 'no-restricted-syntax': ['error', ...ROUNDING, ...WRITES] },
  },
  {
    files: ['src/ledger/post.ts'],
    rules: { 'no-restricted-syntax': ['error', ...ROUNDING] },
  },
  // Task 2.1: the calendar divides once, milliseconds into whole UTC days, which is exact. No money
  // passes through it, so only the division selector is lifted; rounding stays refused.
  {
    files: ['src/ledger/calendar.ts'],
    rules: { 'no-restricted-syntax': ['error', ROUNDING[1], ...WRITES] },
  },
];

export default config;
