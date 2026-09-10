/**
 * state-sequence-match (DB flavor) -- database_migration_correctness.
 *
 * Sibling of sql_query_correctness (same execution-accuracy philosophy, same
 * SQLite/executescript machinery, several helper functions below are
 * DELIBERATELY duplicated verbatim from that file's harness.js rather than
 * factored into registry/lib/helpers.js -- see that file's own module doc
 * comment for why a shared cross-harness module was judged higher-risk than
 * duplication for this pair: helpers.js is loaded by EVERY category, so a
 * change there needs re-verification of every category's reference dataset,
 * while a change confined to this file only needs this category re-verified.
 * Anywhere this file's logic differs from sql_query_correctness's, it is
 * called out explicitly below -- this is NOT a blind copy.
 *
 * THE CONTRACT: initial_schema_ddl + initial_fixture_data define a real
 * 'before' SQLite database, built for real. migration_script (one or more
 * DDL/DML statements, run via executescript()) is applied to it for real.
 * verification_query (a single read-only SELECT/WITH, run AFTER the
 * migration) is then executed against the now-migrated database, and its
 * real result is compared to expected_verification_result. A row is correct
 * only when the ACTUAL post-migration state, queried for real, matches --
 * never a text/AST comparison of migration_script against a reference
 * script.
 *
 * WHY migration_script gets a DIFFERENT gate posture than sql_query_correctness's
 * sql_query (this is the one place this category's security posture is the
 * OPPOSITE of its sibling's, and deliberately so -- documented here at length
 * so nobody "fixes" this later thinking it regressed the sibling's rule):
 * sql_query_correctness's sql_query is a READ over a FIXED fixture -- letting
 * it also carry DDL/DML would let it manufacture its own expected_result by
 * mutating the fixture into whatever shape makes the trailing SELECT match,
 * making that category unfalsifiable. migration_script IS the DDL/DML by
 * definition -- "transform a before state into a documented after state" has
 * no meaning without ALTER/UPDATE/CREATE INDEX/etc, and typically needs
 * SEVERAL statements (add a column, backfill it, then add a constraint on
 * it), so gateSelectOnly-style single-statement/read-only enforcement would
 * reject every genuine row in this category. migration_script is instead
 * held to the SAME narrower, defense-in-depth denylist sql_query_correctness
 * already applies to ITS setup fields (schema_ddl/fixture_data): ATTACH/
 * DETACH/PRAGMA blocked, everything else DDL/DML allowed. Two notes on why
 * that narrower denylist is still sufficient here, not a gap:
 *   (a) ATTACH DATABASE opening/creating an arbitrary OS-writable path is a
 *       real sandbox-hygiene concern regardless of which field carries it --
 *       defining a schema, seeding fixture rows, or migrating a schema never
 *       legitimately needs it.
 *   (b) PRAGMA is blocked outright rather than narrowed to a specific unsafe
 *       subset because it is never actually needed by a legitimate migration
 *       here: SQLite foreign-key ENFORCEMENT is off by default and this
 *       harness's own sqlite3 connections never turn it on (see build_db in
 *       the driver below), so the classic "PRAGMA foreign_keys=OFF; <rebuild
 *       the table>; PRAGMA foreign_keys=ON;" recipe some SQLite migration
 *       guides recommend has nothing to toggle here -- a 12-step table
 *       rebuild (rename old table, CREATE the new shape, INSERT ... SELECT
 *       the data across, DROP the old table) works with no PRAGMA statement
 *       at all under this harness's connections.
 * verification_query, by contrast, is exactly sql_query_correctness's
 * sql_query shape (a single read-only check run against an already-fixed
 * database) and gets the IDENTICAL strict single-statement/read-only gate --
 * duplicated from that file's gateSelectOnly, not weakened, because letting
 * verification_query carry any DML/DDL of its own would let it further
 * mutate the post-migration database into whatever shape makes it match
 * expected_verification_result, which is exactly the unfalsifiability trap
 * sql_query_correctness's Gate 2 exists to close, applying equally here.
 *
 * verification_query's ROLE ("tests", not "solution_code"/"input_code" --
 * a deliberate, documented deviation from how the task brief framed the two
 * candidate options): verification_query is not an artifact the contributor
 * being graded produces as their answer (migration_script is that artifact,
 * and is the only field with role "solution_code" in this schema) -- it is
 * the dataset's own fixed CHECKING code, authored once by the dataset
 * curator alongside expected_verification_result, exactly analogous to how
 * network_protocol_fsm's reference_test_harness, graphql_resolver's tests,
 * competitive_programming's tests, and half a dozen other categories in this
 * registry already pair a role:"tests" checking artifact with a role:
 * "expected_output" field. "tests" already exists in the registry's field-role
 * enum (src/lib/dataset-type-field.ts) and is the established convention for
 * exactly this shape, so it was used here rather than force-fitting
 * verification_query into "input_code" (which reads, in every OTHER category
 * that uses it, as a fixed INPUT PREMISE like schema_ddl/fixture_data, not a
 * check) or "solution_code" (which would wrongly imply two separate
 * graded-solution fields for one row).
 *
 * ANTI-HARDCODING CHECK, adapted from sql_query_correctness's mutation-and-
 * rerun pattern: after the PRIMARY run passes (migration applied + verified
 * against the real initial_fixture_data), the SAME migration_script is
 * applied to a SECOND (Strategy 1) and a THIRD (Strategy 2), independently-
 * built database -- initial_schema_ddl + initial_fixture_data, PLUS one of
 * TWO generic, schema-agnostic mutations (mutate_db / mutate_db_shift,
 * duplicated verbatim from sql_query_correctness's own mutateDb /
 * mutateDbShift -- see that file's module doc comment for the full
 * rationale on both strategies, including the CONFIRMED PRODUCTION BUG that
 * made Strategy 2 and the asymmetric combination logic necessary, and why a
 * naming-convention FK heuristic was considered and rejected) -- applied to
 * the fixture BEFORE migration_script ever runs, not after, for BOTH
 * strategies. This ordering is load-bearing and is the one place this
 * category's mutation differs procedurally from its sibling's (which
 * mutates once and queries once): mutating pre-migration and then running
 * the SAME migration_script against the mutated pre-state proves the
 * migration's own DDL/DML is genuinely general-purpose (an UPDATE ... WHERE
 * / backfill that only ever touches the 3 specific rows the row's author
 * happened to fixture would leave a 4th, mutated row un-migrated, changing
 * the post-migration verification result) -- mutating the ALREADY-migrated
 * state instead would only prove verification_query reads real data, saying
 * nothing about whether migration_script itself is hardcoded to the given
 * fixture. Both mutated clones/shifts are always applied using
 * initial_schema_ddl's PRE-migration column shape (both run before
 * migration_script), so they are always a structurally valid input
 * regardless of what migration_script's own DDL later does to the schema --
 * only row VALUES are perturbed, never the schema, so there is no risk of
 * either mutation being invalid against a schema that does not exist yet.
 *
 * THE SAME PRODUCTION BUG WAS CONFIRMED HERE TOO, BY REAL TESTING, NOT
 * ASSUMED FROM THE SIBLING'S REPORT: mutate_db is a verbatim duplicate, so a
 * migration whose backfill logic is an INTEGER THRESHOLD/aggregate
 * comparison (e.g. `UPDATE packages SET is_delayed = 1 WHERE transit_days >
 * (SELECT AVG(transit_days) FROM packages)`, verified by reading
 * is_delayed back) was hand-reproduced against this file's own,
 * then-unmodified mutate_db and DID false-flag as suspected_hardcoded, for
 * the identical reason as the sibling's bug: Strategy 1's clone leaves
 * non-PK INTEGER columns (transit_days here) unperturbed, so the cloned
 * row's contribution to the AVG rarely moves it far enough to flip which
 * rows the backfill's WHERE clause targets. Strategy 2 (mutate_db_shift)
 * fixes it the same way as the sibling: shifting an EXISTING row's
 * transit_days in place, pre-migration, directly changes the value the
 * threshold is computed over. The asymmetric combination logic (a row is
 * only flagged suspected_hardcoded when Strategy 1 -- not Strategy 2 alone
 * -- ran cleanly and reproduced an identical result, while EITHER strategy
 * differing is sufficient to pass) is reused verbatim from
 * sql_query_correctness for the identical reason it was needed there:
 * Strategy 2 only ever perturbs INTEGER columns, so its "identical" result
 * alone is not comprehensive proof of hardcoding, and mistaking it for proof
 * risks wrongly failing a genuinely correct migration whose real
 * data-dependence is on a TEXT/REAL column that happens to sit in a table
 * where Strategy 1's clone is blocked by an unrelated CHECK/UNIQUE
 * constraint.
 *
 * STRATEGY 2's OWN EXTENSION TO MULTIPLE ATTEMPTS, ALSO PORTED HERE (see
 * sql_query_correctness/harness.js's own module doc comment, "THE SECOND
 * CONFIRMED PRODUCTION BUG..." and "THE EXTENSION..." sections, for the full
 * rationale, real hand-traced Shape A/Shape B examples, and why isolated
 * single-row attempts alone cannot close Shape B): the original Strategy 2
 * here picked exactly ONE existing pre-migration row per table (the lowest-
 * rowid row) and shifted only that one -- the identical blind spot the
 * sibling found via real production submissions applies here just as
 * directly, since verification_query is the SAME shape of read-only SELECT/
 * WITH as the sibling's sql_query (a GROUP-BY-then-JOIN-back-to-parent
 * verification_query comparing a per-group count to MIN/MAX/AVG over all
 * groups is exactly as reachable from a genuinely correct migration_script's
 * backfill logic as from a hand-written sql_query). shift_row/
 * run_shift_attempts below are the SAME two-kind design (several ISOLATED
 * single-row attempts per table, up to SHIFT_CAP_ROWS_PER_TABLE, plus one
 * combined shift-ALL-rows-of-this-table attempt), with ONE necessary
 * adaptation for this category's own pre-migration-then-verify ordering:
 * each attempt's throwaway in-memory database has migration_script
 * RE-APPLIED (via conn.executescript, exactly like the primary/Strategy-1/
 * old-Strategy-2 runs above) BEFORE verification_query is run against it --
 * an attempt is only ever counted "ok" (eligible to be compared against the
 * primary result) if BOTH the re-applied migration_script and the re-run
 * verification_query complete without error, folding both failure modes into
 * one "ok: false" bucket per attempt (this category's existing
 * strategyStatus already treats "migration re-apply failed" and "verify
 * failed" identically -- both INCONCLUSIVE for that attempt, never proof of
 * anything -- so no information is lost by folding them together here).
 * Real local measurement (see this fix's build report) confirmed the added
 * per-attempt migration_script re-application cost stays in the same
 * low-single-digit-millisecond-per-attempt range as the sibling's own
 * SELECT-only attempts for this category's realistically-sized fixtures and
 * migration scripts, nowhere near this category's own 20s TIMEOUT_MS.
 *
 * STRATEGY 2's FURTHER EXTENSION TO TEXT COLUMNS, ALSO PORTED HERE (see
 * sql_query_correctness/harness.js's own module doc comment, "THE THIRD
 * CONFIRMED PRODUCTION BUG..." section, for the full rationale, real
 * hand-traced examples, and why REAL columns are deliberately left out of
 * scope): the sibling found, via 30 more freshly-authored, genuinely correct
 * SQL rows submitted to a real community pool, that Strategy 1's clone
 * structurally can never satisfy a TEXT EQUALITY filter or TEXT GROUP BY key
 * a row it clones currently belongs to -- every TEXT column on the clone is,
 * by design, suffixed with "_mut1" on the very INSERT that creates it, so the
 * clone can never land INSIDE that filter/group. This applies here with
 * IDENTICAL force, not merely by analogy: a migration_script whose backfill
 * logic is a TEXT EQUALITY/GROUP-BY-key condition (e.g. `UPDATE employees SET
 * bonus_eligible = 1 WHERE department = (SELECT department FROM employees
 * GROUP BY department ORDER BY COUNT(*) DESC LIMIT 1)`, verified via a
 * verification_query reading bonus_eligible back) is exactly as reachable
 * from a genuinely correct migration as the sibling's own SELECT-only TEXT
 * filter examples, since mutate_db (Strategy 1) is a byte-for-byte duplicate
 * here too. shift_row below is ported with the SAME fix: an `elif
 * isinstance(val, str)` branch alongside the existing `isinstance(val, int)`
 * one, reusing the identical isolated-single-row-plus-shift-ALL attempt
 * structure with zero new structural changes, needing only ONE adaptation
 * already present in this file's own pre-migration-then-verify ordering (see
 * "THE SAME PRODUCTION BUG..." above) -- no separate re-derivation was
 * needed. Hand-confirmed here, independently, with a
 * TEXT-GROUP-BY-key-backfill migration analogous to the sibling's Case 3/4:
 * before this fix, Strategy 1's clone (whose TEXT-suffixed department never
 * joins the real group) and the old INTEGER-only Strategy 2 both reproduced
 * an identical post-migration verification_query result, wrongly flagging a
 * genuinely data-dependent migration; after this fix, shifting an in-place
 * TEXT department value pre-migration (via the existing isolated-row/shift-
 * ALL attempts, migration_script re-applied on top exactly as this file's
 * ordering already requires) reliably differs, closing the gap the same way.
 *
 * A migration_script that is genuinely correct, general-purpose logic cannot
 * produce the IDENTICAL verification_query result under BOTH strategies for
 * any migration whose effect is data-dependent -- an added/shifted row
 * changes a row-listing query's row count, a backfill/UPDATE's effect on the
 * new/shifted row changes an aggregate over it, a new column's value for the
 * new/shifted row shows up in a SELECT of that column. A hardcoded migration
 * that, say, always sets exactly 3 specific rows' email column via 3 literal
 * UPDATE ... WHERE id = N statements (ignoring any OTHER row that matches
 * the same plain-English rule), or that targets a row via a data-independent
 * `WHERE id = (SELECT MIN(id) ...)` rather than any actual column value
 * (confirmed by real testing here to still be correctly caught), reproduces
 * the exact same verification_query result under both mutations regardless
 * -- correctly flagged. Two documented exemptions, both INCONCLUSIVE rather
 * than pass or fail, mirroring the sibling's own:
 *   - Mutation is skipped (no verdict) when NEITHER strategy found any table
 *     in initial_fixture_data with a row to mutate -- every generic
 *     clone/shift attempt hit a UNIQUE/CHECK/NOT NULL constraint this
 *     generic, schema-blind mutation cannot route around
 *     (mutated_table_count === 0 AND mutated_table_count2 === 0).
 *   - Applying migration_script to a mutated pre-state, or running
 *     verification_query against the result, ERRORING where the PRIMARY run
 *     did not is inconclusive for THAT strategy, not proof of anything -- a
 *     migration whose UPDATE targets exactly one matched row via a
 *     scalar-subquery-like assumption is a plausible, legitimate way for an
 *     otherwise-correct migration to be fragile to an extra/altered row; the
 *     primary run against the REAL fixture already passed. Only Strategy 1
 *     running clean-and-identical (with Strategy 2 not differing either) is
 *     treated as proof -- see the asymmetric combination note above.
 *   - verification_query containing DISTINCT is exempted from a "suspected
 *     hardcoded" verdict for the identical reason sql_query_correctness
 *     exempts it: a clone whose only-ever-unperturbed column is a non-PK
 *     INTEGER DISTINCT might be deduplicating on is, by construction,
 *     indistinguishable from an existing row for that purpose. As with the
 *     sibling, Strategy 2 usually resolves this ambiguity on its own before
 *     this exemption is even needed.
 *   - NEW exemption, specific to this category and NOT present in the
 *     sibling: a verification_query that is a pure SCHEMA-INTROSPECTION
 *     query (reads only sqlite_master and/or SQLite's pragma_table_info/
 *     pragma_index_list/pragma_index_info/pragma_foreign_key_list/
 *     pragma_foreign_key_check table-valued functions, detected textually)
 *     is exempted the same way -- structurally, not as a judgment call: this
 *     mutation only ever perturbs FIXTURE ROWS, never touches
 *     initial_schema_ddl, and migration_script's own DDL effect on the
 *     schema is entirely deterministic and independent of which/how-many
 *     data rows happen to be present -- so a query that reads ONLY schema
 *     metadata is GUARANTEED to reproduce the identical result before and
 *     after this mutation for every correct migration, not just hardcoded
 *     ones. Flagging that as "suspected hardcoded" would incorrectly fail
 *     every legitimate schema-only task (e.g. "add a composite index",
 *     "rename a column", "add a foreign key constraint" when verified purely
 *     by inspecting the constraint's declared existence rather than its
 *     enforced effect on data) -- this is the answer to the task brief's own
 *     open question about whether a data-independent verification_query
 *     should be allowed for a schema-only migration: YES, it is a first-class,
 *     legitimate style for this category, and the anti-hardcoding
 *     differential check is the thing that adapts to that (via this
 *     exemption), not the dataset-authoring rule that forbids it.
 *   - Residual, deliberately NOT exempted (identical residual to the
 *     sibling's own, restated here for this category): a migration_script
 *     that is technically DATA-DEPENDENT in form but whose verification_query
 *     happens to compute a data-INDEPENDENT constant anyway (e.g. a
 *     verification_query of `SELECT COUNT(*) - COUNT(*) FROM users` after a
 *     migration that adds an unused column) will be flagged suspected-
 *     hardcoded by this differential check even though migration_script
 *     itself may be entirely genuine -- the check inspects the QUERY'S
 *     result, not the migration's logic directly, and cannot distinguish
 *     "verification_query is a bad, data-independent check" from "the
 *     migration truly does nothing row-dependent" in general. Treated as a
 *     dataset-authoring defect (write a verification_query that actually
 *     exercises the migration's effect), not a gap to special-case.
 *
 * TABLE/SCHEMA-REFERENCE REQUIRED (mirrors sql_query_correctness's own
 * "must reference a real table" hard-reject, adapted): verification_query
 * must reference at least one table name declared in initial_schema_ddl OR
 * created by migration_script itself (a table-rebuild migration may create
 * a brand-new table name that never appeared in initial_schema_ddl), OR use
 * one of the recognized schema-introspection call forms (pragma_table_info(
 * / pragma_index_list( / pragma_index_info( / pragma_foreign_key_list( /
 * pragma_foreign_key_check( / a bare reference to sqlite_master). A query
 * with neither -- a pure literal computation with no real table or schema
 * reference at all -- provides zero signal about migration competency and is
 * rejected up front as a real failure, before the anti-hardcoding machinery
 * even runs, exactly like the sibling's decision.
 *
 * STDOUT-HIJACK / EXIT-FORGERY DEFENSES -- DELIBERATELY NOT APPLIED HERE:
 * identical reasoning to sql_query_correctness's own module doc comment.
 * Every field here (initial_schema_ddl, initial_fixture_data,
 * migration_script, verification_query) is pure SQL TEXT, passed as data into
 * conn.executescript()/cursor.execute() calls inside a driver script THIS
 * harness authors in full -- never exec()'d as Python, so there is no code
 * path for contributor-controlled text to reassign sys.stdout, register an
 * atexit hook, or call sys.exit()/os._exit() before this harness's own
 * trailing print runs. A plain sys.stdout.write(...) for the verdict line is
 * therefore exactly as safe as the os.write(1, ...) pattern other harnesses
 * in this registry need for actual Python-executing categories.
 */
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 20000;
const MUTATION_DELTA = 999983;

