/**
 * query-result-match — sql_query must produce expected_result when executed
 * for real against a fresh SQLite database built from schema_ddl +
 * fixture_data. This is the Spider/BIRD "execution accuracy" methodology:
 * the query is graded by RUNNING it and comparing the real result set, never
 * by comparing SQL text/AST against a reference query.
 *
 * expected_result's shape (documented in schema.json's help text too): a
 * JSON array of ROW-ARRAYS, in column-output order, e.g.
 * [[1, "Ada", 36], [2, "Grace", 41]]. Column NAMES are never compared, only
 * cell values by position -- this matches Python's own
 * sqlite3.Cursor.fetchall() shape exactly and avoids forcing every
 * computed/aggregate column to be aliased just so a column-keyed comparison
 * has something to key on (a real problem: `SELECT COUNT(*) FROM t` has no
 * natural column name at all without an explicit AS).
 *
 * ORDERED vs MULTISET comparison: per BIRD's own execution-accuracy
 * methodology (Zhong et al., "Can LLM Already Serve as A Database Interface?
 * A BIg Bench for Large-Scale Database Grounded Text-to-SQLs", NeurIPS 2023 --
 * results are compared as an ORDERED sequence only when the query's own SQL
 * asks for one via ORDER BY, and as an unordered multiset otherwise, since a
 * query with no ORDER BY has no defined row order to grade against), a row
 * order difference is only ever a real defect when sql_query itself contains
 * ORDER BY. Detected once, textually, from sql_query -- comment/string-
 * literal-aware (see stripSqlNoise) so a WHERE clause literal that happens to
 * contain the words "order by" cannot flip the comparison mode.
 *
 * GATE 2 (why this is a real security/contract-integrity gate, not a style
 * nit): sql_query is required to be exactly one read-only SELECT/WITH
 * statement, rejected outright (a real failure, not runtimeUnavailable)
 * otherwise. Two independent reasons, not one:
 *   (a) CONTRACT INTEGRITY -- this category's entire correctness bar is
 *       "sql_query, run against the GIVEN fixture, produces expected_result".
 *       If sql_query were allowed to also contain DML/DDL (e.g.
 *       "DELETE FROM t; INSERT INTO t VALUES (...); SELECT ...") it could
 *       trivially manufacture ANY expected_result by mutating the fixture
 *       into whatever shape makes the trailing SELECT match, which would
 *       make the whole category unfalsifiable -- every row would "pass" by
 *       construction, verifying nothing about the contributor's SQL
 *       competency at all.
 *   (b) SANDBOX HYGIENE -- sql_query's text is interpolated into a Python
 *       driver script THIS harness writes and runs via `cursor.execute()`,
 *       inside the same disposable sandbox every other category already
 *       treats as running untrusted contributor content. A stacked
 *       DROP TABLE / ATTACH DATABASE '/some/path' AS x / PRAGMA statement
 *       is real SQL, not a style violation, and gets a real, if narrow,
 *       capability inside that sandbox if allowed through.
 *
 * schema_ddl / fixture_data are NOT held to the same single-statement rule
 * (they are legitimately many CREATE TABLE / INSERT statements, run via
 * `executescript()`), but DO get a narrower, defense-in-depth denylist on
 * ATTACH/DETACH/PRAGMA -- ATTACH DATABASE is a core, always-available SQLite
 * statement (no extension needed) that can open/create a file at an
 * arbitrary path the OS process can write to, and nothing about defining a
 * schema or seeding fixture rows ever legitimately needs it. This is
 * deliberately narrower than Gate 2: DDL/DML keywords are of course expected
 * and allowed here.
 *
 * ANTI-HARDCODING CHECK (the load-bearing exploit defense for this category):
 * after the primary run passes, the SAME sql_query is re-run against TWO
 * further, independently-built databases -- each built from the same
 * schema_ddl + fixture_data, each carrying a DIFFERENT generic,
 * schema-agnostic mutation. TWO strategies, not one, exist because Strategy 1
 * alone (the original, and still primary, mutation) was found -- via real
 * community submissions to a live pool, not a local test -- to have a
 * systematic blind spot on a whole shape of genuinely correct query; see
 * "THE CONFIRMED PRODUCTION BUG" below before "STRATEGY 2".
 *
 * STRATEGY 1 -- ROW-ADD (mutateDb/mutate_db): for every user table that has
 * any rows, one existing row is cloned with: a sole INTEGER PRIMARY KEY
 * column left NULL (so SQLite assigns the clone a fresh id), every TEXT
 * column suffixed, every REAL column shifted by a large fixed offset, and
 * every OTHER (non-PK) INTEGER column left UNCHANGED. That last part was NOT
 * the first version of this mutation -- shifting non-PK integers too was
 * tried first and reverted after it false-rejected a genuinely correct JOIN
 * row in this file's own self-test: an integer shift lands on a foreign-key
 * column (e.g. orders.customer_id) exactly as easily as a genuine value
 * column, and a cloned CHILD row whose FK no longer points at any real parent
 * simply disappears from an inner join's output -- making a perfectly
 * correct join query look data-independent purely because of how the
 * mutation perturbed it, not because of anything about the query itself.
 * Leaving non-PK integers untouched means a cloned child row still
 * legitimately joins to its original parent (proving the join really does
 * depend on the data, via the new row now appearing in the joined output),
 * while the clone's fresh PK and perturbed TEXT/REAL columns still give
 * filters/aggregations genuine new-row and new-value signal to react to.
 *
 * THE CONFIRMED PRODUCTION BUG (found via 30 freshly-authored, genuinely
 * correct rows submitted to a real community pool; 10 wrongly flagged
 * suspected_hardcoded, independently re-confirmed by hand-reproducing with
 * real sqlite3 before this fix): leaving every non-PK INTEGER column
 * unperturbed is exactly right for protecting a foreign key, but it also
 * means Strategy 1's ONLY new signal for an INTEGER-valued column is "one
 * more row now exists, holding a value equal to an EXISTING row's value for
 * that column" -- invisible to any query whose INTEGER-column logic is a
 * THRESHOLD or EQUALITY comparison against an aggregate over the whole table
 * (`HAVING COUNT(*) > 2`, `WHERE x > (SELECT AVG(x) FROM t)`,
 * `WHERE x = (SELECT MAX(x) FROM t)`), because adding one more copy of an
 * existing value moves the aggregate only slightly and, on the small (2-6
 * row) fixtures this category's rows realistically use, essentially never
 * moves it far enough to flip which rows satisfy the threshold. Two
 * representative, hand-confirmed real examples: (1) `SELECT tracking_id FROM
 * packages WHERE transit_days > (SELECT AVG(transit_days) FROM packages)`
 * over rows with transit_days 3,9,4,2 (avg 4.5, real answer just the row with
 * 9) -- Strategy 1 clones a row with transit_days left at 3, new avg 4.2,
 * STILL only the row with 9 qualifies, result unperturbed; (2) a CTE
 * `WITH ride_counts AS (SELECT driver_id, COUNT(*) cnt FROM rides GROUP BY
 * driver_id) SELECT driver_id FROM ride_counts WHERE cnt > 2` over a driver
 * with 3 rides -- Strategy 1 clones a ride row with driver_id left unchanged,
 * that driver's count goes 3->4, STILL > 2, result unperturbed. Both are
 * genuinely correct, real data-dependent queries wrongly flagged
 * suspected_hardcoded by Strategy 1 alone.
 *
 * A NAMING-CONVENTION FK HEURISTIC WAS CONSIDERED AND REJECTED as the fix:
 * skip Strategy 1's own non-perturbation of INTEGER columns specifically for
 * columns that do NOT look like a foreign key (e.g. do not end in `_id`),
 * and perturb the rest. Audited against this category's own real 100-row
 * reference dataset, every declared INTEGER column in it does, in fact,
 * cleanly split into "ends in `_id`" (a real FK/PK reference) vs "does not"
 * (a genuine value column) -- the heuristic is not obviously wrong on data
 * curated so far. But its correctness depends entirely on every
 * CONTRIBUTOR, forever, naming every foreign key column with an `_id` suffix
 * and never using that suffix for a genuine value column (a column named
 * `year_id` holding a fiscal-year VALUE rather than a reference to a `years`
 * table is a completely plausible contributor choice this heuristic would
 * mis-classify). A single misclassified column silently regresses the EXACT
 * false-positive Strategy 1's non-PK-integer carve-out was originally
 * designed around: a real FK gets shifted, a real join row disappears, a
 * genuinely correct join gets flagged hardcoded. Rejected in favor of a
 * strategy that needs to classify NO column ahead of time.
 *
 * STRATEGY 2 -- VALUE-SHIFT (mutateDbShift/mutate_db_shift), the fix: a
 * SECOND, independent mutation, run against its own third database. Instead
 * of adding a new row, one EXISTING row per table is picked (the same
 * deterministic "first row" a clone would have used) and every one of ITS
 * columns that PRAGMA table_info flags as part of ANY primary key -- not
 * just a SOLE integer PK the way Strategy 1's clone excludes, a stricter,
 * composite-key-safe carve-out appropriate for an in-place UPDATE on a row
 * that may already be referenced elsewhere -- is left alone; every other
 * INTEGER column is shifted by the same MUTATION_DELTA offset via one
 * UPDATE ... WHERE rowid = ?. This directly changes the value a
 * threshold/aggregate comparison is computed over, instead of adding a
 * same-valued duplicate the aggregate barely notices -- confirmed by real
 * testing to flip both production-bug examples above. Shifting a FOREIGN KEY
 * column's value is an intentional, safe, useful perturbation for this
 * strategy specifically (unlike Strategy 1, which must still leave FK-shaped
 * integers alone -- see Strategy 1's own carve-out above): shifting an
 * EXISTING, already-referenced row's FK in a purely read-only query either
 * orphans that one row out of an INNER JOIN's output or repoints it at a
 * different real parent row -- both real, well-defined perturbations a
 * genuinely data-dependent query reacts to, confirmed via real testing
 * against this file's own historical correct-JOIN self-test row (the join
 * row's output really does change, with no crash). This differs from
 * Strategy 1's now-reverted all-integer-shift attempt in one load-bearing
 * way: Strategy 1 CLONES a new row, so a clone whose FK points nowhere real
 * disappears from a join with ZERO signal (worse: can make a correct join
 * look hardcoded purely from clone construction). Strategy 2 mutates an
 * EXISTING row in place -- it can orphan or repoint that row, but it never
 * adds a signal-free phantom, so there is always a well-defined "did the
 * result change" answer. A table with no eligible non-key INTEGER column, or
 * no plain `rowid` (a WITHOUT ROWID table), is skipped for Strategy 2 only
 * (Strategy 1 still covers it independently, never crashes the run).
 *
 * THE SECOND CONFIRMED PRODUCTION BUG, AND STRATEGY 2's EXTENSION TO MULTIPLE
 * ATTEMPTS (found via 30 MORE freshly-authored, genuinely correct rows
 * submitted to a real community pool after the fix above shipped: subquery/
 * CTE pass rate rose from ~10% to 83%, but 5/30 rows were STILL wrongly
 * flagged suspected_hardcoded; all 5 traced to the SAME new root cause,
 * independently re-confirmed here with real sqlite3 before this fix):
 * Strategy 2's original design picked exactly ONE existing row per table --
 * deterministically, the lowest-`rowid` row (`... LIMIT 1` with no ORDER BY)
 * -- and shifted only that row. Nothing guarantees that ONE picked row is
 * actually relevant to a GIVEN query's specific filter/aggregate condition.
 * Two distinct failure shapes, both hand-confirmed:
 *   SHAPE A -- the picked row is already on the "wrong side" of a threshold,
 *     so shifting it further doesn't move which rows qualify. Real example:
 *     `SELECT pass_type FROM lift_passes WHERE price < 80` over rows with
 *     price 95,450,65,40 (INTEGER column) where the lowest-rowid row happens
 *     to hold price=95 (already >= 80) -- shifting it to 95+999983 changes
 *     nothing about which rows satisfy `price < 80`; Strategy 1 also misses
 *     this same query for the SAME row (Strategy 1's clone-source row is the
 *     identical lowest-rowid pick, and Strategy 1 never perturbs non-PK
 *     INTEGER columns by design), so the row was wrongly flagged hardcoded
 *     even though the query is genuinely data-dependent -- it is simply
 *     robust to what happened to be THIS one row's perturbation.
 *   SHAPE B -- shifting an existing row's FK value orphans it into a new
 *     group that gets dropped by the very INNER JOIN a `GROUP BY ... HAVING`/
 *     CTE-aggregate-then-JOIN-back-to-parent query relies on, leaving a
 *     MIN()/MAX()/AVG() computed over the SURVIVING groups unchanged (or
 *     changed in a way that doesn't flip the final comparison). Real,
 *     hand-traced example: "florist arrangements ordered more times than the
 *     least-ordered arrangement" -- a CTE groups `orders` by
 *     `arrangement_id` into per-arrangement counts, then joins back to
 *     `arrangements` and filters `cnt > (SELECT MIN(cnt) FROM order_counts)`.
 *     Confirmed by real testing that EVERY SINGLE individual order row,
 *     shifted alone (all 4 rows tried, one at a time), reproduces the
 *     IDENTICAL final result -- shifting any one row's `arrangement_id`
 *     either barely reduces its own group's count (still on the same side of
 *     MIN) or fully removes a 1-row group (whose row was already excluded by
 *     the same threshold pre-shift) -- MORE CANDIDATE ROWS, tried ONE AT A
 *     TIME, DOES NOT CLOSE THIS GAP, confirmed directly rather than assumed.
 *     The SAME mechanism was independently confirmed here (not merely
 *     assumed to generalize) for a MAX-based CTE and, less obviously, for an
 *     AVG-based CTE too: a constructed AVG example (3 groups sized 5/5/1)
 *     was hand-confirmed to reproduce the IDENTICAL qualifying-team result
 *     under EVERY ONE OF 11 individual single-row shift attempts (each
 *     lightly nudges the average without flipping who's above/below it), yet
 *     flips instantly (the whole result set changes) the moment ALL of that
 *     table's rows are shifted AT ONCE in the SAME attempt -- proving the
 *     needed perturbation for this shape is a MULTI-ROW, same-table
 *     combination, not a wider search over which single row to pick.
 *
 * THE EXTENSION: Strategy 2 now makes MANY attempts per table, run inside the
 * SAME python3 subprocess against cheap **in-memory** SQLite connections
 * (`sqlite3.connect(':memory:')`, never touching disk) instead of Strategy
 * 2's original single on-disk `mutated2.db` -- real local measurement (see
 * this fix's build report) showed an in-memory build+mutate+query cycle for
 * one of this category's realistically-sized fixtures costs ~0.3ms vs ~54ms
 * for the equivalent on-disk file, i.e. cheap enough for dozens of attempts
 * to cost low single-digit milliseconds total, nowhere close to this
 * category's 20s TIMEOUT_MS. Two KINDS of attempt are made, per table,
 * always leaving every OTHER table exactly as the untouched fixture (never
 * combined ACROSS tables -- see below for why):
 *   (1) SEPARATE, ISOLATED single-row attempts: up to SHIFT_CAP_ROWS_PER_TABLE
 *       existing rows (by ascending rowid, deterministic) are each tried in
 *       their OWN fresh in-memory database, ONE row shifted at a time, every
 *       other row in that same table left untouched. This closes SHAPE A --
 *       trying several different rows means an already-past-threshold pick
 *       is no longer the only chance taken; some other row's shift generally
 *       does cross the threshold.
 *   (2) ONE combined "shift-ALL" attempt per table: every eligible row in
 *       that table (not capped -- see SHIFT_ALL_ROWID_CAP for the generous,
 *       purely defensive upper bound) is shifted together, in a single
 *       attempt. This is the ONLY thing that closes SHAPE B, confirmed above
 *       by direct testing -- no number of ISOLATED single-row attempts
 *       reproduces the effect of moving every row in a group at once.
 * A row is judged "differed" for Strategy 2 overall if ANY attempt (of
 * either kind, across any table) that ran without error produced a result
 * that differs from the primary run's -- one successful perturbation is
 * sufficient signal, exactly like the original single-attempt Strategy 2.
 *
 * WHY SEPARATE, ISOLATED single-row attempts rather than one combined
 * multi-row shift for kind (1), and why kind (2) is still confined to ONE
 * table at a time rather than shifting several tables together: a combined
 * shift risks CANCELLING OUT into a still-identical result even when a
 * narrower, more targeted shift would have differed (confirmed directly: a
 * `MAX(x) - MIN(x)` range-style computation over a shift-ALL of every row by
 * the identical constant delta leaves the range completely unchanged, since
 * every value moves by the same amount -- a targeted single-row shift would
 * not have this exact cancellation). Isolating each attempt as narrowly as
 * the shape being tested allows (one row alone for kind 1; one table's rows
 * together, but no other table, for kind 2) keeps each attempt's signal
 * clean and diagnosable and minimizes the surface for this kind of
 * accidental cancellation, while kind (2) is still necessary because SHAPE B
 * specifically requires perturbing MULTIPLE rows of the SAME group/table
 * together to move a GROUP-level aggregate past a threshold. A NAMING- or
 * SHAPE-based heuristic to prefer shifting a "non-FK-looking" column instead
 * (skipping the FK entirely when a table has another eligible INTEGER
 * column) was considered for Shape B specifically and NOT implemented: it
 * would not have helped the florist/AVG examples above at all (their only
 * eligible non-key INTEGER column IS the FK itself -- there is no
 * alternative column to prefer), and reintroduces the exact same
 * naming-convention fragility Strategy 1's own FK carve-out already rejected
 * once (see "A NAMING-CONVENTION FK HEURISTIC WAS CONSIDERED AND REJECTED"
 * above) for no coverage benefit on the shapes actually observed.
 *
 * THE THIRD CONFIRMED PRODUCTION BUG, AND STRATEGY 2's FURTHER EXTENSION TO
 * TEXT COLUMNS (found via 30 MORE freshly-authored, genuinely correct rows
 * submitted to a real community pool after the Shape A/Shape B fix above
 * shipped: 25/30 passed, 4 wrongly flagged suspected_hardcoded -- a 5th
 * failure was a correct rejection of a genuinely bad row and is unrelated --
 * independently re-confirmed here with real sqlite3 before this fix, by
 * inspecting the actual mutated table contents, not just re-running the
 * verdict logic): every one of the 4 confirmed cases was a TEXT EQUALITY
 * filter (`WHERE department = 'engineering'`, `WHERE origin = 'ORD'`) or a
 * TEXT GROUP BY key (`GROUP BY department HAVING COUNT(*) > 2`, and the same
 * key referenced from a CTE's own scalar-subquery threshold) -- never an
 * INTEGER one. Root cause: this is STRUCTURAL, not incidental, given how
 * Strategy 1's clone works. Every TEXT column on the clone is, BY DESIGN (see
 * STRATEGY 1's own comment above), suffixed with "_mut1" on the very same
 * INSERT that creates it -- so a clone of a row that currently satisfies
 * `department = 'engineering'` gets `department = 'engineering_mut1'`, and
 * can therefore NEVER land inside a TEXT equality filter or TEXT GROUP BY key
 * it would otherwise have belonged to (confirmed directly: dumping the
 * mutated table for the first example above shows exactly this -- the clone
 * row holds `('Priya_mut1', 'engineering_mut1', 95000)`, while the two
 * genuinely matching rows, `'Priya'`/`'Wei'`, are left completely untouched).
 * The clone is invisible to exactly this query shape by construction, not by
 * bad luck, so the mutated-db query reproduces an output byte-identical to
 * the primary run and the row is wrongly flagged. This is the SAME
 * underlying class of bug as Shape A/Shape B above (a mutation mechanism
 * that, for this specific query shape, structurally cannot perturb the one
 * thing the query actually depends on) but reached through Strategy 1's
 * clone+TEXT-suffix mechanism rather than Strategy 2's old value-shift, and
 * through a TEXT filter/group-key column rather than an INTEGER
 * threshold/aggregate.
 *
 * THE FIX: Strategy 2's shift_row (already, since the Shape A/Shape B fix
 * above, run for MULTIPLE isolated rows plus one combined shift-ALL per
 * table -- see "THE EXTENSION" above) is extended to ALSO shift every
 * candidate row's non-key TEXT columns in place, in the SAME UPDATE that
 * already shifts that row's non-key INTEGER columns -- no new attempt kind,
 * no new loop, no new cap: the existing isolated-single-row and shift-ALL
 * attempt structure is reused completely unchanged, only shift_row's own
 * column-eligibility scan gained an `elif isinstance(val, str)` branch
 * alongside its existing `isinstance(val, int)` one (see shift_row's own
 * Python-side comment below). This closes the gap because an in-place
 * UPDATE, unlike Strategy 1's INSERT-a-clone, mutates a row that is
 * genuinely, ALREADY a member of whatever filter/group it belongs to --
 * shifting ITS OWN TEXT value away from a literal it currently equals, or
 * away from a GROUP BY key it currently shares with other rows, is a real,
 * well-defined perturbation of that specific row's filter/group MEMBERSHIP,
 * not a phantom clone that was never a member to begin with. All 4 confirmed
 * cases were hand-verified to flip to "ran_and_differed" under this fix: the
 * two plain `WHERE text_col = 'literal'` filters both lose exactly the
 * shifted row from their output on the FIRST isolated-row attempt (the
 * shifted row's own text_col no longer equals the literal); the `GROUP BY
 * ... HAVING COUNT(*) > 2` case loses one member from the qualifying group on
 * the FIRST isolated attempt (3 -> 2, no longer > 2, the whole group
 * disappears from the output); the CTE-scalar-subquery-threshold case needed
 * a LATER isolated attempt specifically -- shifting one of the three `'eng'`
 * rows only moves that group's count from 3 to 2, still comfortably above the
 * un-shifted `'hr'` group's count of 1, so the first three attempts (one per
 * `eng` row) do NOT differ -- but the attempt that shifts the
 * THRESHOLD-DEFINING `'hr'` row itself removes `'hr'` from the GROUP BY
 * entirely, so the scalar subquery `(SELECT cnt FROM counts WHERE department
 * = 'hr')` returns no row at all (NULL under SQL's three-valued logic), and
 * `cnt > NULL` is false for every remaining group -- the result collapses to
 * empty, a clear difference, confirmed reachable specifically BECAUSE
 * multiple isolated rows (not just the first) are already tried -- the same
 * "THE EXTENSION" machinery the prior fix built, for exactly this reason,
 * closes this gap too with zero structural changes. The combined shift-ALL
 * attempt for that same table independently reaches the identical conclusion
 * (every department value, including `'hr'`, gets renamed together, so the
 * literal `department = 'hr'` match disappears there as well) -- two
 * independent attempts confirming the same result, neither relied on alone.
 *
 * WHY NOT ALSO EXTEND TO REAL COLUMNS (a plausible, symmetric next question,
 * deliberately left OPEN rather than speculatively fixed): a REAL-column
 * equivalent of this exact gap is plausible in principle (a REAL equality
 * filter Strategy 1's clone also structurally cannot satisfy, since it too
 * shifts every clone's REAL column by MUTATION_DELTA) but was NOT observed in
 * any of the 4 confirmed production cases, and REAL equality filters are
 * inherently rare/fragile SQL in the first place (floating-point equality is
 * a well-known footgun most real schemas avoid for exactly that reason).
 * Consistent with this file's own evidence-driven pattern -- every strategy
 * extension so far was built in direct response to a REAL, hand-confirmed
 * production failure, never sped up speculatively for a shape that has not
 * actually been seen -- REAL-column shifting is deliberately left
 * unimplemented here; Strategy 1's own REAL-offset clone remains the only
 * coverage for REAL columns, unchanged, and should be revisited the same way
 * (via a real, hand-confirmed failing case) if one is ever found.
 *
 * `mutated_table_count2` keeps its original meaning (how many tables had at
 * least one eligible non-key INTEGER column for Strategy 2, across ALL
 * attempts) -- unchanged by this extension, still used for Strategy 2's
 * `applicable` gate below. What changed is only "ran"/"differed": now
 * computed across the WHOLE array of attempts (`shift_attempts` from the
 * Python driver) rather than a single mutated-database result -- see
 * `strategy2Status` below.
 *
 * COMBINED VERDICT LOGIC -- deliberately ASYMMETRIC, not "either strategy's
 * identical result is proof": a row is flagged suspected_hardcoded only when
 * Strategy 1 (which perturbs EVERY column type -- TEXT, REAL, and adds a
 * whole new row) ran cleanly and reproduced an identical result, AND
 * Strategy 2 did not differ either. Strategy 2 running clean-and-identical
 * BY ITSELF, with Strategy 1 inapplicable or erroring, is never sufficient
 * proof of hardcoding on its own and instead falls to the same inconclusive
 * bucket as a mutation-run error. This asymmetry was found necessary by real
 * testing while building this fix, not assumed up front: at the time, Strategy
 * 2 only ever perturbed INTEGER columns, so its "identical" result alone
 * proved only "this query doesn't depend on THIS row's INTEGER columns" --
 * nothing about TEXT/REAL dependence. (Strategy 2 was LATER extended to also
 * shift TEXT columns in place -- see "THE THIRD CONFIRMED PRODUCTION BUG"
 * below -- so this specific gap is narrower now, but the asymmetric rule
 * itself is left unchanged: Strategy 2 still never perturbs REAL columns, and
 * a CHECK/UNIQUE constraint that blocks Strategy 1's INSERT could still block
 * Strategy 2's own UPDATE on the same table, so Strategy-2-alone-identical is
 * still never treated as sufficient proof of hardcoding by itself.) A genuine
 * regression was caught this way during
 * testing: a table with a CHECK constraint Strategy 1's TEXT-suffix clone
 * violates (blocking Strategy 1 for that table) paired with a query whose
 * real data-dependence is entirely on that same TEXT column -- treating
 * Strategy 2's unrelated, clean, identical INTEGER-only result as sufficient
 * proof wrongly failed that genuinely correct row; before this fix existed,
 * that exact scenario was simply never checked (mutatedTableCount === 0)
 * and passed by default. The asymmetric rule restores that safety while
 * still gaining Strategy 2's benefit: EITHER strategy DIFFERING remains
 * sufficient to PASS (a real output change under any real perturbation is
 * trustworthy evidence regardless of which strategy produced it -- this is
 * the actual fix for the confirmed bug above, since it is Strategy 2, not
 * Strategy 1, that differs for both production examples); only the FAIL
 * verdict is restricted to Strategy 1's comprehensive coverage.
 *
 * A query that is genuinely computed from the data cannot produce the
 * IDENTICAL result under BOTH strategies for every realistic shape this
 * dataset targets (a filter/join/aggregation's matched set, sum, count, or
 * ordering moves when a table gains a row, or when an existing row's
 * INTEGER value moves); a hardcoded `expected_result` baked into a query
 * like `SELECT 5` or `SELECT 'Paris'` that never genuinely reads the fixture
 * reproduces the exact same answer regardless of either mutation. An
 * identical result under the combined logic above is therefore treated as a
 * real failure ("suspected hardcoded"), not a style warning -- with two
 * documented exceptions, both handled as INCONCLUSIVE rather than a pass or
 * a fail:
 *   - Mutation is skipped (no verdict either way) when NEITHER strategy
 *     found any table with a row to mutate -- every generic mutation attempt
 *     hit a UNIQUE/CHECK/NOT NULL constraint this generic, schema-blind
 *     logic cannot route around (mutatedTableCount === 0 AND
 *     mutatedTableCount2 === 0) -- see mutateDb/mutateDbShift.
 *   - A query containing DISTINCT is exempted from a "suspected hardcoded"
 *     verdict (downgraded to inconclusive) for the same reason non-PK
 *     integers are left unperturbed by Strategy 1 above: a clone whose only
 *     unperturbed column is an INTEGER one that DISTINCT dedupes on (e.g.
 *     `SELECT DISTINCT customer_id FROM orders`) is, by construction,
 *     indistinguishable from an existing row for that purpose, so an
 *     unchanged DISTINCT result proves nothing about whether the row is
 *     hardcoded. In practice Strategy 2 usually resolves this ambiguity on
 *     its own (shifting the DISTINCT-selected INTEGER or TEXT column in place
 *     produces a genuinely new value, differing the distinct set, and
 *     reaching the PASS-via-differed path above before this exemption is
 *     even needed) -- this exemption remains as the fallback for the cases
 *     it does not resolve (e.g. a CHECK constraint on that column that blocks
 *     Strategy 2's shift specifically, confirmed reachable by real testing).
 *     Detected textually (`\bDISTINCT\b`, comment/string-literal-aware)
 *     rather than perfectly -- a de-duplicating `GROUP BY` with no aggregate
 *     function in the select list has the identical ambiguity and is NOT
 *     detected/exempted here, an accepted, narrower residual.
 *   - A query that RAN CLEANLY before a mutation but ERRORS after it (a
 *     strategy that found an applicable table but never produced even one
 *     successful re-run -- see strategyStatus/strategy2Status's own "ran"
 *     field below) is treated as INCONCLUSIVE for that strategy, not as
 *     failure or as proof of anything: the mutation only
 *     adds/perturbs rows (it never changes the schema), so this should be
 *     rare, but a scalar subquery that happens to expect exactly one match
 *     is a plausible, entirely legitimate way for an otherwise-correct query
 *     to be fragile to ANY additional/altered row -- that is a fragility
 *     question about the query, not evidence that expected_result was
 *     fabricated, and the primary run against the ACTUAL given fixture
 *     already passed. Only an IDENTICAL reproduced result (under the
 *     asymmetric combined logic above) is treated as proof.
 *   - Residual, deliberately NOT exempted: a row whose sql_query genuinely
 *     computes a DATA-INDEPENDENT constant despite referencing a real table
 *     (e.g. `SELECT MAX(1) FROM orders`, or `SELECT COUNT(*) - COUNT(*)
 *     FROM orders`) will be flagged by this check as suspected-hardcoded
 *     even though it is, technically, not hardcoded -- its true behavior
 *     really is independent of the data. Distinguishing "genuinely
 *     data-independent expression" from "hardcoded" in general is a SQL
 *     semantic-analysis problem this differential/execution-based check
 *     cannot solve (the same class of residual web_scraping's own harness
 *     documents for its text-mutation check). This is treated as a
 *     dataset-authoring defect rather than a gap to special-case: a
 *     text-to-SQL benchmark row whose "correct" answer never depends on the
 *     data it's supposedly extracted from is not a meaningful example for
 *     this category, and curators should not author one.
 *   - A SEPARATE, related question the task instructions raise explicitly:
 *     should a query that references NO table at all (a pure literal
 *     computation, e.g. `SELECT 1+1`) be a valid row for this category in
 *     the first place? Decided NO, and enforced structurally below (see
 *     "must reference a real table" check) rather than exempted: such a row
 *     provides zero signal about text-to-SQL-against-real-data competency,
 *     so it is rejected up front as a real failure (a bad row for this
 *     category), before the anti-hardcoding machinery even runs, rather
 *     than silently passed through as an exemption.
 *
 * STDOUT-HIJACK / EXIT-FORGERY DEFENSES USED ELSEWHERE IN THIS REGISTRY --
 * DELIBERATELY NOT APPLIED HERE, AND WHY: several sibling harnesses
 * (serialization, log_parsing, web_scraping) write their verdict via a raw
 * `os.write(1, ...)` fd write instead of `print()`, and run contributor code
 * through PY_PRELUDE/PY_DRIVER's sys.exit()/os._exit()/raw-SystemExit trap,
 * because in THOSE categories the contributor's field is genuine Python
 * SOURCE CODE that gets `exec()`'d in the same process as the harness's own
 * verdict-serialization code -- so that code can reassign `sys.stdout`,
 * register an atexit hook, or call sys.exit() BEFORE the harness's own
 * trailing print ever runs, forging the verdict. NONE of that applies here:
 * schema_ddl, fixture_data, and sql_query are pure SQL TEXT, passed as data
 * into `conn.executescript()` / `cursor.execute()` calls inside a driver
 * script THIS harness authors in full -- there is no code path anywhere in
 * this harness where contributor-controlled text is ever `exec()`'d, or
 * otherwise becomes Python bytecode that runs in this process. SQL has no
 * syntax for reassigning `sys.stdout`, registering an `atexit` callback, or
 * calling `os._exit()`; the driver never registers a `create_function`/
 * `create_aggregate` callback either, so SQL text can only ever invoke
 * SQLite's own built-in SQL functions, never arbitrary Python. A plain
 * `sys.stdout.write(...)` for the verdict line is therefore exactly as safe
 * as `os.write(1, ...)` in this specific harness, and the PY_PRELUDE/
 * PY_DRIVER exit-forgery trap (designed to wrap arbitrary Python submission
 * code) has nothing to defend against here -- so this harness calls
 * `h.run('python3', [file], ...)` directly rather than `h.runCode('python',
 * ...)`, and does not reuse either mechanism. A per-run random marker line is
 * still used below, but purely as a parsing-robustness convention (matching
 * the rest of this registry), not a security control.
 */
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 20000;
const MUTATION_DELTA = 999983;

