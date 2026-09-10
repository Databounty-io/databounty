/**
 * cache-operation-sequence-match -- caching_strategy.
 *
 * THE CONTRACT: solution_code (real, contributor-controlled Python) defines
 * exactly one top-level class `Cache`, with a no-argument constructor (the
 * row's own policy numbers -- capacity, and for cache_policy "ttl" also
 * default_ttl_seconds -- are hardcoded inside it, read from
 * policy_description; the harness never passes policy_params in) and two
 * methods every cache_policy must implement -- `get(self, key, now)`
 * returning a `(hit, value)` pair, and `put(self, key, value, now,
 * ttl_seconds=None)` returning the evicted key (a string) or None -- plus a
 * THIRD method, `get_from_store(self, key)` returning a `(present, value)`
 * pair, required ONLY when cache_policy is "write_through" (see WRITE-
 * THROUGH READ SEMANTICS below). The harness instantiates Cache() ONCE per
 * row and drives it, IN ORDER, through every operation in the row's own
 * `operations` array -- get / put / advance_time / check_store -- and every
 * real outcome must match that operation's own curator-declared expected
 * outcome.
 *
 * WHY get()/get_from_store() RETURN A (hit_or_present, value) PAIR, NOT A
 * BARE VALUE: a bare `return value_or_None_for_miss` convention cannot
 * distinguish "this key is absent" from "this key is present and its
 * genuinely stored value is the JSON value null" -- a real, legitimate case
 * this category's `operations` field allows (any JSON value, including
 * null, may be put). A 2-tuple removes the sentinel ambiguity entirely, the
 * same reasoning http_api_contract_testing's own body_match modes exist to
 * avoid conflating "empty" with "absent". put() has no equivalent ambiguity
 * (it returns the EVICTED KEY, a genuinely different piece of information
 * from any user-supplied value, so a plain None-or-string return is
 * unambiguous).
 *
 * WHY solution_code NEVER RECEIVES policy_params: identical reasoning to
 * rate_limiting_policy_simulation's own module doc comment -- policy_params
 * is curator-authored ground truth the harness's own oracle trusts
 * mechanically; solution_code is expected to read policy_description
 * (natural-language prose stating the identical numbers) and hardcode its
 * own Cache accordingly. Never passing policy_params to solution_code also
 * means there is nothing for it to blindly echo back even if it wanted to.
 *
 * INDEPENDENT ORACLE -- IMPLEMENTED FOR ALL FIVE cache_policy VALUES:
 * mirroring rate_limiting_policy_simulation's now-established design
 * (itself following schema_conformance_validation's documented preference
 * for an independent-oracle design over a trust-the-curator design), this
 * harness NEVER trusts `operations`' own declared expected_result /
 * expected_value / expected_evicted_key / expected_present values as ground
 * truth on their own -- computeOracle() below independently recomputes what
 * every operation's outcome must be, from cache_policy + policy_params +
 * the operation sequence alone, entirely in this file's own plain JS,
 * BEFORE solution_code (or python3 itself) is ever touched. Any mismatch
 * between the curator's own declared outcome and the oracle's independently
 * computed one rejects the row outright as a dataset-authoring defect
 * (passed: false, reason 'oracle_mismatch') -- a curator who wrote a
 * self-consistent but WRONG operation sequence (e.g. declared cache_policy
 * "lru" with capacity 2, but hand-computed an expected_evicted_key that
 * actually describes LFU or FIFO behavior) can no longer silently fail a
 * genuinely correct Cache implementation. Like rate_limiting_policy_
 * simulation, every policy this category supports is a small, fully
 * deterministic data-structure algorithm over (key, value, now) -- no
 * external library is needed as a trusted oracle, so (matching that
 * category's own reasoning about why its oracle/contributor separation is
 * STRONGER than a second-process design, not merely equal to one) the
 * oracle lives and dies entirely inside this Node harness process; the ONLY
 * thing ever written into the one Python subprocess this category spawns is
 * solution_code's own source plus each operation's (key, value, now,
 * ttl_seconds) inputs -- every expected_* field is stripped out before the
 * Python driver script is ever built (see buildDriverScript's own
 * opsForPython, constructed by verify() below with every expected_* key
 * removed). A sys._getframe() stack-walk from inside solution_code's
 * get()/put() can reach only that ONE Python process's own frames, which
 * never held the answer at any point.
 *
 * EVICTION CORRECTNESS -- CHECKED BY AN EXPLICIT FIELD, NOT INFERRED: this
 * category's central design question is HOW eviction correctness at each
 * step is verified, not merely "was something evicted." Two options were
 * weighed: (a) infer eviction correctness purely from later get() results
 * (more realistic/black-box, since a real caller of a cache only ever
 * observes get()/put() return values -- but WEAKER signal, since a later
 * get() for the evicted key only proves *a* miss occurred, never which
 * OTHER key was kept, and a curator would have to carefully chain multiple
 * future operations to pin down the evicted key's identity indirectly); (b)
 * require every put operation to declare an explicit `expected_evicted_key`
 * (null if no eviction should occur), checked directly against solution_
 * code's own put() return value. This category takes option (b) as the
 * PRIMARY, mechanically enforced check -- the same "prefer a stronger,
 * direct check over inference" preference this registry already applied in
 * algorithmic_complexity_verification's per-size checkpointing (checking
 * behavior at every measured size directly, not just inferring a trend from
 * the endpoints) -- while STILL retaining option (a) for free as a natural
 * SECONDARY signal: nothing stops (and schema.json's own authoring guidance
 * encourages) a later `get` for a supposedly-evicted key with
 * expected_result "miss", or a `get` for a supposedly-KEPT key with its
 * still-correct expected_value, both of which the ordinary per-operation
 * comparison loop below already checks regardless. Eviction correctness in
 * this category is therefore checked BOTH ways at once: directly (via
 * expected_evicted_key on the very put that causes it) and, whenever a
 * curator chains a later get, indirectly too -- never ONLY at final state.
 *
 * WRITE-THROUGH READ SEMANTICS -- A DELIBERATE, DOCUMENTED SCOPE DECISION:
 * this category tests WRITE-through semantics (every put synchronously
 * persists to a separate, permanent backing store) -- it does NOT test
 * READ-through semantics (a related but distinct pattern where a cache MISS
 * falls back to the backing store and repopulates the cache). get() for
 * cache_policy "write_through" therefore consults ONLY the in-memory cache
 * layer, exactly like every other policy -- a key evicted from the cache
 * is a real cache MISS via get(), even though its value still lives in the
 * backing store and remains independently verifiable via a check_store
 * operation. Conflating the two would make it impossible to test write-
 * through's own defining property (the backing store surviving cache
 * eviction) in isolation; get()'s own return contract is identical across
 * every cache_policy this category supports for exactly this reason.
 * Eviction from the cache NEVER removes the corresponding backing-store
 * entry -- the backing store is the durable source of truth, only ever
 * ADDED to by put(), never pruned by eviction -- a broken submission that
 * also deletes from its own store on cache eviction is caught by a
 * check_store operation authored to run AFTER a capacity-triggered
 * eviction (see schema.json's own authoring guidance for this field).
 *
 * TTL SEMANTICS -- LAZY, PURGE-FIRST, NEVER A REAL BACKGROUND SWEEP: no
 * category in this registry may drive verification via real elapsed wall-
 * clock time (see REAL-CLOCK-INJECTION ENFORCEMENT below), which rules out
 * any active/background expiry sweep keyed to a real timer or thread. This
 * category instead pins the same LAZY-EXPIRATION convention widely used by
 * real bounded-TTL cache implementations (e.g. Python's own cachetools.
 * TTLCache): every get() AND every put() FIRST purges any entries whose
 * expiry has already passed as of the operation's own `now` value (a purge
 * pass over ALL resident entries, not merely the one key being accessed),
 * THEN proceeds with its own ordinary hit/miss or insert/update/evict
 * logic against the now-current resident set. Purging on every operation
 * (not merely on get) means a capacity-triggered eviction never displaces a
 * key that is merely OCCUPYING a slot without genuinely still being live --
 * a stale, never-since-accessed entry is reclaimed by capacity pressure
 * before a live one is ever evicted. See policy_params' own help text in
 * schema.json for the exact boundary rule (an entry at OR PAST its own
 * expiry counts as expired) and computeOracle's own ttlPurgeStale()/
 * oracleTtlStep() below for the literal reference implementation curators
 * must hand-compute against.
 *
 * REAL-CLOCK-INJECTION ENFORCEMENT -- SAME PROVEN PATTERN, REUSED VERBATIM:
 * identical rationale and identical two-layer defense as rate_limiting_
 * policy_simulation's own module doc comment (a cache whose TTL logic
 * secretly reads the real system clock instead of the `now` argument cannot
 * be verified against a virtual operation sequence at all). Applied
 * UNIFORMLY to every cache_policy in this category, not merely "ttl": (1)
 * findForbiddenClockUsage() below is copied field-for-field from that
 * category's own FORBIDDEN_CLOCK_PATTERNS/findForbiddenClockUsage, rejecting
 * solution_code outright on a static whole-source-text scan for any
 * time/datetime/calendar import, real-clock-reading call, time.sleep(), or
 * ctypes usage; (2) the Python driver's runtime clock-block replaces
 * sys.modules['time']/['datetime']/['calendar'] with a stub that raises on
 * any attribute access, installed BEFORE solution_code is ever exec()'d,
 * closing off every import mechanism (bare import, from-import,
 * importlib.import_module, __import__) uniformly regardless of how
 * solution_code phrases it. Applying this to lru/lfu/fifo/write_through too
 * (not just ttl) costs nothing -- none of those policies has any legitimate
 * reason to read real time either -- and keeps this one gate simple to
 * reason about and test rather than conditional on cache_policy.
 *
 * ANTI-HARDCODING GATES -- FOUR, EACH TARGETING A DIFFERENT TRIVIAL-STUB
 * FAILURE MODE, ENFORCED INSIDE validateOperations() BELOW: (1) not every
 * `get` operation may share one identical expected_result (a row where
 * every get expects "hit", or every get expects "miss", cannot distinguish
 * a real cache from a constant-answer stub); (2) at least one `put` must
 * declare a non-null expected_evicted_key (a row that never actually
 * exercises capacity-based eviction cannot distinguish a real BOUNDED cache
 * from an unbounded one -- and every cache_policy this category supports
 * requires a capacity, so this gate applies to all five uniformly); (3) for
 * cache_policy "ttl", at least one `advance_time` operation must appear (a
 * TTL row that never advances the virtual clock cannot distinguish real
 * expiry from a plain capacity-only cache -- the entire reason this policy
 * exists); (4) for cache_policy "write_through", at least one `check_store`
 * operation must appear (a row that never inspects the backing store cannot
 * distinguish real write-through persistence from an implementation that
 * never writes through at all). Mirrors http_api_contract_testing's own
 * validateRequests() anti-hardcoding gate and rate_limiting_policy_
 * simulation's validateTimeline() gate -- rejected as a bad ROW (dataset-
 * authoring defect), never a harness fault, never runtimeUnavailable.
 *
 * GATE ORDER: field presence -> cache_policy enum membership -> policy_params
 * shape/range validation -> operations shape/anti-hardcoding validation ->
 * INDEPENDENT ORACLE cross-check (all dataset-authoring-defect rejections,
 * none of which ever touch solution_code or the sandbox) -> solution_code's
 * own static clock-usage/structural checks -> h.have('python3') -> the one
 * Python subprocess -> per-operation outcome comparison.
 *
 * TIMEOUT BUDGET: MAX_OPERATIONS (100) plain Python method calls plus one
 * class instantiation, all pure in-process data-structure work with zero
 * I/O, zero real sleeping, and zero subprocess spawning inside the driver
 * itself -- the entire virtual timeline (however many simulated seconds
 * advance_time operations span) still runs in a handful of real
 * milliseconds. TIMEOUT_MS (10000ms) is a wide, generous multiple of the
 * realistic sub-50ms cost of that -- matching rate_limiting_policy_
 * simulation's identical sizing rationale -- and a genuine timeout at this
 * budget is itself meaningful signal (a pathological/adversarial busy-loop
 * inside get()/put()), treated as a real failure, not runtimeUnavailable.
 * Comfortably under the outer sandbox command budget (120000ms, helpers.js's
 * documented EXECUTION_RUNNER_TIMEOUT_MS) with roughly 110000ms of margin.
 */
