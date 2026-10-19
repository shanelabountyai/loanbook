# Foundation patches

Template-owned files that differ from the cloned foundation tag, and why. Delete a row when the clone moves to a foundation release that contains the change.

`src/app/o/[org]/settings/members/page.tsx` `2124e65bcf07` — loanbook only, not upstream (D29, D30): only servicers (owner/admin, `isServicer` in `loans/roles.ts`) get past `requireOrg`; a member (borrower, D21) or scorekeeper gets `notFound` before the member list is read; keep it across foundation releases
