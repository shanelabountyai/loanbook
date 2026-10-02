import Link from 'next/link';
import { addDays, daysBetween } from '@/ledger/calendar';
import { viewDate } from './access';

const long = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Sticky date control for servicer screens: a plain GET form, so no client JS. Quiet on today, amber on any earlier day. */
export function AsOfBar({ asOf, path }: { asOf: string; path: string }) {
  const today = viewDate(undefined);
  const past = asOf < today;
  const back = daysBetween(asOf, today);
  const href = (d: string) => `${path}?asOf=${d}`;
  const year = asOf.slice(0, 4);
  return (
    <div className={`asof${past ? ' past' : ''}`}>
      <div className="stripe" aria-hidden="true" />
      <form method="get" action={path} className="wrap">
        <div className="grp">
          <label htmlFor="asof">As of</label>
          <Link className="step" href={href(addDays(asOf, -1))} aria-label="Previous day">‹</Link>
          <input id="asof" name="asOf" type="date" defaultValue={asOf} max={today} />
          <button className="go" type="submit">Go</button>
          <Link className={`step${past ? '' : ' off'}`} href={href(addDays(asOf, 1))} aria-label="Next day" aria-disabled={!past}>›</Link>
        </div>
        <div className="grp" role="group" aria-label="Jump to quarter end">
          <span style={{ fontSize: 12 }}>Quarter ends</span>
          {['03-31', '06-30', '09-30'].map((q) => (
            <Link key={q} className={`jump mono${asOf === `${year}-${q}` ? ' cur' : ''}`} href={href(`${year}-${q}`)}>{q}</Link>
          ))}
        </div>
        <div className="msg">
          <span className="tag">{past ? 'Past date' : 'Today'}</span>
          <p>
            {past
              ? `The book as it stood on ${long(asOf)}, ${back} days before today. Every state and balance is recomputed from ledger lines dated on or before this day.`
              : `${long(asOf)}. Pick an earlier date to see the book as it stood that day.`}
          </p>
        </div>
        {past && <Link className="home" href={path}>Return to today</Link>}
      </form>
    </div>
  );
}
