# Foundation patches

Template-owned files that differ from the cloned foundation tag, and why. Delete a row when the clone moves to a foundation release that contains the change.

`src/app/o/[org]/settings/members/page.tsx` `15a45c56b7fe` — loanbook only, not upstream (D29): a member is a borrower (D21) and gets `notFound` before the member list is read; keep it across foundation releases
