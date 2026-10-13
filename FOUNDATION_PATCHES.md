# Foundation patches

Template-owned files that differ from the cloned foundation tag, and why. Delete a row when the clone moves to a foundation release that contains the change.

`src/app/account/security/actions.ts` `cced2c985fe5` — security fixes from the 2026-10-12 review, upstream in saas-foundation (e47af9a, 71b5fd8, 2cc20a8), unreleased after v1.2.0
`src/core/auth/link.ts` `e0a28ec674ae` — security fixes from the 2026-10-12 review, upstream in saas-foundation (e47af9a, 71b5fd8, 2cc20a8), unreleased after v1.2.0
`src/core/auth/session.ts` `a967c8cafb7d` — security fixes from the 2026-10-12 review, upstream in saas-foundation (e47af9a, 71b5fd8, 2cc20a8), unreleased after v1.2.0
`src/core/tenancy/invites.ts` `e4a9c739bc6e` — security fixes from the 2026-10-12 review, upstream in saas-foundation (e47af9a, 71b5fd8, 2cc20a8), unreleased after v1.2.0
`src/core/tenancy/orgs.ts` `eb5193f0816d` — security fixes from the 2026-10-12 review, upstream in saas-foundation (e47af9a, 71b5fd8, 2cc20a8), unreleased after v1.2.0
`tests/invariants/inv-06-email-change.test.ts` `39e0b6643d87` — security fixes from the 2026-10-12 review, upstream in saas-foundation (e47af9a, 71b5fd8, 2cc20a8), unreleased after v1.2.0
`src/app/o/[org]/settings/members/page.tsx` `15a45c56b7fe` — loanbook only, not upstream (D29): a member is a borrower (D21) and gets `notFound` before the member list is read; keep it across foundation releases
