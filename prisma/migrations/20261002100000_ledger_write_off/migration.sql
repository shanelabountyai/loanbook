-- LoanBook write-off (task 4.7b, D25). A write-off entry is kind = 'write_off', and a partial unique index allows
-- one per loan, so two racing write-offs leave one. Same shape as already_fee_assessed (D20).

-- AlterTable
ALTER TABLE "LedgerEntry" DROP CONSTRAINT "invalid_kind";
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "invalid_kind" CHECK ("kind" IS NULL OR "kind" IN ('accrual', 'late_fee', 'write_off'));

-- CreateIndex
CREATE UNIQUE INDEX "already_written_off" ON "LedgerEntry"("loanId") WHERE "kind" = 'write_off';