// ------------------------------------------------------------- SQL parsing --

/**
 * Comment- and string-literal-aware SQL stripper, used ONLY to decide
 * whether a keyword is really live SQL syntax or just text sitting inside a
 * '-- comment', a '/* block comment *\/', or a quoted string/identifier
 * literal (e.g. WHERE name = 'DROP everything') -- never used to build the
 * SQL that is actually executed (the row's own, untouched text is always
 * what runs). Quote CONTENTS are blanked to spaces; the quote characters
 * themselves are kept so a caller can still tell a quoted region was there.
 * Handles SQL's '' (doubled-quote) escape for both '...' strings and
 * "..." identifiers, plus SQLite's [...] bracket-identifier syntax.
 */
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

// Every keyword here is a real SQLite statement/pragma keyword with no
// legitimate scalar-function-call collision. "REPLACE" is deliberately
// EXCLUDED from this generic list -- SQLite's scalar string function
// REPLACE(x, y, z) is common and completely safe inside an ordinary SELECT;
// only the write-statement form "REPLACE INTO ..." is dangerous, so that
// exact phrase is checked separately below instead of banning the bare word.
const FORBIDDEN_KEYWORDS_RE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|ATTACH|DETACH|PRAGMA|CREATE|TRUNCATE|VACUUM|REINDEX|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const REPLACE_INTO_RE = /\bREPLACE\s+INTO\b/i;
const ORDER_BY_RE = /\bORDER\s+BY\b/i;

