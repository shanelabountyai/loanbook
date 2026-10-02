-- LoanBook loan access (task 4.4, D21). One row per loan: the org that services it and the user who borrows it.
-- Append-only like "Loan": a change of borrower or servicer would be a new terms version, a non-goal.

-- CreateTable
CREATE TABLE "LoanAccess" (
    "loanId" TEXT NOT NULL,
    "orgId" UUID NOT NULL,
    "borrowerUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanAccess_pkey" PRIMARY KEY ("loanId")
);

-- CreateIndex
CREATE INDEX "LoanAccess_orgId_idx" ON "LoanAccess"("orgId");

-- CreateIndex
CREATE INDEX "LoanAccess_borrowerUserId_idx" ON "LoanAccess"("borrowerUserId");

CREATE TRIGGER "LoanAccess_append_only"
  BEFORE UPDATE OR DELETE ON "LoanAccess"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
