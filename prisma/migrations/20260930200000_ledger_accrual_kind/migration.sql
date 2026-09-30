-- LoanBook accrual idempotency (task 2.5, D15). An accrual entry is marked kind = 'accrual', and a
-- partial unique index allows one per (loan, day), so two racing runs leave one entry. Codes travel in
-- the error's constraint field, as in 20260929000000_ledger_init: a second accrual for a day breaks
-- already_accrued, an unknown kind invalid_kind (a misspelt kind would otherwise dodge the index).

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN "kind" TEXT;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "invalid_kind" CHECK ("kind" IS NULL OR "kind" = 'accrual');

-- CreateIndex
CREATE UNIQUE INDEX "already_accrued" ON "LedgerEntry"("loanId", "date") WHERE "kind" = 'accrual';