/** Gate 2 -- see the module doc comment above for why this exists. Returns
 * { ok:true, stripped } or { ok:false, reason }. */
function gateSelectOnly(sql) {
  const stripped = stripSqlNoise(sql);
  const trimmed = stripped.trim();
  if (!trimmed) return { ok: false, reason: 'sql_query is empty' };
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    return { ok: false, reason: 'sql_query must start with SELECT or WITH (a CTE prefixing a SELECT) -- read-only queries only' };
  }
  const statements = stripped.split(';').map((p) => p.trim()).filter((p) => p.length > 0);
  if (statements.length > 1) {
    return { ok: false, reason: 'sql_query contains more than one statement (stacked ;-separated statements are not allowed) -- exactly one read-only SELECT/WITH statement only' };
  }
  if (REPLACE_INTO_RE.test(stripped)) {
    return { ok: false, reason: 'sql_query contains "REPLACE INTO", a write statement -- not allowed' };
  }
  const m = stripped.match(FORBIDDEN_KEYWORDS_RE);
  if (m) {
    return { ok: false, reason: 'sql_query contains the forbidden keyword "' + m[1].toUpperCase() + '" -- only read-only SELECT/WITH queries are allowed' };
  }
  return { ok: true, stripped };
}

// Defense-in-depth only (see module doc comment) -- schema_ddl/fixture_data
// are otherwise expected to be full DDL/DML and are NOT restricted to a
// single statement.
const SETUP_FORBIDDEN_RE = /\b(ATTACH|DETACH|PRAGMA)\b/i;
function gateSetupSql(sql, fieldLabel) {
  const stripped = stripSqlNoise(sql);
  const m = stripped.match(SETUP_FORBIDDEN_RE);
  if (m) {
    return { ok: false, reason: fieldLabel + ' contains "' + m[1].toUpperCase() + '" -- ATTACH/DETACH/PRAGMA are blocked as a sandbox-hygiene measure and are never needed to define a schema or seed fixture rows' };
  }
  return { ok: true };
}