'use strict';

const crypto = require('crypto');

const MIN_OPERATIONS = 4;
const MAX_OPERATIONS = 100;
const MAX_KEY_LEN = 200;
const TIMEOUT_MS = 10000;
const MAX_PARAM_VALUE = 1000000;

const CACHE_POLICIES = ['lru', 'lfu', 'fifo', 'ttl', 'write_through'];

// ------------------------------------------------------- policy_params ---

function positiveFiniteNumber(v, max) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : null;
}

/** Validate policy_params' shape against cache_policy. Returns { ok, reason, params }. */
function validatePolicyParams(raw, cachePolicy) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'policy_params must be valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'policy_params must be a JSON object' };
  }
  if (!Number.isInteger(parsed.capacity) || parsed.capacity < 1 || parsed.capacity > MAX_PARAM_VALUE) {
    return { ok: false, reason: 'policy_params.capacity must be a positive integer (1-' + MAX_PARAM_VALUE + ')' };
  }
  const params = { capacity: parsed.capacity };
  if (cachePolicy === 'ttl') {
    const ttl = positiveFiniteNumber(parsed.default_ttl_seconds, MAX_PARAM_VALUE);
    if (ttl == null) {
      return { ok: false, reason: 'policy_params.default_ttl_seconds must be a positive finite number (<=' + MAX_PARAM_VALUE + ') for cache_policy "ttl"' };
    }
    params.default_ttl_seconds = ttl;
  }
  return { ok: true, params };
}

