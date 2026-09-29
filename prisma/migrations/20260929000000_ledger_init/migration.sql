-- LoanBook ledger (task 1.5; decisions D8, D12). Prisma owns the two tables. Every rule after them
-- is hand-written, as in 20260923100000_audit_append_only. Each rejection carries its code from
-- fixtures/ledger/entry_validation.json in the error's constraint field: the constraint name for a
-- CHECK, RAISE ... USING CONSTRAINT for a trigger. Held by tests/integration/ledger-db.test.ts.

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "loanId" TEXT,
    "memo" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerLine" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "account" TEXT NOT NULL,
    "debitCents" DECIMAL(65,30) NOT NULL,
    "creditCents" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "LedgerLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerLine_entryId_position_key" ON "LedgerLine"("entryId", "position");

-- AddForeignKey
ALTER TABLE "LedgerLine" ADD CONSTRAINT "LedgerLine_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Per line. The four rules are disjoint on the fixture's cases; a line that breaks several is
-- reported under the first name in alphabetical order, which is Postgres's order, not the service's.
ALTER TABLE "LedgerLine"
  -- D12: whole cents, inside JavaScript's safe integer range (D11). numeric keeps 10.5 as 10.5, so this can see it.
  ADD CONSTRAINT non_integer_amount CHECK (
    "debitCents" = trunc("debitCents") AND "creditCents" = trunc("creditCents")
    AND "debitCents" <= 9007199254740991 AND "creditCents" <= 9007199254740991
  ),
  ADD CONSTRAINT line_must_have_exactly_one_side CHECK (NOT ("debitCents" > 0 AND "creditCents" > 0)),
  ADD CONSTRAINT non_positive_amount CHECK ("debitCents" >= 0 AND "creditCents" >= 0 AND "debitCents" + "creditCents" > 0),
  -- D8: the chart in src/ledger/accounts.ts
  ADD CONSTRAINT unknown_account CHECK ("account" IN (
    'cash', 'loans_receivable', 'interest_receivable', 'fees_receivable',
    'lender_capital', 'interest_income', 'fees_income', 'write_offs'
  ));

-- Per entry, checked at commit, once for the entry and once for each of its lines. The entry's own
-- trigger is what catches an entry with no lines at all (I3).
CREATE FUNCTION ledger_entry_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry_id uuid;
  line_count integer;
  debits numeric;
  credits numeric;
  needs_loan boolean;
BEGIN
  IF TG_TABLE_NAME = 'LedgerEntry' THEN entry_id := NEW."id"; ELSE entry_id := NEW."entryId"; END IF;

  SELECT count(*), coalesce(sum("debitCents"), 0), coalesce(sum("creditCents"), 0),
         -- D8: the accounts that are per-loan sub-ledgers
         coalesce(bool_or("account" IN ('loans_receivable', 'interest_receivable', 'fees_receivable', 'write_offs')), false)
    INTO line_count, debits, credits, needs_loan
    FROM "LedgerLine" WHERE "entryId" = entry_id;

  -- the service's order: line count, then the loan id, then the balance (I2 is both short and unbalanced)
  IF line_count < 2 THEN
    RAISE EXCEPTION 'ledger entry % has % line(s), needs at least 2', entry_id, line_count
      USING ERRCODE = 'check_violation', CONSTRAINT = 'too_few_lines';
  END IF;
  IF needs_loan AND (SELECT coalesce("loanId", '') = '' FROM "LedgerEntry" WHERE "id" = entry_id) THEN
    RAISE EXCEPTION 'ledger entry % touches a per-loan account and has no loan id', entry_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'missing_loan_id';
  END IF;
  IF debits <> credits THEN
    RAISE EXCEPTION 'ledger entry % does not balance: debits %, credits %', entry_id, trunc(debits), trunc(credits)
      USING ERRCODE = 'check_violation', CONSTRAINT = 'unbalanced';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "LedgerEntry_check"
  AFTER INSERT ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_check();

CREATE CONSTRAINT TRIGGER "LedgerLine_entry_check"
  AFTER INSERT ON "LedgerLine"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_entry_check();

-- Append-only (A1, A2). A correction is a reversing entry. TRUNCATE is left alone, as for
-- AuditEvent: row triggers do not fire on it, so tests can still empty the tables.
CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: correct it with a reversing entry', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation', CONSTRAINT = 'append_only';
END;
$$;

CREATE TRIGGER "LedgerEntry_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

CREATE TRIGGER "LedgerLine_append_only"
  BEFORE UPDATE OR DELETE ON "LedgerLine"
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- A3: a line joins an entry only in the transaction that created the entry. An entry that does not
-- exist is left to the foreign key.
-- ponytail: xmin is the savepoint's id when the entry was inserted under one, so entry and lines must
-- be written at the same savepoint level or the lines are refused (fails closed). If a write path ever
-- needs savepoints, store txid_current() on the entry and compare that instead.
CREATE FUNCTION ledger_line_same_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "LedgerEntry" WHERE "id" = NEW."entryId" AND xmin <> pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'ledger entry % is already posted: lines cannot be added to it', NEW."entryId"
      USING ERRCODE = 'restrict_violation', CONSTRAINT = 'append_only';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "LedgerLine_same_transaction"
  BEFORE INSERT ON "LedgerLine"
  FOR EACH ROW EXECUTE FUNCTION ledger_line_same_transaction();