/** Every CREATE TABLE name declared in schema_ddl, quote-aware. Used only
 * for the "sql_query must reference a real table" necessary-condition check
 * below -- a flat regex scan, not a structural SQL parse (good enough: a
 * false negative here only makes that check slightly stricter, never lets
 * anything unsafe through). Recognizes double-quoted ("t"), bracketed ([t])
 * and bare (t) identifiers -- deliberately NOT backtick-quoted ones (a
 * MySQL-compatibility affordance SQLite also happens to accept): stripSqlNoise
 * above does not special-case a backtick as a quote character either, so
 * support here would be inconsistent/incomplete, and this registry's own
 * harness.js files avoid using a literal backtick as an actual syntax
 * character (only ever inside comments) since they are inlined into a
 * template literal elsewhere in the loader. */
function extractTableNames(schemaDdl) {
  const stripped = stripSqlNoise(schemaDdl);
  const re = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|\[([^\]]+)\]|(\w+))/gi;
  const names = [];
  let m;
  while ((m = re.exec(stripped))) {
    const name = m[1] || m[2] || m[3];
    if (name) names.push(name);
  }
  return names;
}

// ------------------------------------------------------------ comparison ---

/** Booleans -> 0/1 (SQLite has no boolean type; expected_result may still
 * use JSON true/false as a convenience -- see schema.json help text), and a
 * driver-side {"__blob_hex__": "..."} marker (see the Python script's
 * to_jsonable) -> a plain "blob:<hex>" string, so a BLOB cell compares like
 * any other scalar. */
