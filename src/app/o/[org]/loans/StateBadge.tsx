import type { CSSProperties } from 'react';
import type { LoanState } from '@/ledger/config';

// Hue warms green to brick as the state escalates; pips fill so the order reads without colour. [label, hue, pips filled]
const LOOK: Record<LoanState, [string, number | null, number]> = {
  current: ['Current', 155, 0],
  grace: ['Grace', 110, 1],
  delinquent_30: ['Delinquent 30+', 80, 2],
  delinquent_60: ['Delinquent 60+', 58, 3],
  delinquent_90: ['Delinquent 90+', 40, 4],
  default_recommended: ['Default recommended', 25, 5],
  written_off: ['Written off', null, 5],
};

/** Badge with the human label; `showKey` adds the state key (the servicer's tables keep it visible). */
export function StateBadge({ state, showKey }: { state: LoanState; showKey?: boolean }) {
  const [label, hue, on] = LOOK[state];
  return (
    <>
      <span className={`badge${hue === null ? ' off' : ''}`} style={{ '--h': hue ?? 0 } as CSSProperties} title={state}>
        <span className="pips" aria-hidden="true">{[1, 2, 3, 4, 5].map((i) => <i key={i} className={i <= on ? 'on' : ''} />)}</span>
        {label}
      </span>
      {showKey && <span className="key mono">{state}</span>}
    </>
  );
}
