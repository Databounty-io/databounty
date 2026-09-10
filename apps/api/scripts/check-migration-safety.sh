#!/usr/bin/env bash
# Fails when a newly added Prisma migration contains a statement that can
# destroy or silently corrupt existing rows, unless it is explicitly approved.
#
# Why this exists: `prisma migrate dev` auto-generates DROP statements for any
# database object the datamodel does not declare, and buries them at the top of
# an otherwise unrelated migration. That is not hypothetical here -- it is how
# `bounties_title_trgm_idx` was silently destroyed in July 2026 by a migration
# named "add_submission_lsh_bands". The same mechanism emits DROP COLUMN for a
# removed field, which would delete real user data on the next staging deploy.
#
# To approve a genuinely intended destructive change, put this line in the
# migration.sql, above the statement:
#
#   -- databounty:allow-destructive: <reason, ticket, or decision reference>
#
# Usage:  bash scripts/check-migration-safety.sh [base_ref]
#         base_ref defaults to origin/main
set -euo pipefail

BASE_REF="${1:-origin/main}"
MIG_DIR="prisma/migrations"
MARKER="databounty:allow-destructive"

if ! git rev-parse --verify --quiet "$BASE_REF" >/dev/null; then
  echo "FATAL: base ref '$BASE_REF' not found. Fetch it first (git fetch origin main)." >&2
  exit 1
fi

# Only newly ADDED migration files matter. Prisma migrations are immutable once
# applied, so a modified existing migration is itself a problem -- flag it too.
added="$(git diff --name-only --diff-filter=A "$BASE_REF"...HEAD -- "$MIG_DIR" | grep '/migration\.sql$' || true)"
modified="$(git diff --name-only --diff-filter=MD "$BASE_REF"...HEAD -- "$MIG_DIR" | grep '/migration\.sql$' || true)"

status=0

if [ -n "$modified" ]; then
  echo "BLOCKED: an already-committed migration was modified or deleted."
  echo "         Applied migrations are immutable -- Prisma records a checksum and"
  echo "         a changed file makes every deployed environment fail on startup."
  echo "         Add a new migration instead. Offending files:"
  printf '           %s\n' $modified
  status=1
fi

if [ -z "$added" ]; then
  echo "OK: no new migrations in $BASE_REF...HEAD"
  exit $status
fi

echo "Scanning $(printf '%s\n' $added | wc -l | tr -d ' ') new migration(s) against $BASE_REF"
echo

for f in $added; do
  [ -f "$f" ] || continue

  # Strip comments so a pattern mentioned in prose (e.g. the word "truncates")
  # is never mistaken for a statement, then flatten to one line for multi-line
  # ALTER TABLE ... DROP COLUMN forms.
  body="$(sed -e 's/--.*$//' "$f" | tr '\n' ' ' | tr -s ' ')"
  approved=0
  grep -qF "$MARKER" "$f" && approved=1

  hits=""
  warns=""
  add_hit()  { hits="${hits}    - $1"$'\n'; }
  add_warn() { warns="${warns}    ~ $1"$'\n'; }

  grep -qiE 'DROP[[:space:]]+TABLE'                     <<<"$body" && add_hit "DROP TABLE -- destroys every row in the table"
  grep -qiE 'DROP[[:space:]]+COLUMN'                    <<<"$body" && add_hit "DROP COLUMN -- destroys that column's data permanently"
  grep -qiE '(^|[[:space:];])TRUNCATE([[:space:]]|$)'   <<<"$body" && add_hit "TRUNCATE -- removes all rows"
  grep -qiE 'DROP[[:space:]]+(SCHEMA|DATABASE)'         <<<"$body" && add_hit "DROP SCHEMA/DATABASE -- catastrophic"
  grep -qiE 'DROP[[:space:]]+(TYPE|CONSTRAINT[[:space:]]+[^ ]+[[:space:]]+CASCADE)' <<<"$body" && add_hit "DROP TYPE / DROP CONSTRAINT ... CASCADE -- can cascade into dependent objects"

  # DELETE with no WHERE clause before the statement terminator.
  if grep -qiE 'DELETE[[:space:]]+FROM[[:space:]]+[^;]*;' <<<"$body"; then
    while IFS= read -r stmt; do
      grep -qiE '[[:space:]]WHERE[[:space:]]' <<<"$stmt" || add_hit "unscoped DELETE FROM (no WHERE) -- removes all rows"
    done < <(grep -oiE 'DELETE[[:space:]]+FROM[[:space:]]+[^;]*;' <<<"$body")
  fi

  # SET NOT NULL is safe only if the same migration backfills first; without an
  # UPDATE the deploy aborts on any existing NULL and blocks all later deploys.
  if grep -qiE 'SET[[:space:]]+NOT[[:space:]]+NULL' <<<"$body" \
     && ! grep -qiE '(^|[[:space:];])UPDATE[[:space:]]' <<<"$body"; then
    add_hit "SET NOT NULL with no UPDATE backfill -- deploy fails if any row is NULL"
  fi

  # A NOT NULL column added without a default fails on a non-empty table.
  if grep -qiE 'ADD[[:space:]]+COLUMN[^;]*NOT[[:space:]]+NULL' <<<"$body" \
     && ! grep -qiE 'ADD[[:space:]]+COLUMN[^;]*NOT[[:space:]]+NULL[^;]*DEFAULT' <<<"$body"; then
    add_hit "ADD COLUMN ... NOT NULL without DEFAULT -- fails on a populated table"
  fi

  # Type changes can truncate, but widening (INT -> BIGINT) is legitimate and
  # common in this repo (21 historical occurrences). Direction cannot be
  # inferred from the SQL alone, so warn for human review instead of blocking.
  grep -qiE 'ALTER[[:space:]]+COLUMN[^;]*(SET[[:space:]]+DATA[[:space:]]+)?TYPE' <<<"$body" \
    && add_warn "ALTER COLUMN ... TYPE -- confirm this widens (INT->BIGINT ok) and never narrows"

  # CONCURRENTLY cannot run inside Prisma's per-migration transaction.
  grep -qiE 'CONCURRENTLY' <<<"$body" \
    && add_hit "CREATE/DROP INDEX CONCURRENTLY -- cannot run inside a transaction block; Prisma will error"

  if [ -n "$hits" ]; then
    if [ "$approved" = "1" ]; then
      echo "APPROVED  $f"
      printf '%s' "$hits"
      printf '%s' "$warns"
      echo "    (carries '$MARKER')"
    else
      echo "BLOCKED   $f"
      printf '%s' "$hits"
      printf '%s' "$warns"
      status=1
    fi
    echo
  elif [ -n "$warns" ]; then
    echo "REVIEW    $f"
    printf '%s' "$warns"
    echo
  else
    echo "OK        $f"
  fi
done

if [ "$status" != "0" ]; then
  cat <<'MSG'

This migration can destroy existing data and is not approved.

If the loss is intended, add this line to the migration.sql above the statement
and say why in the pull request:

  -- databounty:allow-destructive: <reason>

If it is NOT intended -- and an auto-generated DROP usually is not -- the cause
is almost always that schema.prisma no longer declares an object the database
still has. Re-declare it in the datamodel and regenerate the migration.
MSG
fi

exit $status