function cellCanon(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v && typeof v === 'object' && typeof v.__blob_hex__ === 'string') return 'blob:' + v.__blob_hex__;
  return v;
}

/** Per-cell equality with float tolerance (SQLite REAL) and NULL handling.
 * Deliberately does NOT coerce between strings and numbers -- a TEXT column
 * holding "007" and a NUMBER 7 are genuinely different values (e.g. a
 * zip/ID code with a meaningful leading zero), not the same value spelled
 * two ways. */
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

/** Ordered-sequence comparison, used only when sql_query itself contains
 * ORDER BY (see module doc comment). */
function compareOrdered(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) if (!rowEqualOrdered(actual[i], expected[i])) return false;
  return true;
}

/** A canonical grouping key for one row -- floats rounded to 6 decimal
 * places so the multiset comparison below is tolerant of trailing float
 * noise the same way compareOrdered's cellsEqual is, while still being
 * usable as a plain Map key. */
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

/** Order-INSENSITIVE multiset comparison -- BIRD/Spider's own default mode,
 * used whenever sql_query has no ORDER BY (see module doc comment). */
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
 * Builds the PRIMARY database from schema_ddl+fixture_data and runs
 * sql_query against it; if that succeeds, independently builds a SECOND,
 * MUTATED database (same schema_ddl+fixture_data, plus mutateDb's generic
 * per-table clone-and-perturb) and runs the SAME sql_query against it too,
 * then runs Strategy 2's own (extended, multi-attempt, in-memory-only) shift
 * attempts -- see the module doc comment for why all of this happens in one
 * process/one JSON result rather than several separate harness-level h.run
 * calls. */
