'use client';
import { useState } from 'react';
import { formatMoney } from '@/ledger/money';
import type { LedgerItem, LedgerRow } from '@/ledger/views';

/** The only client island on the loan page: which accrual folds are open. Folding itself is computed on the server. */
export function LedgerTable({ items, dates, reversed, waivable, action }: { items: LedgerItem[]; dates: Record<string, string>; reversed: string[]; waivable: string[]; action?: string }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) => setOpen((o) => { const n = new Set(o); if (!n.delete(i)) n.add(i); return n; });
  const line = (l: LedgerRow, key: string, cls = '') => (
    <tr key={key} className={cls}>
      <td className="mono">{l.date}</td>
      <td>
        {l.memo}
        {l.reversesEntryId && <span className="muted"> [reversal of the {dates[l.reversesEntryId]} entry]</span>}
        {reversed.includes(l.entryId) && <span className="muted"> [reversed]</span>}
        {action && waivable.includes(l.entryId) && l.account === 'fees_receivable' && (
          <form method="post" action={action} className="inline-form">
            <input type="hidden" name="entryId" value={l.entryId} />
            <input name="reason" required placeholder="Reason" aria-label="Reason for waiving" /> <button type="submit">Waive fee</button>
          </form>
        )}
      </td>
      <td className={`mono${l.creditCents ? ' acct-credit' : ''}`}>{l.account}</td>
      <td className="n">{l.debitCents ? formatMoney(l.debitCents) : ''}</td><td className="n">{l.creditCents ? formatMoney(l.creditCents) : ''}</td>
    </tr>
  );
  return (
    <table aria-label="Ledger">
      <thead><tr><th>Date</th><th>Memo</th><th>Account</th><th className="n">Debit</th><th className="n">Credit</th></tr></thead>
      <tbody>
        {items.map((it, i) =>
          it.type === 'line' ? line(it.row, `l${i}`) : (
            <FoldRows key={`f${i}`} it={it} isOpen={open.has(i)} toggle={() => toggle(i)} line={line} i={i} />
          ),
        )}
      </tbody>
    </table>
  );
}

function FoldRows({ it, isOpen, toggle, line, i }: { it: Extract<LedgerItem, { type: 'fold' }>; isOpen: boolean; toggle: () => void; line: (l: LedgerRow, k: string, c?: string) => React.ReactNode; i: number }) {
  return (
    <>
      <tr className="band">
        <td className="mono">{it.from} to {it.to}</td>
        <td colSpan={2}>
          <button type="button" className="twisty" aria-expanded={isOpen} onClick={toggle}><span aria-hidden="true">{isOpen ? '▾' : '▸'}</span> Interest accrued {it.from} to {it.to}: {it.days} days</button>
        </td>
        <td className="n">{formatMoney(it.cents)}</td><td className="n">{formatMoney(it.cents)}</td>
      </tr>
      {isOpen && it.rows.map((r, j) => line(r, `f${i}-${j}`, 'fold'))}
    </>
  );
}