// ------------------------------------------------------------- SQL parsing --
// Duplicated verbatim from sql_query_correctness/harness.js -- see that
// file's own function-level comments for the full rationale on each of
// these (comment/string-literal-aware stripping, backslash-run-parity quote
// handling, etc). Not re-derived here; kept identical on purpose so both
// harnesses' SQL-gating behavior stays provably in sync until/unless a
// shared helpers.js module is deliberately introduced for this pair.

function stripSqlNoise(sql) {
  const s = String(sql == null ? '' : sql);
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '-' && s[i + 1] === '-') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i = Math.min(i + 2, s.length);
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      out += q;
      i++;
      while (i < s.length) {
        if (s[i] === q && s[i + 1] === q) { out += '  '; i += 2; continue; }
        if (s[i] === q) { out += q; i++; break; }
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '[') {
      out += '[';
      i++;
      while (i < s.length && s[i] !== ']') { out += ' '; i++; }
      if (i < s.length) { out += ']'; i++; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Same list, same REPLACE-INTO carve-out, as sql_query_correctness's own
// FORBIDDEN_KEYWORDS_RE -- see that file's comment. Used only for
// verification_query's strict read-only gate below.
const FORBIDDEN_KEYWORDS_RE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|PRAGMA|CREATE|TRUNCATE|VACUUM|REINDEX|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const REPLACE_INTO_RE = /\bREPLACE\s+INTO\b/i;
const ORDER_BY_RE = /\bORDER\s+BY\b/i;

/** verification_query's gate -- identical posture and rationale to
 * sql_query_correctness's gateSelectOnly (see this file's module doc comment
 * for why verification_query, unlike migration_script, gets this strict a
 * gate). Returns { ok:true, stripped } or { ok:false, reason }. */
function gateVerificationQuery(sql) {
  const stripped = stripSqlNoise(sql);
  const trimmed = stripped.trim();
  if (!trimmed) return { ok: false, reason: 'verification_query is empty' };
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    return { ok: false, reason: 'verification_query must start with SELECT or WITH (a CTE prefixing a SELECT) -- read-only checks only' };
  }
  const statements = stripped.split(';').map((p) => p.trim()).filter((p) => p.length > 0);
  if (statements.length > 1) {
    return { ok: false, reason: 'verification_query contains more than one statement (stacked ;-separated statements are not allowed) -- exactly one read-only SELECT/WITH statement only' };
  }
  if (REPLACE_INTO_RE.test(stripped)) {
    return { ok: false, reason: 'verification_query contains "REPLACE INTO", a write statement -- not allowed' };
  }
  const m = stripped.match(FORBIDDEN_KEYWORDS_RE);
  if (m) {
    return { ok: false, reason: 'verification_query contains the forbidden keyword "' + m[1].toUpperCase() + '" -- only a read-only SELECT/WITH is allowed (schema introspection must use pragma_table_info(...)-style table-valued functions inside a SELECT, not the bare PRAGMA statement form)' };
  }
  return { ok: true, stripped };
}

// Defense-in-depth denylist applied to initial_schema_ddl, initial_fixture_data,
// AND migration_script -- see this file's module doc comment for why
// migration_script gets this narrower gate instead of gateVerificationQuery's
// strict one. ATTACH/DETACH/PRAGMA blocked; ordinary DDL/DML is of course
// expected and allowed.
const SETUP_FORBIDDEN_RE = /\b(ATTACH|DETACH|PRAGMA)\b/i;
function gateDenylistOnly(sql, fieldLabel) {
  const stripped = stripSqlNoise(sql);
  const m = stripped.match(SETUP_FORBIDDEN_RE);
  if (m) {
    return { ok: false, reason: fieldLabel + ' contains "' + m[1].toUpperCase() + '" -- ATTACH/DETACH/PRAGMA are blocked as a sandbox-hygiene measure and are never needed here (SQLite foreign-key enforcement is off by default under this harness\'s own connections, so a migration never needs to toggle it via PRAGMA)' };
  }
  return { ok: true };
}

/** Every CREATE TABLE name declared in a DDL string, quote-aware. Duplicated
 * from sql_query_correctness's extractTableNames -- see that file's comment
 * for the deliberate scope (double-quoted/bracketed/bare identifiers only,
 * not backtick-quoted). Used against BOTH initial_schema_ddl and
 * migration_script (a table-rebuild migration may CREATE a brand-new table
 * name that never appeared in initial_schema_ddl). */
function extractTableNames(ddl) {
  const stripped = stripSqlNoise(ddl);
  const re = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|\[([^\]]+)\]|(\w+))/gi;
  const names = [];
  let m;
  while ((m = re.exec(stripped))) {
    const name = m[1] || m[2] || m[3];
    if (name) names.push(name);
  }
  return names;
}