function buildDriverScript(schemaDdl, fixtureData, sqlQuery, primaryPath, mutatedPath, mark) {
  return [
    'import sqlite3, json, os, sys',
    '',
    'MARK = ' + pyStr(mark),
    'SCHEMA_DDL = ' + pyStr(schemaDdl),
    'FIXTURE_DATA = ' + pyStr(fixtureData),
    'SQL_QUERY = ' + pyStr(sqlQuery),
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
    '# Generic, schema-agnostic anti-hardcoding mutation -- see this file\'s',
    '# module (JS-side) doc comment for the full rationale. For every user',
    '# table that has at least one row, clone one row with every non-sole-',
    '# integer-primary-key scalar column shifted to a plainly different value',
    '# (numbers offset by MUTATION_DELTA, text suffixed) and the sole INTEGER',
    '# PRIMARY KEY column (the SQLite rowid alias) left NULL so SQLite assigns',
    '# it a fresh id. A table whose generic clone violates a UNIQUE/CHECK/',
    '# NOT NULL constraint this function does not attempt to introspect is',
    '# skipped, not crashed on; every other table is still attempted on its',
    '# own. Returns how many tables were actually mutated.',
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
    '                # Left UNCHANGED (not perturbed) -- an arbitrary integer',
    '                # shift here would land on a foreign-key column (e.g.',
    '                # orders.customer_id) just as easily as a genuine value',
    '                # column, silently breaking the very relationship a JOIN-',
    '                # category row is supposed to be exercised through: a',
    '                # cloned CHILD row whose FK is perturbed away from every',
    '                # real parent id simply disappears from an inner join\'s',
    '                # output, making a perfectly genuine join query look',
    '                # data-independent. The clone still gets a fresh PK (see',
    '                # is_sole_int_pk above) and still perturbs its TEXT/REAL',
    '                # columns below, which is enough signal for the anti-',
    '                # hardcoding check without risking an integer FK.',
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
    '# STRATEGY 2 -- VALUE-SHIFT, EXTENDED TO MULTIPLE ATTEMPTS -- see this',
    '# file\'s (JS-side) module doc comment, "THE SECOND CONFIRMED PRODUCTION',
    '# BUG..." and "THE EXTENSION..." sections, for the full rationale on why',
    '# a single first-row pick was not enough and what replaced it. Every',
    '# attempt below runs against a throwaway **in-memory** database',
    '# (sqlite3.connect(":memory:"), never touching disk) -- real local',
    '# measurement showed this costs ~0.3ms per attempt for this category\'s',
    '# realistically-sized fixtures, vs ~54ms for the equivalent on-disk file,',
    '# cheap enough for dozens of attempts to stay far under TIMEOUT_MS.',
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
    '# column PRAGMA table_info flags as part of the primary key, composite or',
    '# not, is left alone; NULL/bool runtime values are left alone -- a',
    '# runtime isinstance() check, matching mutate_db\'s own column-type',
    '# detection, deliberately NOT a declared-column-type check). INTEGER',
    '# columns are shifted by MUTATION_DELTA, same as always. TEXT columns are',
    '# suffixed with "_shift2" (distinct from mutate_db\'s own "_mut1" clone',
    '# suffix purely for debuggability -- the two never interact) -- see this',
    '# file\'s (JS-side) module doc comment, "THE THIRD CONFIRMED PRODUCTION',
    '# BUG..." section, for why this was added: mutate_db\'s CLONE also',
    '# suffixes TEXT columns, but on a brand-new INSERTed row, which means the',
    '# clone can never land INSIDE a TEXT equality filter or TEXT GROUP BY key',
    '# it would otherwise belong to -- an in-place UPDATE on an EXISTING row',
    '# has the opposite property: it genuinely moves that row OUT of whatever',
    '# TEXT-keyed filter/group it was already a member of, which is exactly',
    '# the perturbation such a query needs to prove data-dependence. A foreign',
    '# key column (INTEGER or TEXT) IS a legitimate shift target here (see',
    '# mutate_db\'s own comment for why mutate_db\'s CLONE must avoid this but',
    '# an in-place UPDATE on an EXISTING, already-referenced row does not).',
    '# REAL columns are deliberately NOT shifted here -- see the module doc',
    '# comment for why that is left as a documented, evidence-driven residual',
    '# rather than spun up speculatively. Returns True if at least one column',
    '# was actually shifted (an UPDATE ran), False if this row had no eligible',
    '# column at all -- not an error, just nothing to shift here.',
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
    '# Runs every Strategy 2 attempt -- see module doc comment for the two',
    '# KINDS (isolated single-row, and one combined shift-ALL, both always',
    '# confined to ONE table at a time, every other table left untouched) --',
    '# and returns (attempts, applicable_table_count). attempts is a list of',
    '# {"ok": True, "rows": [...]} / {"ok": False, "error": "..."} dicts; the',
    '# actual "did this attempt\'s result differ from the primary run" check is',
    '# deliberately left to the JS side (resultsEqual), the single source of',
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
    '        # other table) left exactly as the fixture.',
    '        for rowid in all_rowids[:SHIFT_CAP_ROWS_PER_TABLE]:',
    '            conn = fresh_mem_conn()',
    '            try:',
    '                # A constraint violation on THIS one row (UNIQUE/CHECK/',
    '                # NOT NULL this generic mutation cannot route around) is',
    '                # caught here, per-attempt -- exactly like mutate_db/the',
    '                # original single-attempt mutate_db_shift\'s own per-row',
    '                # try/except -- so it never aborts any OTHER attempt,',
    '                # table, or already-collected result.',
    '                try:',
    '                    shifted = shift_row(conn, table, cols, pk_positions, rowid)',
    '                except sqlite3.Error:',
    '                    shifted = False',
    '                if shifted:',
    '                    table_had_eligible = True',
    '                    conn.commit()',
    '                    try:',
    '                        attempts.append({"ok": True, "rows": run_query(conn, SQL_QUERY)})',
    '                    except Exception as e:',
    '                        attempts.append({"ok": False, "error": str(e)})',
    '            finally:',
    '                conn.close()',
    '        # Kind (2) -- ONE combined "shift-ALL" attempt: every eligible',
    '        # row of THIS table (still no other table) shifted together.',
    '        conn = fresh_mem_conn()',
    '        try:',
    '            any_shifted = False',
    '            for rowid in all_rowids:',
    '                # Same per-row constraint isolation as kind (1) above -- one',
    '                # row hitting a constraint does not abort the rest of this',
    '                # table\'s shift-ALL attempt; the other rows are still',
    '                # shifted.',
    '                try:',
    '                    if shift_row(conn, table, cols, pk_positions, rowid):',
    '                        any_shifted = True',
    '                except sqlite3.Error:',
    '                    pass',
    '            if any_shifted:',
    '                table_had_eligible = True',
    '                conn.commit()',
    '                try:',
    '                    attempts.append({"ok": True, "rows": run_query(conn, SQL_QUERY)})',
    '                except Exception as e:',
    '                    attempts.append({"ok": False, "error": str(e)})',
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
    '        result["primary_rows"] = run_query(conn1, SQL_QUERY)',
    '        result["primary_ok"] = True',
    '    except Exception as e:',
    '        result["primary_ok"] = False',
    '        result["primary_error"] = str(e)',
    '    try:',
    '        conn1.close()',
    '    except Exception:',
    '        pass',
    '',
    'if result.get("primary_ok"):',
    '    conn2 = None',
    '    try:',
    '        conn2 = build_db(MUTATED_PATH, SCHEMA_DDL, FIXTURE_DATA)',
    '        result["mutated_table_count"] = mutate_db(conn2)',
    '    except Exception as e:',
    '        result["mutated_table_count"] = 0',
    '        result["mutation_setup_error"] = str(e)',
    '    if conn2 is not None and result.get("mutated_table_count", 0) > 0:',
    '        try:',
    '            result["mutated_rows"] = run_query(conn2, SQL_QUERY)',
    '            result["mutated_ok"] = True',
    '        except Exception as e:',
    '            result["mutated_ok"] = False',
    '            result["mutated_error"] = str(e)',
    '    if conn2 is not None:',
    '        try:',
    '            conn2.close()',
    '        except Exception:',
    '            pass',
    '',
    'if result.get("primary_ok"):',
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
    '# registry is a moot concern for this specific harness (sql_query is SQL',
    '# text, never exec()\'d as Python).',
    'sys.stdout.write(MARK + json.dumps(result, default=str) + "\\n")',
    'sys.stdout.flush()',
  ].join('\n');
}