// ----------------------------------------------------------- operations ---

function validKey(v) {
  return typeof v === 'string' && v.trim() && v.length <= MAX_KEY_LEN;
}

/** Validate operations' shape and the anti-hardcoding gates. Returns { ok, reason, ops }. */
function validateOperations(raw, cachePolicy) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: 'operations must be valid JSON' };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'operations must be a JSON array' };
  }
  if (parsed.length < MIN_OPERATIONS) {
    return { ok: false, reason: 'operations must contain at least ' + MIN_OPERATIONS + ' entries' };
  }
  if (parsed.length > MAX_OPERATIONS) {
    return { ok: false, reason: 'operations exceeds the maximum of ' + MAX_OPERATIONS + ' entries for this category' };
  }

  const ops = [];
  for (let i = 0; i < parsed.length; i++) {
    const o = parsed[i];
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      return { ok: false, reason: 'operations[' + i + '] must be an object' };
    }
    const kind = o.op;

    if (kind === 'get') {
      if (!validKey(o.key)) {
        return { ok: false, reason: 'operations[' + i + '].key must be a non-empty string (<=' + MAX_KEY_LEN + ' chars)' };
      }
      if (o.expected_result !== 'hit' && o.expected_result !== 'miss') {
        return { ok: false, reason: 'operations[' + i + '].expected_result must be exactly "hit" or "miss" for a get operation' };
      }
      if (o.expected_result === 'hit') {
        if (!Object.prototype.hasOwnProperty.call(o, 'expected_value')) {
          return { ok: false, reason: 'operations[' + i + '] is a get with expected_result "hit" and must include expected_value' };
        }
      } else if (Object.prototype.hasOwnProperty.call(o, 'expected_value') && o.expected_value !== null) {
        return { ok: false, reason: 'operations[' + i + '] is a get with expected_result "miss" and must not declare a non-null expected_value' };
      }
      ops.push({ index: i, op: 'get', key: o.key, expectedResult: o.expected_result, expectedValue: o.expected_result === 'hit' ? o.expected_value : null });
      continue;
    }

    if (kind === 'put') {
      if (!validKey(o.key)) {
        return { ok: false, reason: 'operations[' + i + '].key must be a non-empty string (<=' + MAX_KEY_LEN + ' chars)' };
      }
      if (!Object.prototype.hasOwnProperty.call(o, 'value')) {
        return { ok: false, reason: 'operations[' + i + '] is a put and must include a value' };
      }
      if (!Object.prototype.hasOwnProperty.call(o, 'expected_evicted_key')) {
        return { ok: false, reason: 'operations[' + i + '] is a put and must include expected_evicted_key (a string, or null if this put must not evict anything)' };
      }
      if (o.expected_evicted_key !== null && typeof o.expected_evicted_key !== 'string') {
        return { ok: false, reason: 'operations[' + i + '].expected_evicted_key must be a string or null' };
      }
      let ttlSeconds = null;
      if (Object.prototype.hasOwnProperty.call(o, 'ttl_seconds') && o.ttl_seconds !== null) {
        if (cachePolicy !== 'ttl') {
          return { ok: false, reason: 'operations[' + i + '].ttl_seconds is only meaningful when cache_policy is "ttl"' };
        }
        if (typeof o.ttl_seconds !== 'number' || !Number.isFinite(o.ttl_seconds) || o.ttl_seconds <= 0) {
          return { ok: false, reason: 'operations[' + i + '].ttl_seconds must be a positive finite number when present' };
        }
        ttlSeconds = o.ttl_seconds;
      }
      ops.push({ index: i, op: 'put', key: o.key, value: o.value, ttlSeconds: ttlSeconds, expectedEvictedKey: o.expected_evicted_key });
      continue;
    }

    if (kind === 'advance_time') {
      if (cachePolicy !== 'ttl') {
        return { ok: false, reason: 'operations[' + i + '] is an advance_time operation, only valid when cache_policy is "ttl"' };
      }
      if (typeof o.seconds !== 'number' || !Number.isFinite(o.seconds) || o.seconds <= 0) {
        return { ok: false, reason: 'operations[' + i + '].seconds must be a positive finite number' };
      }
      ops.push({ index: i, op: 'advance_time', seconds: o.seconds });
      continue;
    }

    if (kind === 'check_store') {
      if (cachePolicy !== 'write_through') {
        return { ok: false, reason: 'operations[' + i + '] is a check_store operation, only valid when cache_policy is "write_through"' };
      }
      if (!validKey(o.key)) {
        return { ok: false, reason: 'operations[' + i + '].key must be a non-empty string (<=' + MAX_KEY_LEN + ' chars)' };
      }
      if (typeof o.expected_present !== 'boolean') {
        return { ok: false, reason: 'operations[' + i + '].expected_present must be a boolean for a check_store operation' };
      }
      if (o.expected_present) {
        if (!Object.prototype.hasOwnProperty.call(o, 'expected_value')) {
          return { ok: false, reason: 'operations[' + i + '] is a check_store with expected_present true and must include expected_value' };
        }
      } else if (Object.prototype.hasOwnProperty.call(o, 'expected_value') && o.expected_value !== null) {
        return { ok: false, reason: 'operations[' + i + '] is a check_store with expected_present false and must not declare a non-null expected_value' };
      }
      ops.push({ index: i, op: 'check_store', key: o.key, expectedPresent: o.expected_present, expectedValue: o.expected_present ? o.expected_value : null });
      continue;
    }

    return { ok: false, reason: 'operations[' + i + '].op must be one of "get", "put", "advance_time", "check_store"' };
  }

  // ANTI-HARDCODING GATE 1 -- see module doc comment.
  const gets = ops.filter((o) => o.op === 'get');
  if (gets.length > 0 && gets.every((g) => g.expectedResult === gets[0].expectedResult)) {
    return {
      ok: false,
      reason: 'operations must include at least one get whose expected_result genuinely differs from another -- a row where every get expects the identical outcome ("' + gets[0].expectedResult + '") cannot distinguish a real cache from a stub that always returns one fixed answer',
    };
  }
  // ANTI-HARDCODING GATE 2 -- see module doc comment.
  const puts = ops.filter((o) => o.op === 'put');
  if (!puts.some((p) => p.expectedEvictedKey !== null)) {
    return {
      ok: false,
      reason: 'operations must include at least one put whose expected_evicted_key is non-null -- a row that never actually exercises capacity-based eviction cannot distinguish a real bounded cache from one that never evicts at all',
    };
  }
  // ANTI-HARDCODING GATE 3 -- see module doc comment.
  if (cachePolicy === 'ttl' && !ops.some((o) => o.op === 'advance_time')) {
    return {
      ok: false,
      reason: 'operations must include at least one advance_time operation for cache_policy "ttl" -- a row that never advances the virtual clock cannot distinguish real TTL expiry from a plain capacity-only cache',
    };
  }
  // ANTI-HARDCODING GATE 4 -- see module doc comment.
  if (cachePolicy === 'write_through' && !ops.some((o) => o.op === 'check_store')) {
    return {
      ok: false,
      reason: 'operations must include at least one check_store operation for cache_policy "write_through" -- a row that never inspects the backing store cannot distinguish real write-through persistence from an implementation that never writes through at all',
    };
  }

  return { ok: true, ops: ops };
}

