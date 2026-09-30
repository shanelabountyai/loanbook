-- LoanBook loans (task 2.3). Prisma owns the table; the rules after it are hand-written, as in
-- 20260929000000_ledger_init. Codes travel in the error's constraint field: the CHECK names are
-- ScheduleError's codes (D14), and UPDATE or DELETE is append_only. D14's degenerate_schedule is the
-- service's alone (createLoan builds the schedule before inserting).

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "principalCents" INTEGER NOT NULL,
    "aprBps" INTEGER NOT NULL,
    "termMonths" INTEGER NOT NULL,
    "disbursementDate" DATE NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Loan"
  ADD CONSTRAINT invalid_principal CHECK ("principalCents" > 0),
  ADD CONSTRAINT invalid_rate CHECK ("aprBps" >= 0),
  ADD CONSTRAINT invalid_term CHECK ("termMonths" > 0);

-- Terms are facts. ledger_append_only raises append_only; TRUNCATE is left alone for tests.
CREATE TRIGGER "Loan_append_only"
  BEFORE UPDATE OR DELETE ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