// Recognized schema-introspection call forms -- see this file's module doc
// comment (both the verification_query field help text and the "table/schema
// reference required" section) for why these count as a legitimate,
// data-independent reference to real schema machinery even when no table
// NAME from initial_schema_ddl/migration_script is textually present (the
// argument is usually a string literal naming the table, but this check does
// not require parsing it out -- the call form alone is sufficient evidence
// this is not a bare literal computation like `SELECT 1+1`).
const INTROSPECTION_RE = /\bpragma_table_info\s*\(|\bpragma_index_list\s*\(|\bpragma_index_info\s*\(|\bpragma_foreign_key_list\s*\(|\bpragma_foreign_key_check\s*\(|\bsqlite_master\b/i;

// ------------------------------------------------------------ comparison ---
// Duplicated verbatim from sql_query_correctness's own comparison functions
// -- see that file's comments for the float-tolerance / NULL-handling /
// ORDER-BY-detected-textually rationale. Not re-derived.

function cellCanon(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v && typeof v === 'object' && typeof v.__blob_hex__ === 'string') return 'blob:' + v.__blob_hex__;
  return v;
}

function cellsEqual(a, b) {
  a = cellCanon(a);
  b = cellCanon(b);
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    const diff = Math.abs(a - b);
    return diff < 1e-6 || diff <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
  }
  return a === b;
}

function rowEqualOrdered(r1, r2) {
  if (!Array.isArray(r1) || !Array.isArray(r2) || r1.length !== r2.length) return false;
  for (let i = 0; i < r1.length; i++) if (!cellsEqual(r1[i], r2[i])) return false;
  return true;
}

function compareOrdered(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) if (!rowEqualOrdered(actual[i], expected[i])) return false;
  return true;
}

function rowKey(row) {
  return JSON.stringify(row.map((c) => {
    const v = cellCanon(c);
    return typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v;
  }));
}

function multisetOf(rows) {
  const m = new Map();
  for (const row of rows) {
    if (!Array.isArray(row)) return null;
    const k = rowKey(row);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

function compareMultiset(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
  const a = multisetOf(actual);
  const e = multisetOf(expected);
  if (a === null || e === null) return false;
  if (a.size !== e.size) return false;
  for (const [k, c] of a) if (e.get(k) !== c) return false;
  return true;
}

function resultsEqual(actual, expected, ordered) {
  return ordered ? compareOrdered(actual, expected) : compareMultiset(actual, expected);
}

// -------------------------------------------------------- Python driver ---

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/** The whole verification program, run once via a single python3 subprocess.
 * PRIMARY: builds initial_schema_ddl+initial_fixture_data, applies
 * migration_script for real, runs verification_query against the result.
 * MUTATED (only attempted if the primary run cleanly migrated AND verified):
 * independently builds the SAME initial state, applies mutate_db's generic
 * per-table clone-and-perturb BEFORE migrating (see this file's module doc
 * comment for why that ordering -- pre-migration, not post -- is load-bearing
 * for this category), then applies the SAME migration_script and runs the
 * SAME verification_query. Both phases happen in one process/one JSON result
 * for the same reason sql_query_correctness's own driver does. */
function buildDriverScript(schemaDdl, fixtureData, migrationScript, verificationQuery, primaryPath, mutatedPath, mark) {
  return [
    'import sqlite3, json, os, sys',
    '',
    'MARK = ' + pyStr(mark),
    'SCHEMA_DDL = ' + pyStr(schemaDdl),
    'FIXTURE_DATA = ' + pyStr(fixtureData),
    'MIGRATION_SCRIPT = ' + pyStr(migrationScript),
    'VERIFICATION_QUERY = ' + pyStr(verificationQuery),
    'PRIMARY_PATH = ' + pyStr(primaryPath),
    'MUTATED_PATH = ' + pyStr(mutatedPath),
    'MUTATION_DELTA = ' + JSON.stringify(MUTATION_DELTA),
    '',
    'def to_jsonable(v):',
    '    if isinstance(v, bytes):',
    '        return {"__blob_hex__": v.hex()}',
    '    return v',
    '',
    'def quote_ident(name):',
    '    return chr(34) + str(name).replace(chr(34), chr(34) * 2) + chr(34)',
    '',
    '# No PRAGMA foreign_keys=ON here, deliberately -- see this file\'s (JS-side)',
    '# module doc comment: FK enforcement stays at sqlite3\'s own default (off),',
    '# matching what a real migration author can rely on, and matching the',
    '# gate\'s own denylist rationale for why no legitimate migration_script',
    '# needs a PRAGMA statement at all under this harness.',
    'def build_db(path, schema_ddl, fixture_data):',
    '    if os.path.exists(path):',
    '        os.remove(path)',
    '    conn = sqlite3.connect(path)',
    '    conn.executescript(schema_ddl)',
    '    conn.executescript(fixture_data)',
    '    conn.commit()',
    '    return conn',
    '',
    'def run_query(conn, sql):',
    '    cur = conn.cursor()',
    '    cur.execute(sql)',
    '    rows = cur.fetchall()',
    '    return [[to_jsonable(cell) for cell in row] for row in rows]',
    '',
    'def user_tables(conn):',
    '    cur = conn.cursor()',
    '    cur.execute("SELECT name FROM sqlite_master WHERE type=\'table\' AND name NOT LIKE \'sqlite_%\'")',
    '    return [r[0] for r in cur.fetchall()]',
    '',
    '# Generic, schema-agnostic anti-hardcoding mutation -- duplicated verbatim',
    '# from sql_query_correctness\'s own mutate_db (see that harness.js\'s',
    '# Python-side comment for the full non-PK-integer/FK-preserving',
    '# rationale). Run here against the PRE-MIGRATION database -- see this',
    '# file\'s (JS-side) module doc comment for why that ordering matters for',
    '# this category specifically.',
    'def mutate_db(conn):',
    '    mutated = 0',
    '    for table in user_tables(conn):',
    '        cur = conn.cursor()',
    '        try:',
    '            cur.execute("PRAGMA table_info(" + quote_ident(table) + ")")',
    '            cols = cur.fetchall()',
    '        except sqlite3.Error:',
    '            continue',
    '        if not cols:',
    '            continue',
    '        try:',
    '            cur.execute("SELECT * FROM " + quote_ident(table) + " LIMIT 1")',
    '            row = cur.fetchone()',
    '        except sqlite3.Error:',
    '            continue',
    '        if row is None:',
    '            continue',
    '        colnames = [c[1] for c in cols]',
    '        coltypes = [str(c[2] or "").upper() for c in cols]',
    '        pk_positions = [i for i, c in enumerate(cols) if c[5] and c[5] > 0]',
    '        new_values = []',
    '        for idx, val in enumerate(row):',
    '            is_sole_int_pk = (len(pk_positions) == 1 and pk_positions[0] == idx and "INT" in coltypes[idx])',
    '            if is_sole_int_pk:',
    '                new_values.append(None)',
    '            elif val is None:',
    '                new_values.append(None)',
    '            elif isinstance(val, bool):',
    '                new_values.append(0 if val else 1)',
    '            elif isinstance(val, int):',
    '                # Left UNCHANGED -- see sql_query_correctness\'s mutate_db',
    '                # comment: an integer shift here would land on a foreign-',
    '                # key column exactly as easily as a genuine value column,',
    '                # silently breaking the very relationship a migration\'s',
    '                # own FK-aware backfill logic may depend on.',
    '                new_values.append(val)',
    '            elif isinstance(val, float):',
    '                new_values.append(val + float(MUTATION_DELTA))',
    '            elif isinstance(val, str):',
    '                new_values.append(val + "_mut1")',
    '            else:',
    '                new_values.append(val)',
    '        placeholders = ",".join(["?"] * len(colnames))',
    '        insert_sql = ("INSERT INTO " + quote_ident(table) + " (" +',
    '                      ",".join(quote_ident(c) for c in colnames) +',
    '                      ") VALUES (" + placeholders + ")")',
    '        try:',
    '            cur.execute(insert_sql, new_values)',
    '            mutated += 1',
    '        except sqlite3.Error:',
    '            try:',
    '                conn.rollback()',
    '            except sqlite3.Error:',
    '                pass',
    '    conn.commit()',
    '    return mutated',
    '',
    '# STRATEGY 2 -- VALUE-SHIFT, EXTENDED TO MULTIPLE ATTEMPTS -- ported from',
    '# sql_query_correctness\'s own extended Strategy 2 (see that harness.js\'s',
    '# Python-side comment for the full rationale) with ONE adaptation: every',
    '# attempt below re-applies MIGRATION_SCRIPT (pre-migration mutation, same',
    '# ordering as mutate_db above) before re-running VERIFICATION_QUERY, since',
    '# this category verifies the MIGRATED state, not the raw fixture. Every',
    '# attempt runs against a throwaway **in-memory** database',
    '# (sqlite3.connect(":memory:"), never touching disk).',
    'SHIFT_CAP_ROWS_PER_TABLE = 10',
    'SHIFT_ALL_ROWID_CAP = 5000',
    '',
    'def fresh_mem_conn():',
    '    conn = sqlite3.connect(":memory:")',
    '    conn.executescript(SCHEMA_DDL)',
    '    conn.executescript(FIXTURE_DATA)',
    '    conn.commit()',
    '    return conn',
    '',
    '# Shifts ONE existing row\'s non-key INTEGER *and TEXT* columns via a',
    '# single UPDATE ... WHERE rowid = ? -- identical column-eligibility logic',
    '# to the original single-attempt design for PK/NULL/bool exclusion (every',
    '# PRAGMA-flagged primary-key column, composite or not, is left alone;',
    '# NULL/bool runtime values are left alone). INTEGER columns are shifted by',
    '# MUTATION_DELTA, same as always. TEXT columns are suffixed with',
    '# "_shift2" (distinct from mutate_db\'s own "_mut1" clone suffix purely for',
    '# debuggability -- the two never interact) -- ported from',
    '# sql_query_correctness\'s own identical fix, see that harness.js\'s',
    '# module doc comment, "THE THIRD CONFIRMED PRODUCTION BUG..." section, for',
    '# the full rationale: mutate_db\'s CLONE also suffixes TEXT columns, but on',
    '# a brand-new INSERTed row, which means the clone can never land INSIDE a',
    '# TEXT equality filter or TEXT GROUP BY key it would otherwise belong to',
    '# -- an in-place UPDATE on an EXISTING row has the opposite property: it',
    '# genuinely moves that row OUT of whatever TEXT-keyed filter/group it was',
    '# already a member of. This closes the identical gap here that the',
    '# sibling found on sql_query, since verification_query is exactly the same',
    '# shape of read-only SELECT/WITH. A foreign key column (INTEGER or TEXT)',
    '# IS a legitimate shift target here (see mutate_db\'s own comment for why',
    '# mutate_db\'s CLONE must avoid this but an in-place UPDATE on an EXISTING,',
    '# already-referenced row does not). REAL columns are deliberately NOT',
    '# shifted here -- see the sibling\'s module doc comment for why that is',
    '# left as a documented, evidence-driven residual rather than spun up',
    '# speculatively. Returns True if at least one column was actually shifted,',
    '# False if this row had no eligible column at all -- not an error, just',
    '# nothing to shift here.',
    'def shift_row(conn, table, cols, pk_positions, rowid):',
    '    cur = conn.cursor()',
    '    cur.execute("SELECT * FROM " + quote_ident(table) + " WHERE rowid = ?", [rowid])',
    '    row = cur.fetchone()',
    '    if row is None:',
    '        return False',
    '    colnames = [c[1] for c in cols]',
    '    set_clauses = []',
    '    params = []',
    '    for idx, val in enumerate(row):',
    '        if idx in pk_positions:',
    '            continue',
    '        if val is None:',
    '            continue',
    '        if isinstance(val, bool):',
    '            continue',
    '        if isinstance(val, int):',
    '            set_clauses.append(quote_ident(colnames[idx]) + " = ?")',
    '            params.append(val + MUTATION_DELTA)',
    '        elif isinstance(val, str):',
    '            set_clauses.append(quote_ident(colnames[idx]) + " = ?")',
    '            params.append(val + "_shift2")',
    '    if not set_clauses:',
    '        return False',
    '    update_sql = ("UPDATE " + quote_ident(table) + " SET " +',
    '                  ",".join(set_clauses) + " WHERE rowid = ?")',
    '    params.append(rowid)',
    '    cur.execute(update_sql, params)',
    '    return True',
    '',
    '# Runs a shifted pre-migration database through MIGRATION_SCRIPT then',
    '# VERIFICATION_QUERY, returning an attempt record -- {"ok": True, "rows":',
    '# [...]} only if BOTH steps complete without error (folded into one',
    '# failure bucket per attempt -- see this file\'s JS-side module doc',
    '# comment for why that loses no information this category\'s own',
    '# strategyStatus needs), else {"ok": False, "error": "..."}.',
    'def run_migration_and_verify(conn):',
    '    try:',
    '        conn.executescript(MIGRATION_SCRIPT)',
    '        conn.commit()',
    '    except Exception as e:',
    '        return {"ok": False, "error": str(e)}',
    '    try:',
    '        return {"ok": True, "rows": run_query(conn, VERIFICATION_QUERY)}',
    '    except Exception as e:',
    '        return {"ok": False, "error": str(e)}',
    '',
    '# Runs every Strategy 2 attempt -- see module doc comment for the two',
    '# KINDS (isolated single-row, and one combined shift-ALL, both always',
    '# confined to ONE table at a time, every other table left untouched,',
    '# applied PRE-migration) -- and returns (attempts, applicable_table_count).',
    '# The actual "did this attempt\'s result differ from the primary run" check',
    '# is deliberately left to the JS side (resultsEqual), the single source of',
    '# truth for ordered-vs-multiset/float-tolerant comparison semantics,',
    '# exactly like Strategy 1\'s own mutated_rows.',
    'def run_shift_attempts():',
    '    attempts = []',
    '    applicable_tables = set()',
    '    probe = fresh_mem_conn()',
    '    table_plan = []',
    '    for table in user_tables(probe):',
    '        cur = probe.cursor()',
    '        try:',
    '            cur.execute("PRAGMA table_info(" + quote_ident(table) + ")")',
    '            cols = cur.fetchall()',
    '        except sqlite3.Error:',
    '            continue',
    '        if not cols:',
    '            continue',
    '        pk_positions = set(i for i, c in enumerate(cols) if c[5] and c[5] > 0)',
    '        try:',
    '            cur.execute("SELECT rowid FROM " + quote_ident(table) + " ORDER BY rowid LIMIT ?", [SHIFT_ALL_ROWID_CAP])',
    '            all_rowids = [r[0] for r in cur.fetchall()]',
    '        except sqlite3.Error:',
    '            continue',
    '        if not all_rowids:',
    '            continue',
    '        table_plan.append((table, cols, pk_positions, all_rowids))',
    '    probe.close()',
    '',
    '    for table, cols, pk_positions, all_rowids in table_plan:',
    '        table_had_eligible = False',
    '        # Kind (1) -- SEPARATE, ISOLATED single-row attempts, one row',
    '        # shifted at a time, every other row (in this table and every',
    '        # other table) left exactly as the fixture, THEN migration_script',
    '        # re-applied and verification_query re-run.',
    '        for rowid in all_rowids[:SHIFT_CAP_ROWS_PER_TABLE]:',
    '            conn = fresh_mem_conn()',
    '            try:',
    '                try:',
    '                    shifted = shift_row(conn, table, cols, pk_positions, rowid)',
    '                except sqlite3.Error:',
    '                    shifted = False',
    '                if shifted:',
    '                    table_had_eligible = True',
    '                    conn.commit()',
    '                    attempts.append(run_migration_and_verify(conn))',
    '            finally:',
    '                conn.close()',
    '        # Kind (2) -- ONE combined "shift-ALL" attempt: every eligible',
    '        # row of THIS table (still no other table) shifted together,',
    '        # THEN migration_script re-applied and verification_query re-run.',
    '        conn = fresh_mem_conn()',
    '        try:',
    '            any_shifted = False',
    '            for rowid in all_rowids:',
    '                try:',
    '                    if shift_row(conn, table, cols, pk_positions, rowid):',
    '                        any_shifted = True',
    '                except sqlite3.Error:',
    '                    pass',
    '            if any_shifted:',
    '                table_had_eligible = True',
    '                conn.commit()',
    '                attempts.append(run_migration_and_verify(conn))',
    '        finally:',
    '            conn.close()',
    '',
    '        if table_had_eligible:',
    '            applicable_tables.add(table)',
    '',
    '    return attempts, len(applicable_tables)',
    '',
    'result = {}',
    'conn1 = None',
    'try:',
    '    conn1 = build_db(PRIMARY_PATH, SCHEMA_DDL, FIXTURE_DATA)',
    '    result["setup_ok"] = True',
    'except Exception as e:',
    '    result["setup_ok"] = False',
    '    result["setup_error"] = str(e)',
    '',
    'if conn1 is not None:',
    '    try:',
    '        conn1.executescript(MIGRATION_SCRIPT)',
    '        conn1.commit()',
    '        result["primary_migration_ok"] = True',
    '    except Exception as e:',
    '        result["primary_migration_ok"] = False',
    '        result["primary_migration_error"] = str(e)',
    '    if result.get("primary_migration_ok"):',
    '        try:',
    '            result["primary_rows"] = run_query(conn1, VERIFICATION_QUERY)',
    '            result["primary_verify_ok"] = True',
    '        except Exception as e:',
    '            result["primary_verify_ok"] = False',
    '            result["primary_verify_error"] = str(e)',
    '    try:',
    '        conn1.close()',
    '    except Exception:',
    '        pass',
    '',
    'if result.get("primary_migration_ok") and result.get("primary_verify_ok"):',
    '    conn2 = None',
    '    try:',
    '        conn2 = build_db(MUTATED_PATH, SCHEMA_DDL, FIXTURE_DATA)',
    '        result["mutated_table_count"] = mutate_db(conn2)',
    '    except Exception as e:',
    '        result["mutated_table_count"] = 0',
    '        result["mutation_setup_error"] = str(e)',
    '    if conn2 is not None and result.get("mutated_table_count", 0) > 0:',
    '        try:',
    '            conn2.executescript(MIGRATION_SCRIPT)',
    '            conn2.commit()',
    '            result["mutated_migration_ok"] = True',
    '        except Exception as e:',
    '            result["mutated_migration_ok"] = False',
    '            result["mutated_migration_error"] = str(e)',
    '        if result.get("mutated_migration_ok"):',
    '            try:',
    '                result["mutated_rows"] = run_query(conn2, VERIFICATION_QUERY)',
    '                result["mutated_verify_ok"] = True',
    '            except Exception as e:',
    '                result["mutated_verify_ok"] = False',
    '                result["mutated_verify_error"] = str(e)',
    '    if conn2 is not None:',
    '        try:',
    '            conn2.close()',
    '        except Exception:',
    '            pass',
    '',
    'if result.get("primary_migration_ok") and result.get("primary_verify_ok"):',
    '    try:',
    '        shift_attempts, shift_applicable_count = run_shift_attempts()',
    '        result["shift_attempts"] = shift_attempts',
    '        result["mutated_table_count2"] = shift_applicable_count',
    '    except Exception as e:',
    '        result["shift_attempts"] = []',
    '        result["mutated_table_count2"] = 0',
    '        result["mutation_setup_error2"] = str(e)',
    '',
    '# A plain write, not os.write(1, ...) -- see this file\'s module (JS-side)',
    '# doc comment for why the stdout-hijack defense used elsewhere in this',
    '# registry is a moot concern here (every field is SQL text, never exec()\'d',
    '# as Python).',
    'sys.stdout.write(MARK + json.dumps(result, default=str) + "\\n")',
    'sys.stdout.flush()',
  ].join('\n');
}

module.exports = {
  contract: 'state-sequence-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const schemaDdl = h.str(row, 'initial_schema_ddl');
    const fixtureData = h.str(row, 'initial_fixture_data');
    const migrationScript = h.str(row, 'migration_script');
    const verificationQuery = h.str(row, 'verification_query');
    const expectedRaw = h.str(row, 'expected_verification_result');

    if (!taskDescription.trim() || !schemaDdl.trim() || !fixtureData.trim() || !migrationScript.trim() || !verificationQuery.trim() || !expectedRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, initial_schema_ddl, initial_fixture_data, migration_script, verification_query, or expected_verification_result' } };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    // Security gates -- see module doc comment for why migration_script gets
    // the narrower denylist-only gate (the OPPOSITE posture from
    // verification_query's strict single-SELECT gate) rather than a
    // regression of sql_query_correctness's rule.
    const ddlGate = gateDenylistOnly(schemaDdl, 'initial_schema_ddl');
    if (!ddlGate.ok) return { passed: false, logs: ddlGate.reason, detail: { reason: 'initial_schema_ddl_gate_failed' } };
    const fixtureGate = gateDenylistOnly(fixtureData, 'initial_fixture_data');
    if (!fixtureGate.ok) return { passed: false, logs: fixtureGate.reason, detail: { reason: 'initial_fixture_data_gate_failed' } };
    const migrationGate = gateDenylistOnly(migrationScript, 'migration_script');
    if (!migrationGate.ok) return { passed: false, logs: migrationGate.reason, detail: { reason: 'migration_script_gate_failed' } };

    const vGate = gateVerificationQuery(verificationQuery);
    if (!vGate.ok) {
      return { passed: false, logs: 'verification_query rejected before execution: ' + vGate.reason, detail: { reason: 'verification_query_gate_failed', gateReason: vGate.reason } };
    }

    // Table/schema-reference required -- see module doc comment. Table names
    // are drawn from BOTH initial_schema_ddl and migration_script (a
    // table-rebuild migration may CREATE a brand-new table name).
    const tableNames = extractTableNames(schemaDdl).concat(extractTableNames(migrationScript));
    if (tableNames.length === 0 && !INTROSPECTION_RE.test(vGate.stripped)) {
      return { passed: false, detail: { reason: 'initial_schema_ddl declares no CREATE TABLE statements and verification_query is not a recognized schema-introspection form' } };
    }
    const referencesSchema = INTROSPECTION_RE.test(vGate.stripped) ||
      tableNames.some((t) => new RegExp('\\b' + escapeRegex(t) + '\\b', 'i').test(vGate.stripped));
    if (!referencesSchema) {
      return {
        passed: false,
        logs: 'verification_query does not reference any table declared in initial_schema_ddl/migration_script, nor a recognized schema-introspection form (pragma_table_info/pragma_index_list/pragma_index_info/pragma_foreign_key_list/pragma_foreign_key_check/sqlite_master) -- a query with no real table or schema reference is out of scope for this category',
        detail: { reason: 'no_table_or_schema_reference', tables: tableNames },
      };
    }

    const expectedParsed = h.jsonOf(expectedRaw);
    if (!Array.isArray(expectedParsed) || !expectedParsed.every((r) => Array.isArray(r))) {
      return { passed: false, detail: { reason: 'expected_verification_result must be a JSON array of row-arrays, e.g. [[1,"a@example.com"],[2,"b@example.com"]]' } };
    }

    const d = h.workdir();
    const primaryPath = h.path.join(d, 'primary.db');
    const mutatedPath = h.path.join(d, 'mutated.db');
    const mark = '@@DBMIGROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(schemaDdl, fixtureData, migrationScript, verificationQuery, primaryPath, mutatedPath, mark);
    const scriptPath = h.path.join(d, 'run_migration.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });
    if (r.timedOut) {
      return { passed: false, logs: 'migration_script/verification_query did not complete within the time budget', detail: { reason: 'timed_out' } };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 1500), detail: { reason: 'driver_crashed' } };
    }

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }
    if (!out || typeof out !== 'object') {
      return { passed: false, logs: 'could not parse verification output', detail: { reason: 'unparseable_output' } };
    }

    if (!out.setup_ok) {
      return { passed: false, logs: 'initial_schema_ddl/initial_fixture_data failed to load: ' + String(out.setup_error || '').slice(0, 500), detail: { reason: 'initial_state_setup_failed' } };
    }
    // A migration that fails to execute is a REAL failure -- the migration
    // itself is broken -- never runtimeUnavailable. See module doc comment.
    if (!out.primary_migration_ok) {
      return { passed: false, logs: 'migration_script failed to execute against initial_fixture_data: ' + String(out.primary_migration_error || '').slice(0, 500), detail: { reason: 'migration_failed' } };
    }
    if (!out.primary_verify_ok) {
      return { passed: false, logs: 'verification_query failed to execute against the migrated database: ' + String(out.primary_verify_error || '').slice(0, 500), detail: { reason: 'verification_query_failed_after_migration' } };
    }

    const actualRows = out.primary_rows;
    const ordered = ORDER_BY_RE.test(vGate.stripped);
    const primaryMatches = resultsEqual(actualRows, expectedParsed, ordered);
    if (!primaryMatches) {
      return {
        passed: false,
        logs: 'verification_query produced ' + JSON.stringify(actualRows).slice(0, 300) + ' but expected_verification_result is ' + JSON.stringify(expectedParsed).slice(0, 300) + (ordered ? ' (compared as an ORDERED sequence -- verification_query contains ORDER BY)' : ' (compared as an order-insensitive multiset)'),
        detail: { reason: 'result_mismatch', ordered },
      };
    }

    // Anti-hardcoding differential check -- see module doc comment. TWO
    // independent mutation strategies are combined here (Strategy 1:
    // mutate_db's row-add/clone; Strategy 2: mutate_db_shift's in-place
    // value-shift of an existing row, both applied PRE-migration, then
    // migration_script re-applied and verification_query re-run) --
    // duplicated from sql_query_correctness's own combination logic, see
    // that harness.js's module doc comment for the full rationale
    // (including the confirmed production bug this closes and the
    // deliberately ASYMMETRIC combination -- Strategy 2 alone is never
    // sufficient to prove hardcoding by itself, only to help prove
    // data-dependence).
    const mutatedTableCount = Number(out.mutated_table_count || 0);
    const mutatedTableCount2 = Number(out.mutated_table_count2 || 0);
    const isIntrospection = INTROSPECTION_RE.test(vGate.stripped);
    const isDistinct = /\bDISTINCT\b/i.test(vGate.stripped);

    // { applicable, ran, differed } for one strategy -- see
    // sql_query_correctness's identical helper for the field meanings. "ran"
    // here requires BOTH the re-applied migration_script AND the re-run
    // verification_query to have completed without error.
    function strategyStatus(applicableCount, migrationOk, verifyOk, mutatedRows) {
      if (!(applicableCount > 0)) return { applicable: false, ran: false, differed: false };
      if (!migrationOk || !verifyOk) return { applicable: true, ran: false, differed: false };
      return { applicable: true, ran: true, differed: !resultsEqual(mutatedRows, actualRows, ordered) };
    }

    const s1 = strategyStatus(mutatedTableCount, out.mutated_migration_ok, out.mutated_verify_ok, out.mutated_rows);

    // Strategy 2's own status, extended for MULTIPLE attempts -- see
    // sql_query_correctness's identical strategy2Status helper (module doc
    // comment, "THE EXTENSION" section) for the full rationale. applicable
    // keeps its original per-table meaning; "ran" is true if AT LEAST ONE
    // attempt (each already folding "migration re-apply failed" and "verify
    // failed" into one ok:false bucket -- see run_migration_and_verify's own
    // Python-side comment) completed without error; "differed" is true if AT
    // LEAST ONE attempt that ran produced a result differing from the
    // primary run's.
    function strategy2Status(applicableCount, attempts) {
      if (!(applicableCount > 0)) return { applicable: false, ran: false, differed: false };
      const ranAttempts = Array.isArray(attempts) ? attempts.filter((a) => a && a.ok === true && Array.isArray(a.rows)) : [];
      if (ranAttempts.length === 0) return { applicable: true, ran: false, differed: false };
      const differed = ranAttempts.some((a) => !resultsEqual(a.rows, actualRows, ordered));
      return { applicable: true, ran: true, differed };
    }

    const s2 = strategy2Status(mutatedTableCount2, out.shift_attempts);

    let hardcodeCheck;
    if (!s1.applicable && !s2.applicable) {
      // Neither strategy found any table with a row to mutate -- see module
      // doc comment; no verdict either way.
      hardcodeCheck = 'skipped_no_mutable_table';
    } else if (s1.differed || s2.differed) {
      // One working perturbation is sufficient proof of data-dependence --
      // see sql_query_correctness's module doc comment for why requiring
      // BOTH to differ would be the wrong bar.
      hardcodeCheck = 'ran_and_differed';
    } else if (s1.applicable && s1.ran) {
      // Strategy 1 -- the COMPREHENSIVE mutation (fresh PK, every TEXT
      // column suffixed, every REAL column shifted, a whole new row added,
      // then migration_script re-applied) -- ran cleanly and reproduced an
      // IDENTICAL result, and Strategy 2 did not differ either. Strategy 2
      // alone running clean-and-identical (Strategy 1 inapplicable/erroring)
      // deliberately does NOT reach this branch -- see
      // sql_query_correctness's module doc comment for the concrete
      // false-positive (a CHECK-constraint-blocked table paired with a
      // TEXT-only-dependent check) this asymmetry exists to prevent.
      if (isIntrospection) {
        hardcodeCheck = 'skipped_schema_introspection_query';
      } else if (isDistinct) {
        hardcodeCheck = 'skipped_distinct_query_ambiguous';
      } else {
        return {
          passed: false,
          logs: 'verification_query produced the IDENTICAL result before and after the initial fixture was mutated (one additional/altered row per table), and every supplementary value-shift attempt (isolated single-row shifts across multiple rows, plus a combined shift of every row per table, migration_script re-applied for each) found no difference either -- this looks hardcoded to the given fixture rather than genuinely general migration logic',
          detail: { reason: 'suspected_hardcoded', mutatedTableCount, mutatedTableCount2 },
        };
      }
    } else {
      // Strategy 1 either errored or never found a table to mutate (and,
      // per the asymmetry above, Strategy 2 alone -- even if it ran clean
      // and identical -- is not treated as sufficient proof by itself) --
      // inconclusive, not a failure. See module doc comment for why
      // migration_script (or verification_query) erroring against a
      // schema-identical, row-only-mutated copy where the PRIMARY run did
      // not is fragility, not proof of anything.
      hardcodeCheck = 'mutation_run_failed_inconclusive';
    }

    return {
      passed: true,
      score: 1,
      detail: {
        reason: 'ok',
        ordered,
        rowCount: Array.isArray(actualRows) ? actualRows.length : 0,
        mutatedTableCount,
        mutatedTableCount2,
        hardcodeCheck,
      },
    };
  },
};