// --------------------------------------------------- independent oracle ---
// See module doc comment (INDEPENDENT ORACLE) -- one pure, deterministic
// reference step function per cache_policy, run entirely in this Node
// process, operating on curator-authored policy_params alone. Never sees
// solution_code; never runs in Python.

/** Numeric-tolerant, key-order-insensitive (objects) / index-ordered
 * (arrays) structural equality -- ported from http_api_contract_testing's
 * own deepEqualTolerant (itself ported from redis_data_structure_
 * semantics): a cached value is data of the same shape, and array order is
 * frequently meaningful while object key order never is. */
function deepEqualTolerant(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) || Number.isNaN(b)) return false;
    const diff = Math.abs(a - b);
    return diff < 1e-6 || diff <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqualTolerant(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) if (ak[i] !== bk[i]) return false;
    for (const k of ak) if (!deepEqualTolerant(a[k], b[k])) return false;
    return true;
  }
  return a === b;
}

function lruTouch(state, key) {
  state.seq += 1;
  const e = state.entries.get(key);
  if (e) e.useSeq = state.seq;
}

function lruEvictCandidate(state) {
  let evictKey = null;
  let evictSeq = Infinity;
  for (const pair of state.entries) {
    const k = pair[0];
    const v = pair[1];
    if (v.useSeq < evictSeq) { evictSeq = v.useSeq; evictKey = k; }
  }
  return evictKey;
}

function oracleLruStep(params, state, op) {
  if (op.op === 'get') {
    const e = state.entries.get(op.key);
    if (!e) return { hit: false, value: null };
    lruTouch(state, op.key);
    return { hit: true, value: e.value };
  }
  // put
  const existing = state.entries.get(op.key);
  state.seq += 1;
  if (existing) {
    existing.value = op.value;
    existing.useSeq = state.seq;
    return { evictedKey: null };
  }
  let evictedKey = null;
  if (state.entries.size >= params.capacity) {
    evictedKey = lruEvictCandidate(state);
    state.entries.delete(evictedKey);
  }
  state.entries.set(op.key, { value: op.value, useSeq: state.seq });
  return { evictedKey: evictedKey };
}

function lfuEvictCandidate(state) {
  let evictKey = null;
  let evictFreq = Infinity;
  let evictSeq = Infinity;
  for (const pair of state.entries) {
    const k = pair[0];
    const v = pair[1];
    if (v.freq < evictFreq || (v.freq === evictFreq && v.useSeq < evictSeq)) {
      evictFreq = v.freq; evictSeq = v.useSeq; evictKey = k;
    }
  }
  return evictKey;
}

function oracleLfuStep(params, state, op) {
  if (op.op === 'get') {
    const e = state.entries.get(op.key);
    if (!e) return { hit: false, value: null };
    state.seq += 1;
    e.freq += 1;
    e.useSeq = state.seq;
    return { hit: true, value: e.value };
  }
  // put
  const existing = state.entries.get(op.key);
  state.seq += 1;
  if (existing) {
    existing.value = op.value;
    existing.freq += 1;
    existing.useSeq = state.seq;
    return { evictedKey: null };
  }
  let evictedKey = null;
  if (state.entries.size >= params.capacity) {
    evictedKey = lfuEvictCandidate(state);
    state.entries.delete(evictedKey);
  }
  state.entries.set(op.key, { value: op.value, freq: 1, useSeq: state.seq });
  return { evictedKey: evictedKey };
}

function fifoEvictCandidate(state) {
  let evictKey = null;
  let evictSeq = Infinity;
  for (const pair of state.entries) {
    const k = pair[0];
    const v = pair[1];
    if (v.insertSeq < evictSeq) { evictSeq = v.insertSeq; evictKey = k; }
  }
  return evictKey;
}

