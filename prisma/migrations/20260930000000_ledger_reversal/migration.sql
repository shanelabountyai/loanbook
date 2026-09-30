-- LoanBook reversals (task 1.8). A correction is a new entry with sides swapped that names the
-- entry it reverses. Codes travel in the error's constraint field, as in 20260929000000_ledger_init:
-- a second reversal of one entry breaks already_reversed, a reversal of no entry dangling_reversal.
-- That the lines mirror the original is the service's job (reverseEntry builds them from it).

-- AlterTable
ALTER TABLE "LedgerEntry" ADD COLUMN "reversesEntryId" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "already_reversed" ON "LedgerEntry"("reversesEntryId");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "dangling_reversal" FOREIGN KEY ("reversesEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