module.exports = {
  contract: 'query-result-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const schemaDdl = h.str(row, 'schema_ddl');
    const fixtureData = h.str(row, 'fixture_data');
    const sqlQuery = h.str(row, 'sql_query');
    const expectedRaw = h.str(row, 'expected_result');

    if (!taskDescription.trim() || !schemaDdl.trim() || !fixtureData.trim() || !sqlQuery.trim() || !expectedRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, schema_ddl, fixture_data, sql_query, or expected_result' } };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    // Gate 2 -- sql_query must be exactly one read-only SELECT/WITH
    // statement. See module doc comment for the full rationale.
    const gate = gateSelectOnly(sqlQuery);
    if (!gate.ok) {
      return { passed: false, logs: 'sql_query rejected before execution: ' + gate.reason, detail: { reason: 'sql_query_gate_failed', gateReason: gate.reason } };
    }

    // Defense-in-depth on the setup fields (see module doc comment) -- a
    // narrower denylist than Gate 2 since DDL/DML is of course expected here.
    const ddlGate = gateSetupSql(schemaDdl, 'schema_ddl');
    if (!ddlGate.ok) return { passed: false, logs: ddlGate.reason, detail: { reason: 'schema_ddl_gate_failed' } };
    const fixtureGate = gateSetupSql(fixtureData, 'fixture_data');
    if (!fixtureGate.ok) return { passed: false, logs: fixtureGate.reason, detail: { reason: 'fixture_data_gate_failed' } };

    // Must reference a real table declared in schema_ddl -- see module doc
    // comment for why a table-less query (a pure literal computation) is
    // rejected outright rather than exempted from the anti-hardcoding check.
    const tableNames = extractTableNames(schemaDdl);
    if (tableNames.length === 0) {
      return { passed: false, detail: { reason: 'schema_ddl declares no CREATE TABLE statements' } };
    }
    const referencesTable = tableNames.some((t) => new RegExp('\\b' + escapeRegex(t) + '\\b', 'i').test(gate.stripped));
    if (!referencesTable) {
      return {
        passed: false,
        logs: 'sql_query does not reference any table declared in schema_ddl -- a query with no real table reference is out of scope for sql_query_correctness',
        detail: { reason: 'no_table_reference', tables: tableNames },
      };
    }

    const expectedParsed = h.jsonOf(expectedRaw);
    if (!Array.isArray(expectedParsed) || !expectedParsed.every((r) => Array.isArray(r))) {
      return { passed: false, detail: { reason: 'expected_result must be a JSON array of row-arrays, e.g. [[1,"Ada"],[2,"Grace"]]' } };
    }

    const d = h.workdir();
    const primaryPath = h.path.join(d, 'primary.db');
    const mutatedPath = h.path.join(d, 'mutated.db');
    const mark = '@@SQLROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(schemaDdl, fixtureData, sqlQuery, primaryPath, mutatedPath, mark);
    const scriptPath = h.path.join(d, 'run_sql.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });
    if (r.timedOut) {
      return { passed: false, logs: 'sql_query did not complete within the time budget', detail: { reason: 'timed_out' } };
    }
    if (r.status !== 0) {
      return { passed: false, logs: String(r.stderr || '').slice(0, 1500), detail: { reason: 'driver_crashed' } };
    }

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: a genuinely
    // large result set must not have its trailing marker line truncated away
    // by the report-bounding cap applied to the returned, logged stdout.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }
    if (!out || typeof out !== 'object') {
      return { passed: false, logs: 'could not parse verification output', detail: { reason: 'unparseable_output' } };
    }

    if (!out.setup_ok) {
      return { passed: false, logs: 'schema_ddl/fixture_data failed to load: ' + String(out.setup_error || '').slice(0, 500), detail: { reason: 'setup_failed' } };
    }
    if (!out.primary_ok) {
      return { passed: false, logs: 'sql_query failed to execute against the fixture: ' + String(out.primary_error || '').slice(0, 500), detail: { reason: 'query_failed' } };
    }

    const actualRows = out.primary_rows;
    const ordered = ORDER_BY_RE.test(gate.stripped);
    const primaryMatches = resultsEqual(actualRows, expectedParsed, ordered);
    if (!primaryMatches) {
      return {
        passed: false,
        logs: 'sql_query produced ' + JSON.stringify(actualRows).slice(0, 300) + ' but expected_result is ' + JSON.stringify(expectedParsed).slice(0, 300) + (ordered ? ' (compared as an ORDERED sequence -- sql_query contains ORDER BY)' : ' (compared as an order-insensitive multiset)'),
        detail: { reason: 'result_mismatch', ordered },
      };
    }

    // Anti-hardcoding differential check -- see module doc comment. TWO
    // independent mutation strategies are combined here (Strategy 1:
    // mutate_db's row-add/clone; Strategy 2: mutate_db_shift's in-place
    // value-shift of an existing row) -- a row is only ever flagged
    // suspected_hardcoded when NEITHER strategy that actually ran produced a
    // different result, and the whole check is skipped only when NEITHER
    // strategy could mutate any table at all. See module doc comment for why
    // a single strategy was found, via real production submissions, to have
    // a systematic blind spot this combination closes.
    const mutatedTableCount = Number(out.mutated_table_count || 0);
    const mutatedTableCount2 = Number(out.mutated_table_count2 || 0);
    // See module doc comment: a DISTINCT query can legitimately fail to
    // change under a strategy whose only-ever-unperturbed column, a non-PK
    // INTEGER, is exactly what DISTINCT might be deduplicating on --
    // exempted from a hard "suspected hardcoded" verdict (downgraded to
    // inconclusive) only when NEITHER strategy showed a difference.
    const isDistinct = /\bDISTINCT\b/i.test(gate.stripped);

    // { applicable, ran, differed } for one strategy: applicable = this
    // strategy found at least one table to mutate; ran = it also completed
    // (no error) re-running sql_query against the mutated database; differed
    // = it ran AND produced a result that is NOT equal to the primary run's.
    function strategyStatus(applicableCount, ok, mutatedRows) {
      if (!(applicableCount > 0)) return { applicable: false, ran: false, differed: false };
      if (!ok) return { applicable: true, ran: false, differed: false };
      return { applicable: true, ran: true, differed: !resultsEqual(mutatedRows, actualRows, ordered) };
    }

    const s1 = strategyStatus(mutatedTableCount, out.mutated_ok, out.mutated_rows);

    // Strategy 2's own status, extended for MULTIPLE attempts (see module doc
    // comment, "THE EXTENSION" section) -- applicable keeps its original
    // per-table meaning; "ran" is true if AT LEAST ONE attempt completed
    // without error; "differed" is true if AT LEAST ONE attempt that ran
    // produced a result differing from the primary run's -- one working
    // perturbation, from any table/any attempt, is sufficient signal, the
    // same "one is enough" principle the original single-attempt design
    // already used, just now evaluated over an array instead of one result.
    function strategy2Status(applicableCount, attempts) {
      if (!(applicableCount > 0)) return { applicable: false, ran: false, differed: false };
      const ranAttempts = Array.isArray(attempts) ? attempts.filter((a) => a && a.ok === true && Array.isArray(a.rows)) : [];
      if (ranAttempts.length === 0) return { applicable: true, ran: false, differed: false };
      const differed = ranAttempts.some((a) => !resultsEqual(a.rows, actualRows, ordered));
      return { applicable: true, ran: true, differed };
    }

    const s2 = strategy2Status(mutatedTableCount2, out.shift_attempts);

    // ASYMMETRIC combination, deliberately NOT a simple "either strategy's
    // identical result is proof" rule -- see module doc comment's
    // "WHY THE FAIL VERDICT USES ONLY STRATEGY 1" section for the concrete
    // false-positive this asymmetry exists to prevent (found via real
    // testing while building this fix, not theoretical): Strategy 2 perturbs
    // INTEGER and TEXT columns (see module doc comment, "THE THIRD CONFIRMED
    // PRODUCTION BUG") but never REAL ones, so an "identical" result from
    // Strategy 2 ALONE proves only "this query doesn't depend on THIS row's
    // INTEGER/TEXT columns" -- it says nothing about REAL dependence, and
    // treating it as sufficient proof of hardcoding would wrongly fail a
    // genuinely data-dependent REAL-only query, or one on a table where a
    // CHECK/UNIQUE constraint blocks BOTH Strategy 1's clone AND Strategy 2's
    // own UPDATE the same way. A DIFFERING result, by contrast, is
    // trustworthy evidence from EITHER strategy with no such asymmetry --
    // a real output change under ANY real perturbation is proof of genuine
    // data-dependence regardless of which strategy produced it.
    let hardcodeCheck;
    if (!s1.applicable && !s2.applicable) {
      // Neither strategy found any table with a row to mutate -- see module
      // doc comment; no verdict either way.
      hardcodeCheck = 'skipped_no_mutable_table';
    } else if (s1.differed || s2.differed) {
      // One working perturbation is sufficient proof of data-dependence --
      // see module doc comment for why requiring BOTH to differ would be
      // the wrong bar (a genuinely correct query only needs ONE strategy
      // whose specific mutation shape it happens to be sensitive to). This
      // is the fix for the confirmed production bug: Strategy 1 alone
      // reproduces an IDENTICAL result for an INTEGER-threshold/aggregate
      // query (e.g. `WHERE x > (SELECT AVG(x) ...)`) because it never
      // perturbs non-PK INTEGER columns, but Strategy 2 directly shifts the
      // value such a comparison is computed over and differs instead.
      hardcodeCheck = 'ran_and_differed';
    } else if (s1.applicable && s1.ran) {
      // Strategy 1 -- the COMPREHENSIVE mutation (fresh PK, every TEXT
      // column suffixed, every REAL column shifted, a whole new row added)
      // -- ran cleanly and reproduced an IDENTICAL result, and Strategy 2
      // did not differ either: strong, comprehensive evidence of hardcoding.
      // Strategy 2 alone running clean-and-identical (Strategy 1
      // inapplicable/erroring) deliberately does NOT reach this branch --
      // see the asymmetry note above.
      if (isDistinct) {
        hardcodeCheck = 'skipped_distinct_query_ambiguous';
      } else {
        return {
          passed: false,
          logs: 'sql_query produced the IDENTICAL result before and after the fixture was mutated (one additional/altered row per table), and every supplementary value-shift attempt (isolated single-row shifts across multiple rows, plus a combined shift of every row per table) found no difference either -- this looks hardcoded/constant-folded rather than genuinely computed from schema_ddl/fixture_data',
          detail: { reason: 'suspected_hardcoded', mutatedTableCount, mutatedTableCount2 },
        };
      }
    } else {
      // Strategy 1 either errored or never found a table to mutate (and, per
      // the asymmetry above, Strategy 2 alone -- even if it ran clean and
      // identical -- is not treated as sufficient proof by itself) --
      // inconclusive, not a failure. See module doc comment for why a query
      // that ran cleanly on the primary fixture but errors on a
      // schema-identical, row-only-mutated one is not treated as proof of
      // anything either.
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