function oracleFifoStep(params, state, op) {
  if (op.op === 'get') {
    const e = state.entries.get(op.key);
    return e ? { hit: true, value: e.value } : { hit: false, value: null };
  }
  // put -- FIFO order is set ONCE at first insertion and never touched by a
  // later get or an update-put to the same key (see module doc comment).
  const existing = state.entries.get(op.key);
  if (existing) {
    existing.value = op.value;
    return { evictedKey: null };
  }
  let evictedKey = null;
  if (state.entries.size >= params.capacity) {
    evictedKey = fifoEvictCandidate(state);
    state.entries.delete(evictedKey);
  }
  state.seq += 1;
  state.entries.set(op.key, { value: op.value, insertSeq: state.seq });
  return { evictedKey: evictedKey };
}

/** Purge every entry whose expiry has already passed as of `now` -- called
 * BEFORE every get/put, not only on put. See module doc comment (TTL
 * SEMANTICS). An entry AT OR PAST its own expiry (expiresAt <= now) counts
 * as expired -- the same half-open-interval convention rate_limiting_
 * policy_simulation's sliding_window_log oracle already documents ("an
 * entry EXACTLY window_seconds old has already fully expired"). */
function ttlPurgeStale(state, now) {
  for (const pair of Array.from(state.entries)) {
    if (pair[1].expiresAt <= now) state.entries.delete(pair[0]);
  }
}

function oracleTtlStep(params, state, op, now) {
  ttlPurgeStale(state, now);
  if (op.op === 'get') {
    const e = state.entries.get(op.key);
    if (!e) return { hit: false, value: null };
    lruTouch(state, op.key);
    return { hit: true, value: e.value };
  }
  // put
  const existing = state.entries.get(op.key);
  state.seq += 1;
  const ttl = op.ttlSeconds != null ? op.ttlSeconds : params.default_ttl_seconds;
  if (existing) {
    existing.value = op.value;
    existing.expiresAt = now + ttl;
    existing.useSeq = state.seq;
    return { evictedKey: null };
  }
  let evictedKey = null;
  if (state.entries.size >= params.capacity) {
    evictedKey = lruEvictCandidate(state);
    state.entries.delete(evictedKey);
  }
  state.entries.set(op.key, { value: op.value, expiresAt: now + ttl, useSeq: state.seq });
  return { evictedKey: evictedKey };
}

function oracleWriteThroughStep(params, state, op) {
  if (op.op === 'check_store') {
    const present = state.store.has(op.key);
    return { present: present, value: present ? state.store.get(op.key) : null };
  }
  if (op.op === 'get') {
    // WRITE-THROUGH READ SEMANTICS -- see module doc comment: get() consults
    // ONLY the cache layer, never the backing store.
    const e = state.entries.get(op.key);
    if (!e) return { hit: false, value: null };
    lruTouch(state, op.key);
    return { hit: true, value: e.value };
  }
  // put -- ALWAYS writes through to the backing store, regardless of
  // eviction/insert/update, and eviction from the cache NEVER prunes the
  // store (see module doc comment).
  const existing = state.entries.get(op.key);
  state.seq += 1;
  state.store.set(op.key, op.value);
  if (existing) {
    existing.value = op.value;
    existing.useSeq = state.seq;
    return { evictedKey: null };
  }
  let evictedKey = null;
  if (state.entries.size >= params.capacity) {
    evictedKey = lruEvictCandidate(state);
    state.entries.delete(evictedKey);
  }
  state.entries.set(op.key, { value: op.value, useSeq: state.seq });
  return { evictedKey: evictedKey };
}

const ORACLE_STEPS = {
  lru: oracleLruStep,
  lfu: oracleLfuStep,
  fifo: oracleFifoStep,
  ttl: oracleTtlStep,
  write_through: oracleWriteThroughStep,
};

/** Runs the reference oracle for cachePolicy across every operation, IN
 * ORDER, over a single shared cache instance (mirroring solution_code's own
 * single Cache() instance driven through the whole sequence) -- returns an
 * array of outcome objects, index-aligned with `ops`. */
function computeOracle(cachePolicy, params, ops) {
  const state = { entries: new Map(), seq: 0, store: cachePolicy === 'write_through' ? new Map() : null };
  const step = ORACLE_STEPS[cachePolicy];
  let now = 0;
  const out = [];
  for (const op of ops) {
    if (op.op === 'advance_time') {
      now += op.seconds;
      out.push({});
      continue;
    }
    out.push(step(params, state, op, now));
  }
  return out;
}

/** Cross-check every operation's own declared expected_* fields against the
 * independent oracle's computed outcome. Returns { ok, index, reason }. */
function crossCheckOracle(cachePolicy, params, ops) {
  const results = computeOracle(cachePolicy, params, ops);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const r = results[i];
    if (op.op === 'get') {
      const oracleHit = !!r.hit;
      const declaredHit = op.expectedResult === 'hit';
      if (oracleHit !== declaredHit) {
        return {
          ok: false, index: i,
          reason: 'operations[' + i + '] declares expected_result="' + op.expectedResult + '" but this row\'s own cache_policy ("' + cachePolicy + '") + policy_params independently compute "' + (oracleHit ? 'hit' : 'miss') + '" for get(' + JSON.stringify(op.key) + ')',
        };
      }
      if (oracleHit && !deepEqualTolerant(r.value, op.expectedValue)) {
        return {
          ok: false, index: i,
          reason: 'operations[' + i + '] declares expected_value=' + JSON.stringify(op.expectedValue) + ' but the independently computed value for get(' + JSON.stringify(op.key) + ') is ' + JSON.stringify(r.value),
        };
      }
    } else if (op.op === 'put') {
      const oracleEvicted = r.evictedKey === undefined ? null : r.evictedKey;
      if (oracleEvicted !== op.expectedEvictedKey) {
        return {
          ok: false, index: i,
          reason: 'operations[' + i + '] declares expected_evicted_key=' + JSON.stringify(op.expectedEvictedKey) + ' but this row\'s own cache_policy ("' + cachePolicy + '") + policy_params independently compute evicted_key=' + JSON.stringify(oracleEvicted) + ' for put(' + JSON.stringify(op.key) + ')',
        };
      }
    } else if (op.op === 'check_store') {
      const oraclePresent = !!r.present;
      if (oraclePresent !== op.expectedPresent) {
        return {
          ok: false, index: i,
          reason: 'operations[' + i + '] declares expected_present=' + JSON.stringify(op.expectedPresent) + ' but the independently computed backing-store state for key ' + JSON.stringify(op.key) + ' is present=' + oraclePresent,
        };
      }
      if (oraclePresent && !deepEqualTolerant(r.value, op.expectedValue)) {
        return {
          ok: false, index: i,
          reason: 'operations[' + i + '] declares expected_value=' + JSON.stringify(op.expectedValue) + ' but the independently computed backing-store value for key ' + JSON.stringify(op.key) + ' is ' + JSON.stringify(r.value),
        };
      }
    }
    // advance_time: nothing to cross-check.
  }
  return { ok: true };
}

