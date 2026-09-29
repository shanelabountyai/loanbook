import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

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
  // Decisions D2, D11: money divides and rounds in exactly one module.
  {
    files: ['src/ledger/**'],
    ignores: ['src/ledger/money.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        { selector: "BinaryExpression[operator='/'], AssignmentExpression[operator='/=']", message: 'No division in src/ledger outside money.ts: build an exact bigint numerator and denominator and call roundHalfUp (D11).' },
        { selector: "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil|trunc)$/], CallExpression[callee.property.name=/^(toFixed|parseFloat)$/], CallExpression[callee.name='parseFloat']", message: 'No ad-hoc rounding or float parsing in src/ledger: roundHalfUp in money.ts is the one rounding rule (D2).' },
      ],
    },
  },
];

export default config;
