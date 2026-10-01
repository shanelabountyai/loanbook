-- LoanBook late-fee idempotency (task 4.3, D20). A late-fee entry is kind = 'late_fee' and names the
-- installment it assesses, and a partial unique index allows one per (loan, installment), so a re-run or
-- two racing runs leave one fee. Same shape as already_accrued (D15): the code travels in the constraint name.

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN "installment" INTEGER;
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "invalid_kind";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "invalid_kind" CHECK ("kind" IS NULL OR "kind" IN ('accrual', 'late_fee'));
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "invalid_installment" CHECK ((COALESCE("kind" = 'late_fee', false)) = ("installment" IS NOT NULL) AND ("installment" IS NULL OR "installment" > 0));

-- CreateIndex
CREATE UNIQUE INDEX "already_fee_assessed" ON "LedgerEntry"("loanId", "installment") WHERE "kind" = 'late_fee';