// --------------------------------------------- clock-injection gate 1 ---
// Static, pre-execution -- reused verbatim from rate_limiting_policy_
// simulation's own FORBIDDEN_CLOCK_PATTERNS/findForbiddenClockUsage. See
// module doc comment (REAL-CLOCK-INJECTION ENFORCEMENT). Deliberately a
// plain substring/regex scan of the WHOLE source text, including comments/
// docstrings -- the safe failure mode here is an over-cautious reject,
// never a bypass, matching this registry's stated design preference.
const FORBIDDEN_CLOCK_PATTERNS = [
  { re: /\bimport\s+time\b/, reason: 'imports the "time" module' },
  { re: /\bfrom\s+time\s+import\b/, reason: 'imports from the "time" module' },
  { re: /\bimport\s+datetime\b/, reason: 'imports the "datetime" module' },
  { re: /\bfrom\s+datetime\s+import\b/, reason: 'imports from the "datetime" module' },
  { re: /\bimport\s+calendar\b/, reason: 'imports the "calendar" module' },
  { re: /\btime\s*\.\s*time\s*\(/, reason: 'calls time.time()' },
  { re: /\btime\s*\.\s*time_ns\s*\(/, reason: 'calls time.time_ns()' },
  { re: /\btime\s*\.\s*monotonic\s*\(/, reason: 'calls time.monotonic()' },
  { re: /\btime\s*\.\s*monotonic_ns\s*\(/, reason: 'calls time.monotonic_ns()' },
  { re: /\btime\s*\.\s*perf_counter\s*\(/, reason: 'calls time.perf_counter()' },
  { re: /\btime\s*\.\s*sleep\s*\(/, reason: 'calls time.sleep() -- this category never uses real sleeping; every "second" is a plain number passed to get()/put() as the `now` argument' },
  { re: /\bdatetime\s*\.\s*now\s*\(/, reason: 'calls datetime.now()' },
  { re: /\butcnow\s*\(/, reason: 'calls .utcnow()' },
  { re: /\bdatetime\s*\.\s*today\s*\(/, reason: 'calls datetime.today()' },
  { re: /\bdate\s*\.\s*today\s*\(/, reason: 'calls date.today()' },
  { re: /\bos\s*\.\s*times\s*\(/, reason: 'calls os.times() (a real elapsed-time source)' },
  { re: /\bctypes\b/, reason: 'uses ctypes -- a documented raw-syscall clock-access escape hatch, banned outright for this category' },
];

function findForbiddenClockUsage(code) {
  for (const p of FORBIDDEN_CLOCK_PATTERNS) {
    if (p.re.test(code)) return p.reason;
  }
  return null;
}

function pyStr(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

/**
 * The Python driver -- see module doc comment (INDEPENDENT ORACLE,
 * REAL-CLOCK-INJECTION ENFORCEMENT layer 2). opsForPython carries ONLY the
 * inputs a real caller would supply (op/key/value/seconds/ttl_seconds) --
 * every expected_* field is stripped by the caller (verify() below) before
 * this function is ever invoked.
 */
function buildDriverScript(pyPrelude, solutionCode, opsForPython, cachePolicy, mark) {
  return [
    'import sys, os, json',
    '',
    pyPrelude,
    '',
    'def _main():',
    '    MARK = ' + pyStr(mark),
    '    SOLUTION_SRC = ' + pyStr(solutionCode),
    '    CACHE_POLICY = ' + pyStr(cachePolicy),
    '    OPS = json.loads(' + pyStr(JSON.stringify(opsForPython)) + ')',
    '    _real_write = os.write',
    '    result = {"stage": "started"}',
    '',
    '    def _emit():',
    '        _real_write(1, (MARK + json.dumps(result, default=str) + "\\n").encode("utf-8", "replace"))',
    '',
    '    # RUNTIME CLOCK-BLOCK -- gate 2 of the REAL-CLOCK-INJECTION',
    '    # ENFORCEMENT (see harness.js module doc comment). Installed BEFORE',
    '    # solution_code is ever exec\'d: CPython\'s import machinery always',
    '    # consults sys.modules first, for every import mechanism alike, so',
    '    # replacing these three entries here closes off bare `import X`,',
    '    # `from X import Y`, `importlib.import_module("X")`, and',
    '    # `__import__("X")` uniformly, regardless of which one',
    '    # solution_code uses.',
    '    class _BlockedClockModule(object):',
    '        def __init__(self, name):',
    '            self._name = name',
    '        def __getattr__(self, attr):',
    '            raise RuntimeError(',
    '                "solution_code attempted to access the real system clock via " +',
    '                self._name + "." + attr + "() -- forbidden for this category: " +',
    '                "Cache.get/put must decide behavior using ONLY the `now` argument " +',
    '                "the harness passes in, never a real wall-clock/monotonic read."',
    '            )',
    '    sys.modules["time"] = _BlockedClockModule("time")',
    '    sys.modules["datetime"] = _BlockedClockModule("datetime")',
    '    sys.modules["calendar"] = _BlockedClockModule("calendar")',
    '',
    '    try:',
    '        ns = {}',
    '        exec(compile(SOLUTION_SRC, "<solution_code>", "exec"), ns)',
    '    except BaseException as e:',
    '        result["stage"] = "load_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    cls = ns.get("Cache")',
    '    if not isinstance(cls, type):',
    '        result["stage"] = "no_cache_class"',
    '        _emit(); return',
    '',
    '    try:',
    '        cache = cls()',
    '    except BaseException as e:',
    '        result["stage"] = "init_failed"',
    '        result["error"] = repr(e)',
    '        _emit(); return',
    '',
    '    get_fn = getattr(cache, "get", None)',
    '    put_fn = getattr(cache, "put", None)',
    '    if not callable(get_fn):',
    '        result["stage"] = "no_get_method"',
    '        _emit(); return',
    '    if not callable(put_fn):',
    '        result["stage"] = "no_put_method"',
    '        _emit(); return',
    '    store_fn = None',
    '    if CACHE_POLICY == "write_through":',
    '        store_fn = getattr(cache, "get_from_store", None)',
    '        if not callable(store_fn):',
    '            result["stage"] = "no_get_from_store_method"',
    '            _emit(); return',
    '',
    '    now = 0',
    '    outcomes = []',
    '    result["stage"] = "in_progress"',
    '    result["outcomes"] = outcomes',
    '    for i, op in enumerate(OPS):',
    '        kind = op["op"]',
    '        entry = {"index": i, "op": kind}',
    '        try:',
    '            if kind == "advance_time":',
    '                now = now + op["seconds"]',
    '                entry["ok"] = True',
    '            elif kind == "get":',
    '                r = get_fn(op["key"], now)',
    '                hit, value = r[0], r[1]',
    '                entry["ok"] = True',
    '                entry["hit"] = bool(hit)',
    '                entry["value"] = value if hit else None',
    '            elif kind == "put":',
    '                ttl = op.get("ttl_seconds")',
    '                ev = put_fn(op["key"], op["value"], now, ttl_seconds=ttl)',
    '                if ev is not None and not isinstance(ev, str):',
    '                    raise TypeError("put() must return None or a string evicted key, got %r" % (ev,))',
    '                entry["ok"] = True',
    '                entry["evicted_key"] = ev',
    '            elif kind == "check_store":',
    '                r = store_fn(op["key"])',
    '                present, value = r[0], r[1]',
    '                entry["ok"] = True',
    '                entry["present"] = bool(present)',
    '                entry["value"] = value if present else None',
    '            else:',
    '                entry["ok"] = False',
    '                entry["error"] = "unrecognized op %r" % (kind,)',
    '        except BaseException as e:',
    '            entry["ok"] = False',
    '            entry["error"] = repr(e)',
    '        outcomes.append(entry)',
    '        _emit()  # checkpoint after EVERY operation -- see module doc',
    '                 # comment (TIMEOUT BUDGET) and algorithmic_complexity_',
    '                 # verification\'s own INCREMENTAL-CHECKPOINT precedent:',
    '                 # a hang inside one get()/put() call still leaves every',
    '                 # prior outcome readable.',
    '',
    '    result["stage"] = "ok"',
    '    _emit()',
    '',
    '_main()',
  ].join('\n');
}

module.exports = {
  contract: 'cache-operation-sequence-match',
  requires: ['python3'],

  verify(row, h) {
    const taskDescription = h.str(row, 'task_description');
    const cachePolicy = h.str(row, 'cache_policy').trim();
    const policyDescription = h.str(row, 'policy_description');
    const policyParamsRaw = h.str(row, 'policy_params');
    const solutionCode = h.str(row, 'solution_code');
    const operationsRaw = h.str(row, 'operations');

    if (!taskDescription.trim() || !cachePolicy || !policyDescription.trim() || !policyParamsRaw.trim() || !solutionCode.trim() || !operationsRaw.trim()) {
      return { passed: false, detail: { reason: 'missing task_description, cache_policy, policy_description, policy_params, solution_code, or operations' } };
    }

    if (!CACHE_POLICIES.includes(cachePolicy)) {
      return {
        passed: false,
        logs: 'cache_policy "' + cachePolicy + '" is not one of the recognized values: ' + CACHE_POLICIES.join(', '),
        detail: { reason: 'unrecognized_cache_policy' },
      };
    }

    const paramsCheck = validatePolicyParams(policyParamsRaw, cachePolicy);
    if (!paramsCheck.ok) {
      return { passed: false, logs: paramsCheck.reason, detail: { reason: 'bad_policy_params' } };
    }
    const params = paramsCheck.params;

    const opsCheck = validateOperations(operationsRaw, cachePolicy);
    if (!opsCheck.ok) {
      return { passed: false, logs: opsCheck.reason, detail: { reason: 'bad_operations' } };
    }
    const ops = opsCheck.ops;

    // INDEPENDENT ORACLE CROSS-CHECK -- see module doc comment. Runs
    // entirely in this Node process, before solution_code (or python3's
    // own availability) is ever considered.
    const oracleCheck = crossCheckOracle(cachePolicy, params, ops);
    if (!oracleCheck.ok) {
      return {
        passed: false,
        logs: oracleCheck.reason + ' -- dataset-authoring defect (operations does not actually match its own declared cache_policy/policy_params), rejected before solution_code is ever run',
        detail: { reason: 'oracle_mismatch', index: oracleCheck.index },
      };
    }

    // solution_code's own static clock-usage gate -- see module doc comment
    // (REAL-CLOCK-INJECTION ENFORCEMENT, layer 1).
    const forbidden = findForbiddenClockUsage(solutionCode);
    if (forbidden) {
      return {
        passed: false,
        logs: 'solution_code ' + forbidden + ' -- forbidden for this category: Cache.get/put must decide behavior using ONLY the `now` argument, never a real clock read or a real sleep',
        detail: { reason: 'forbidden_clock_usage', matched: forbidden },
      };
    }
    if (!/^\s*class\s+Cache\b/m.test(solutionCode)) {
      return { passed: false, logs: 'solution_code must define a top-level class named exactly Cache', detail: { reason: 'no_cache_class' } };
    }
    if (!/\bdef\s+get\s*\(/.test(solutionCode)) {
      return { passed: false, logs: 'solution_code\'s Cache class must define a method named exactly get (e.g. def get(self, key, now):)', detail: { reason: 'no_get_method' } };
    }
    if (!/\bdef\s+put\s*\(/.test(solutionCode)) {
      return { passed: false, logs: 'solution_code\'s Cache class must define a method named exactly put (e.g. def put(self, key, value, now, ttl_seconds=None):)', detail: { reason: 'no_put_method' } };
    }
    if (cachePolicy === 'write_through' && !/\bdef\s+get_from_store\s*\(/.test(solutionCode)) {
      return { passed: false, logs: 'solution_code\'s Cache class must define a method named exactly get_from_store (e.g. def get_from_store(self, key):) for cache_policy "write_through"', detail: { reason: 'no_get_from_store_method' } };
    }

    if (!h.have('python3')) {
      return { passed: false, runtimeUnavailable: true, logs: 'python3 not available in sandbox', detail: { reason: 'no_python3' } };
    }

    // opsForPython carries ONLY the inputs a real caller would supply --
    // every expected_* field is deliberately never included. See module doc
    // comment.
    const opsForPython = ops.map((o) => {
      if (o.op === 'get') return { op: 'get', key: o.key };
      if (o.op === 'put') return { op: 'put', key: o.key, value: o.value, ttl_seconds: o.ttlSeconds };
      if (o.op === 'advance_time') return { op: 'advance_time', seconds: o.seconds };
      return { op: 'check_store', key: o.key };
    });

    const d = h.workdir();
    const mark = '@@CACHEROW_' + crypto.randomBytes(12).toString('hex') + '_';
    const script = buildDriverScript(h.PY_PRELUDE, solutionCode, opsForPython, cachePolicy, mark);
    const scriptPath = h.path.join(d, 'run_cache.py');
    h.fs.writeFileSync(scriptPath, script);

    const r = h.run('python3', [scriptPath], { cwd: d, timeoutMs: TIMEOUT_MS });

    // rawStdout (uncapped) -- see helpers.js's OUT_CAP comment: up to
    // MAX_OPERATIONS checkpoint lines, each potentially carrying an
    // arbitrary cached JSON value, could exceed the report-bounding cap
    // before the trailing "ok" marker line is reached.
    const marked = h.lastMarked(r.rawStdout != null ? r.rawStdout : r.stdout, mark);
    let out = null;
    try { out = marked === null ? null : JSON.parse(marked); } catch (e) { out = null; }

    if (!out || typeof out !== 'object' || !out.stage) {
      return {
        passed: false,
        logs: r.timedOut
          ? ('solution_code did not complete its get()/put() calls within the ' + TIMEOUT_MS + 'ms budget -- for work this small (a plain loop over ' + ops.length + ' operations), this is itself a real failure, not an infra problem')
          : ('could not parse verification output: ' + String(r.stderr || '').slice(0, 500)),
        detail: { reason: 'unparseable_output', timedOut: !!r.timedOut },
      };
    }

    if (out.stage === 'load_failed') {
      return { passed: false, logs: 'solution_code failed to load: ' + String(out.error || '').slice(0, 800), detail: { reason: 'load_failed' } };
    }
    if (out.stage === 'no_cache_class') {
      return { passed: false, logs: 'solution_code does not define a top-level Cache class after exec', detail: { reason: 'no_cache_class' } };
    }
    if (out.stage === 'init_failed') {
      return { passed: false, logs: 'Cache() raised during construction: ' + String(out.error || '').slice(0, 800), detail: { reason: 'init_failed' } };
    }
    if (out.stage === 'no_get_method') {
      return { passed: false, logs: 'Cache instance has no callable get method', detail: { reason: 'no_get_method' } };
    }
    if (out.stage === 'no_put_method') {
      return { passed: false, logs: 'Cache instance has no callable put method', detail: { reason: 'no_put_method' } };
    }
    if (out.stage === 'no_get_from_store_method') {
      return { passed: false, logs: 'Cache instance has no callable get_from_store method (required for cache_policy "write_through")', detail: { reason: 'no_get_from_store_method' } };
    }

    const outcomes = Array.isArray(out.outcomes) ? out.outcomes : [];
    if (outcomes.length < ops.length) {
      return {
        passed: false,
        logs: 'get()/put() calls did not complete for the whole operation sequence (reached ' + outcomes.length + ' of ' + ops.length + ' operations within the ' + TIMEOUT_MS + 'ms budget)',
        detail: { reason: 'sequence_incomplete', completed: outcomes.length, total: ops.length },
      };
    }

    const mismatches = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      const oc = outcomes[i] || {};
      if (oc.ok !== true) {
        mismatches.push({ index: i, reason: 'operations[' + i + '] (' + op.op + ') raised: ' + String(oc.error || '').slice(0, 300) });
        continue;
      }
      if (op.op === 'get') {
        const actualHit = !!oc.hit;
        const expectedHit = op.expectedResult === 'hit';
        if (actualHit !== expectedHit) {
          mismatches.push({ index: i, reason: 'expected get(' + JSON.stringify(op.key) + ') to ' + (expectedHit ? 'hit' : 'miss') + ', but Cache.get returned ' + (actualHit ? 'hit' : 'miss') });
          continue;
        }
        if (actualHit && !deepEqualTolerant(oc.value, op.expectedValue)) {
          mismatches.push({ index: i, reason: 'get(' + JSON.stringify(op.key) + ') hit but returned value ' + JSON.stringify(oc.value) + ', expected ' + JSON.stringify(op.expectedValue) });
        }
      } else if (op.op === 'put') {
        const actualEvicted = oc.evicted_key === undefined ? null : oc.evicted_key;
        if (actualEvicted !== op.expectedEvictedKey) {
          mismatches.push({ index: i, reason: 'put(' + JSON.stringify(op.key) + ') expected evicted_key ' + JSON.stringify(op.expectedEvictedKey) + ', but Cache.put returned ' + JSON.stringify(actualEvicted) });
        }
      } else if (op.op === 'check_store') {
        const actualPresent = !!oc.present;
        if (actualPresent !== op.expectedPresent) {
          mismatches.push({ index: i, reason: 'expected backing-store key ' + JSON.stringify(op.key) + ' to be ' + (op.expectedPresent ? 'present' : 'absent') + ', but get_from_store reported ' + (actualPresent ? 'present' : 'absent') });
          continue;
        }
        if (actualPresent && !deepEqualTolerant(oc.value, op.expectedValue)) {
          mismatches.push({ index: i, reason: 'backing-store key ' + JSON.stringify(op.key) + ' has value ' + JSON.stringify(oc.value) + ', expected ' + JSON.stringify(op.expectedValue) });
        }
      }
      // advance_time: nothing to check.
    }

    if (mismatches.length > 0) {
      return {
        passed: false,
        logs: 'operations[' + mismatches[0].index + ']: ' + mismatches[0].reason + (mismatches.length > 1 ? ' (+' + (mismatches.length - 1) + ' more mismatch(es))' : ''),
        detail: { reason: 'outcome_mismatch', mismatches: mismatches.slice(0, 20), totalMismatches: mismatches.length, totalOperations: ops.length },
      };
    }

    return {
      passed: true,
      score: 1,
      detail: { reason: 'ok', operationsChecked: ops.length, cachePolicy: cachePolicy },
    };
  },
};
