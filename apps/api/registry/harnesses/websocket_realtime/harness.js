/**
 * websocket_realtime -- claim-vs-simulated-execution contradiction check.
 *
 * Every row describes a server's message-handling logic as prose pseudocode
 * (`server_implementation`, asyncio-flavored but NOT literally valid Python --
 * e.g. it nests a compound `for` statement as the single-line suite of another
 * compound statement), a scripted client scenario (`client_script` +
 * `event_sequence`), a scenario tag (`connection_scenario`), and a prose claim
 * of the resulting delivery/connection outcome (`expected_message_order_and_state`).
 *
 * Because `server_implementation` is not runnable as written, verification
 * classifies it into one of 7 canonical, REAL, runnable server archetypes
 * (broadcast / private-routing / room-isolation / dedup-idempotent /
 * seq-replay / capacity-limit / connection-count), reimplements that archetype
 * faithfully as a real `websockets`-based asyncio server, drives it through
 * the scripted scenario with a real `websockets` client, and compares what
 * ACTUALLY happened against the row's own claim. This mirrors auth_flow's
 * claim-vs-execution pattern, just with a simulated protocol scenario standing
 * in for a single function call.
 *
 * Every row's own `server_implementation`/`client_script`/`event_sequence`
 * text is self-contained -- no row ever references a sibling row's content, so
 * this single-row verify() never needs (and never attempts) any cross-row
 * lookup. Rows 20-24 are exact textual twins of five rows in 0-19 (identical
 * server_implementation/client_script/event_sequence, only the claim differs);
 * because classification and simulation are driven purely off those first
 * three fields, both twins in each pair are simulated identically and each
 * one's claim is independently checked against that ONE real simulated
 * outcome -- no twin-detection or "which one is the flawed one" logic exists
 * anywhere in this file.
 *
 * The plain-broadcast archetype's canonical implementation includes a
 * `finally: clients.discard(ws)` on handler-exit that the dataset's pseudocode
 * elides for brevity (`clients.add(ws); async for msg in ws: ...` with no
 * visible cleanup) -- included because every real implementation of this exact
 * idiom needs it, and omitting it makes the "client connects then disconnects
 * before anyone else connects/sends" scenario flaky (a stale closed socket
 * left in the broadcast set would non-deterministically interrupt delivery to
 * later clients depending on Python set iteration order). This is distinct
 * from the separate `except ConnectionClosed` guard some rows describe
 * explicitly around each `send` -- that guards a client going stale
 * *mid-broadcast*, a different race that exit-time cleanup alone does not
 * cover; both are implemented, independently, exactly where each row's own
 * text describes them.
 *
 * `private_routing`'s canonical server has two distinct real shapes, not
 * one: a stateless "route to the target if currently connected, else
 * silently drop" server (the original, still the fallback for a row using a
 * single always-online `to:`/`text:` send), and a "bounded per-registration
 * offline-message buffer, oldest-drop on overflow, flushed oldest-first on
 * reconnect" server for rows whose own text describes a disconnect +
 * several sends-while-offline + reconnect flow. Both are real, faithfully
 * implemented behaviors of the SAME `private_routing_handler` -- the buffer
 * only ever activates when the routing target is not currently connected,
 * so it is a strict superset of the stateless behavior, never a
 * replacement, and a row using the old single-message shape exercises it
 * exactly as before. See `parsePrivateRoutingBufferScenario` and
 * `checkPrivateRoutingBufferClaim` for the recognized text shape and claim
 * format this covers; a row using different wording for this same
 * buffer/overflow/reconnect idea falls through to the plain parser, fails
 * to build a scenario, and is reported as such rather than silently
 * mis-simulated -- exactly this file's existing failure discipline for any
 * unrecognized shape.
 *
 * `seq_replay` has the analogous split: the original canonical server has
 * ONE global monotonic seq counter and ONE global history/live-set
 * (HISTORY/LIVE/seed_emit), for a row whose reconnect specifies a single
 * `last_seen_seq_id` with no topic concept at all. A row describing
 * per-topic isolation ("each topic has its own monotonic seq_id and replay
 * buffer") is simulated by a genuinely separate set of globals
 * (TOPIC_HISTORY/TOPIC_LIVE/TOPIC_SEQ/topic_seed_emit), selected by sending
 * `{"resubscribe": {topic: last_seen, ...}}` instead of a bare
 * `last_seen_seq_id` -- never by branching on anything about the ROW, only
 * on which shape the wire message itself is, so both behaviors coexist in
 * the same handler without either one able to affect the other's state.
 * See `parseSeqReplayTopicScenario`/`checkSeqReplayTopicClaim` for the
 * recognized text/claim shape.
 *
 * A third seq_replay shape adds per-item corruption to the single-global-
 * stream server: each buffered history entry can be marked corrupt at seed
 * time (a real, if synthetic, stand-in for a failed checksum), and the
 * plain last_seen_seq_id replay loop -- shared with the two shapes above,
 * not a fourth copy of it -- stops at the first corrupt entry newer than
 * last_seen, sends a `replay_corrupt` marker for that entry's seq, and never
 * sends anything past it, matching a row describing "checksum fails ->
 * replay_corrupt -> later items withheld". A row with no corrupt entries at
 * all (every existing row) runs this exact same loop and never trips the
 * check, so this is additive to the plain shape, not a variant of it. See
 * `parseSeqReplayCorruptScenario`/`checkSeqReplayCorruptClaim`.
 */
'use strict';

// --------------------------------------------------------------- utilities ---

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function splitList(text) {
  return String(text)
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** "seq 1-5" -> [1,2,3,4,5]; "seq 3,4,5" -> [3,4,5]; "seq 5" -> [5]. */
function parseSeqNums(text) {
  let m = text.match(/seq\s+(\d+)\s*-\s*(\d+)/i);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const out = [];
    for (let i = a; i <= b; i++) out.push(i);
    return out;
  }
  m = text.match(/seq\s+((?:\d+\s*,\s*)+\d+)/i);
  if (m) return m[1].split(',').map((s) => Number(s.trim()));
  m = text.match(/seq\s+(\d+)\b/i);
  if (m) return [Number(m[1])];
  return null;
}

function extractSeqs(rawList) {
  return (rawList || [])
    .map((s) => {
      try {
        const o = JSON.parse(s);
        return o && typeof o.seq === 'number' ? o.seq : null;
      } catch (e) {
        return null;
      }
    })
    .filter((v) => v !== null);
}

/**
 * Return the distinct client names explicitly introduced by a sequence of
 * arrow-chained actions. This deliberately accepts only names attached to a
 * connect/register action; it does not guess from arbitrary prose.
 */
function explicitClientNames(eventSeq) {
  const names = [];
  const add = (name) => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const clause of String(eventSeq).split(/\s*->\s*/)) {
    const m = clause.match(/^\s*([\w-]+(?:\s*(?:,|and)\s*[\w-]+)*)\s+(?:connects?|registers?)\b/i);
    if (!m) continue;
    for (const name of m[1].split(/\s*(?:,|and)\s*/i)) add(name.trim());
  }
  return names;
}

function addSettledAction(actions, action) {
  actions.push(action);
  actions.push({ op: 'sleep', ms: 60 });
}

// ------------------------------------------------------ archetype classify ---

function classifyArchetype(impl, scenarioTag) {
  if (/private[\s-]*1:1|routes messages by recipient client_id/i.test(impl)) return 'private_routing';
  if (/room membership|sender's room/i.test(impl)) return 'room_isolation';
  if (/idempotent|already-applied duplicates|skips already-applied/i.test(impl)) return 'dedup_idempotent';
  if (/maximum of \d+ concurrently connected/i.test(impl)) return 'capacity_limit';
  // Was a single literal phrase ("tracks the count of currently connected
  // clients") -- confirmed too narrow: a row genuinely describing this exact
  // archetype ("server tracks a live connection count; a client sending a
  // special {type:'count'} query message receives back the current number
  // of connected clients as a reply, not a broadcast") used different but
  // semantically identical wording and fell through to the broadcast
  // default below, silently simulating and checking the WRONG handler.
  // Broadened to the two confirmed phrasings of this archetype's own
  // invariant ("connection count" as a compound noun, or "count of
  // connected client(s)") -- deliberately not the much broader
  // "count.*connect" (which would risk misclassifying an unrelated
  // archetype's prose that happens to mention both words in passing).
  if (/\bconnection[\s-]?count\b|\bcount of (?:currently\s+)?connected clients?\b|\btracks?\s+(?:a|the)\s+(?:live\s+|current\s+)?(?:count|number) of connected/i.test(impl)) return 'connection_count';
  if (/monotonic seq_id|last_seen_seq_id/i.test(impl)) return 'seq_replay';
  // server_implementation's own prose gave no specific signal.
  // connection_scenario is a short human-authored category tag (e.g.
  // "capacity limit exceeded") that was previously never read anywhere in
  // this harness -- use it to disambiguate before falling back to the
  // broadcast default, rather than defaulting on impl text alone.
  const tag = String(scenarioTag || '');
  if (/private|1:1|direct message/i.test(tag)) return 'private_routing';
  if (/\broom\b/i.test(tag)) return 'room_isolation';
  if (/idempotent|dedup|duplicate/i.test(tag)) return 'dedup_idempotent';
  if (/capacity|concurrent.*limit|limit.*exceed/i.test(tag)) return 'capacity_limit';
  // Was "connection count" (a literal space) -- a tag reading
  // "connection-count query" (hyphen, this dataset's own natural way of
  // writing the same compound noun) never matched, so a genuinely
  // correctly-tagged row still fell through to broadcast. `[\s-]?` accepts
  // both "connection count" and "connection-count" without loosening the
  // rest of the check.
  if (/connection[\s-]?count|count.*connect|connect.*count/i.test(tag)) return 'connection_count';
  if (/\bseq\b|replay|out[\s-]of[\s-]order/i.test(tag)) return 'seq_replay';
  return 'broadcast';
}

function broadcastFlags(impl) {
  return {
    guardSendErrors: /except ConnectionClosed/i.test(impl),
    excludeSender: /if c is not ws/i.test(impl),
    jsonGuard: /json\.loads|except ValueError/i.test(impl),
  };
}

function capacityMax(impl) {
  const prose = impl.match(/maximum of (\d+) concurrently connected/i);
  if (prose) return Number(prose[1]);

  // Pseudocode commonly expresses the same ceiling as the rejection guard
  // itself: `if len(sessions) >= 1: ... reject`.  The threshold is the
  // maximum permitted number of already-active sessions, so it is the
  // capacity directly (not an off-by-one "next client" count).
  const guard = impl.match(/len\s*\(\s*\w+\s*\)\s*>=\s*(\d+)/i);
  return guard ? Number(guard[1]) : 2;
}

/** Whether a full capacity rejection sends the documented structured busy
 * response before closing, rather than only closing the WebSocket. */
function capacityBusyReply(impl) {
  return /['"]status['"]\s*:\s*['"]busy['"]/.test(impl) && /['"]retryable['"]\s*:\s*true\b/i.test(impl);
}

/** Mirrors capacityMax's convention exactly: read the row's own declared
 * ceiling from its prose, default to 2 (this dataset's only observed value)
 * when unstated. */
function privateBufferMax(impl) {
  const m = impl.match(/buffers?\s+at\s+most\s+(\d+)\s+undelivered/i);
  return m ? Number(m[1]) : 2;
}

/**
 * A THIRD real private_routing shape, alongside the stateless silent-drop
 * and the bounded offline buffer already documented in this file's module
 * docstring: a row whose own server_implementation replies to the SENDER
 * with an explicit `{"error": "unknown_recipient", "to": ...}` message
 * instead of silently buffering when the routing target is not currently
 * connected. Confirmed missing: a row using exactly this pseudocode shape
 * (`else: await ws.send(json.dumps({'error': 'unknown_recipient', ...}))`)
 * still ran the plain buffer-on-miss handler, so its claim of an explicit
 * error reply could never be checked against real behavior -- the real
 * server never sent one. Detected narrowly off the literal error-code
 * string this dataset's own pseudocode uses for this idea, not a broader
 * "target is None" sniff that would misfire on the two existing shapes.
 */
function privateRoutingUnknownRecipient(impl) {
  return /unknown_recipient/i.test(impl);
}

// ------------------------------------------------------- scenario builders ---

function parseBroadcastScenario(clientScript, eventSeq) {
  const combined = clientScript + ' ' + eventSeq;

  if (/slow consumer|never calls recv/i.test(combined)) {
    return {
      names: ['fast', 'slow'],
      actions: [
        { op: 'connect', who: 'fast' },
        { op: 'connect', who: 'slow', deferRead: true },
        { op: 'send', who: 'fast', payload: 'm1' },
        { op: 'send', who: 'fast', payload: 'm2' },
        { op: 'send', who: 'fast', payload: 'm3' },
        { op: 'sleep', ms: 300 },
        { op: 'recv', who: 'slow', times: 3 },
      ],
    };
  }

  if (/before any broadcast/i.test(combined)) {
    return {
      names: ['a', 'b', 'c'],
      actions: [
        { op: 'connect', who: 'a' },
        { op: 'connect', who: 'b' },
        { op: 'connect', who: 'c' },
        { op: 'disconnect', who: 'b' },
        { op: 'sleep', ms: 100 },
        { op: 'send', who: 'a', payload: 'still-works' },
        { op: 'sleep', ms: 150 },
      ],
    };
  }

  if (/malformed/i.test(combined)) {
    return {
      names: ['client1'],
      actions: [
        { op: 'connect', who: 'client1' },
        { op: 'send', who: 'client1', payload: 'not-valid-json{{{' },
        { op: 'sleep', ms: 80 },
        { op: 'send', who: 'client1', payload: '{"valid": true}' },
        { op: 'sleep', ms: 150 },
      ],
    };
  }

  if (/disconnects? immediately without sending/i.test(combined)) {
    return {
      names: ['A', 'B'],
      actions: [
        { op: 'connect', who: 'A' },
        { op: 'disconnect', who: 'A' },
        { op: 'sleep', ms: 80 },
        { op: 'connect', who: 'B' },
        { op: 'send', who: 'B', payload: 'hello' },
        { op: 'sleep', ms: 150 },
      ],
    };
  }

  if (/rapid-fire|5 messages back-to-back/i.test(combined)) {
    const actions = [{ op: 'connect', who: 'client1' }];
    for (let i = 1; i <= 5; i++) actions.push({ op: 'send', who: 'client1', payload: 'msg' + i });
    actions.push({ op: 'sleep', ms: 150 });
    return { names: ['client1'], actions };
  }

  if (/excluding the sender|including the sender|including the original sender/i.test(combined)) {
    const payload = /echo-me/i.test(combined) ? 'echo-me' : 'broadcast-me';
    return {
      names: ['c1', 'c2', 'c3'],
      actions: [
        { op: 'connect', who: 'c1' },
        { op: 'connect', who: 'c2' },
        { op: 'connect', who: 'c3' },
        { op: 'send', who: 'c1', payload },
        { op: 'sleep', ms: 150 },
      ],
    };
  }

  if (/c1 sends 'a', c2 sends 'b', c3 sends 'c'/i.test(combined)) {
    return {
      names: ['c1', 'c2', 'c3'],
      actions: [
        { op: 'connect', who: 'c1' },
        { op: 'connect', who: 'c2' },
        { op: 'connect', who: 'c3' },
        { op: 'send', who: 'c1', payload: 'a' },
        { op: 'sleep', ms: 60 },
        { op: 'send', who: 'c2', payload: 'b' },
        { op: 'sleep', ms: 60 },
        { op: 'send', who: 'c3', payload: 'c' },
        { op: 'sleep', ms: 150 },
      ],
    };
  }

  if (/sends 'hello' then c2 sends 'hi'/i.test(combined)) {
    return {
      names: ['c1', 'c2', 'c3'],
      actions: [
        { op: 'connect', who: 'c1' },
        { op: 'connect', who: 'c2' },
        { op: 'connect', who: 'c3' },
        { op: 'send', who: 'c1', payload: 'hello' },
        { op: 'sleep', ms: 60 },
        { op: 'send', who: 'c2', payload: 'hi' },
        { op: 'sleep', ms: 150 },
      ],
    };
  }

  // "late joiner during ongoing broadcast" shape: two clients connect and
  // the first sends once, the SECOND then disconnects, a THIRD (late)
  // client connects afterward, then the first sends again. Distinct from
  // the "before any broadcast"/"disconnects immediately without sending"
  // branches above (which only ever have a disconnect with no other live
  // send happening around it) -- this shape needs the exact five-beat
  // connect/send/disconnect/connect/send ordering preserved so the late
  // joiner genuinely misses the first broadcast and the disconnected
  // client genuinely misses the second one. `[\s\S]*?` between anchors
  // (rather than a literal `->`) tolerates this dataset's own inline
  // "broadcast 'X' to a,b" annotations between beats without requiring
  // them -- those annotations describe the CLAIMED outcome, not an input
  // to parsing, and are never referenced here; the real outcome is
  // determined purely by the simulated run below.
  const lateJoin = combined.match(
    /(\w+)\s+connects[\s\S]*?(\w+)\s+connects[\s\S]*?\1\.send\('([^']+)'\)[\s\S]*?\2\s+disconnects[\s\S]*?(\w+)\s+connects[\s\S]*?\1\.send\('([^']+)'\)/i
  );
  if (lateJoin) {
    const [, sender, early, firstMsg, late, secondMsg] = lateJoin;
    return {
      names: [sender, early, late],
      sender,
      early,
      late,
      firstMsg,
      secondMsg,
      actions: [
        { op: 'connect', who: sender },
        { op: 'connect', who: early },
        { op: 'send', who: sender, payload: firstMsg },
        { op: 'sleep', ms: 100 },
        { op: 'disconnect', who: early },
        // Lets the disconnected client's own handler task actually reach its
        // `finally: CLIENTS.discard(ws)` before the late joiner connects and
        // the second send happens -- mirrors parsePrivateRoutingBufferScenario's
        // identical post-disconnect settle sleep and for the same reason: a
        // send racing the disconnect's cleanup could otherwise still try (and
        // fail, or non-deterministically succeed) to deliver to the stale ws.
        { op: 'sleep', ms: 80 },
        { op: 'connect', who: late },
        { op: 'sleep', ms: 60 },
        { op: 'send', who: sender, payload: secondMsg },
        { op: 'sleep', ms: 150 },
      ],
    };
  }

  // General explicit arrow-chain shape. The original parser only accepted a
  // handful of corpus sentences (for example, a literal `c1 sends 'a' ...`)
  // even though the field contract permits named clients and arrow-chained
  // actions. Every client must still be explicitly connected/registered, but
  // a send may now use the equally common `publishes` verb and a simple
  // unquoted event token. This remains clause-anchored (not free-prose
  // guessing): a payload is accepted only when it is the complete argument
  // of a `send`/`publish` action in the event sequence.
  const names = explicitClientNames(eventSeq);
  const sends = [...String(eventSeq).matchAll(
    /(?:^|->)\s*([\w-]+)\s+(?:sends?|publishes?)\s+(?:'([^']+)'|\"([^\"]+)\"|([\w-]+))\s*(?=$|->)/gi
  )].map((m) => ({ who: m[1], payload: m[2] || m[3] || m[4] }));
  if (names.length && sends.length) {
    const actions = names.map((who) => ({ op: 'connect', who }));
    for (const send of sends) addSettledAction(actions, { op: 'send', who: send.who, payload: send.payload });
    actions.push({ op: 'sleep', ms: 120 });
    return { names, actions };
  }

  return null;
}

/**
 * Recognizes the "bounded offline private-message buffer" shape: a target
 * disconnects but stays a valid registration name, a sender sends several
 * messages to it while offline, the target reconnects (same name, new
 * connection -- run_actions' own connect action already re-identifies by
 * name string, so no new op type is needed), then optionally one more
 * message is sent live. Tried BEFORE parsePrivateRoutingScenario (which
 * only recognizes a single always-online to:/text: send and would return
 * null against this multi-message/disconnect/reconnect text anyway).
 *
 * Matched against this dataset's one confirmed authoring convention so far
 * ("X disconnects...", "Y sends m1,m2,m3 to X while offline", "X
 * reconnects", "then Y sends m4") -- same "one narrow regex per known
 * phrasing shape" discipline parseBroadcastScenario already uses for its
 * many distinct branches, not a general-purpose free-form parser. A row
 * using different wording falls through to null here and then to
 * parsePrivateRoutingScenario, same as any other unrecognized shape in this
 * file already does.
 */
function parsePrivateRoutingBufferScenario(eventSeq, clientScript) {
  const combined = clientScript + ' ' + eventSeq;
  const offline = combined.match(/(\w+)\s+disconnects?\b/i);
  const whileOffline = combined.match(/(\w+)\s+sends\s+([\w]+(?:\s*,\s*[\w]+)*)\s+to\s+(\w+)\s+while\s+offline/i);
  const reconnect = combined.match(/(\w+)\s+reconnects?\b/i);
  if (!offline || !whileOffline || !reconnect) return null;

  const target = offline[1];
  const sender = whileOffline[1];
  const bufferedMsgs = whileOffline[2].split(',').map((s) => s.trim()).filter(Boolean);
  const postReconnect = combined.match(/then\s+(\w+)\s+sends\s+(\w+)\b/i);
  const liveMsg = postReconnect ? postReconnect[2] : null;

  const actions = [
    { op: 'connect', who: sender },
    { op: 'connect', who: target },
    { op: 'sleep', ms: 60 },
    { op: 'disconnect', who: target },
    // Lets the server's finally-block deregistration actually land before
    // the offline sends below -- otherwise a send racing the disconnect
    // could still find the target in NAME_TO_WS and deliver it live instead
    // of buffering it, which is exactly the ambiguity a real reconnect
    // scenario should not depend on winning.
    { op: 'sleep', ms: 80 },
  ];
  for (const msg of bufferedMsgs) {
    actions.push({ op: 'send', who: sender, payload: JSON.stringify({ to: target, text: msg }) });
    actions.push({ op: 'sleep', ms: 40 });
  }
  actions.push({ op: 'connect', who: target });
  // Generous margin for the buffer flush to actually be sent and read
  // before anything below (a live send, or claim-checking) depends on
  // having observed it.
  actions.push({ op: 'sleep', ms: 150 });
  if (liveMsg) {
    actions.push({ op: 'send', who: sender, payload: JSON.stringify({ to: target, text: liveMsg }) });
    actions.push({ op: 'sleep', ms: 150 });
  }
  return { names: [sender, target], sender, target, bufferedMsgs, liveMsg, actions };
}

function parsePrivateRoutingScenario(eventSeq) {
  const to = eventSeq.match(/to:\s*'([^']+)'/i);
  const text = eventSeq.match(/text:\s*'([^']+)'/i);
  const senderMatch = eventSeq.match(/(\w+)\s+sends\s+\{to:/i);
  if (!to || !text) return null;
  const sender = senderMatch ? senderMatch[1] : 'A';
  const registerNames = [...eventSeq.matchAll(/(\w+)\s+registers as '(\w+)'/gi)].map((m) => m[2]);
  const names = registerNames.length ? registerNames : ['A', 'B', 'C'];
  const actions = names.map((n) => ({ op: 'connect', who: n }));
  actions.push({ op: 'send', who: sender, payload: JSON.stringify({ to: to[1], text: text[1] }) });
  actions.push({ op: 'sleep', ms: 150 });
  const nonTarget = names.filter((n) => n !== to[1] && n !== sender);
  return { names, to: to[1], sender, nonTarget: nonTarget[0] || names.find((n) => n !== to[1]), actions };
}

/**
 * Parse an explicit sequence of direct-message objects. Unlike the legacy
 * single-message parser above, this supports the natural unquoted shorthand
 * used in arrow chains (`a sends {to:b, id:m1}`). The wire protocol remains
 * the canonical `{to, text}` form; `id`, `receipt`, and `seq` are merely
 * author-facing labels for the message body.
 */
function parseExplicitPrivateRoutingScenario(eventSeq) {
  const routes = [...String(eventSeq).matchAll(
    /(?:^|->)\s*([\w-]+)\s+sends\s+\{\s*to\s*:\s*'?([\w-]+)'?\s*,\s*(?:text|id|receipt|seq)\s*:\s*'?([\w-]+)'?\s*\}/gi
  )].map((m) => ({ sender: m[1], to: m[2], text: m[3] }));
  if (!routes.length) return null;

  const names = explicitClientNames(eventSeq);
  for (const route of routes) {
    if (!names.includes(route.sender)) names.push(route.sender);
    if (!names.includes(route.to)) names.push(route.to);
  }
  const actions = names.map((who) => ({ op: 'connect', who }));
  for (const route of routes) addSettledAction(actions, { op: 'send', who: route.sender, payload: JSON.stringify({ to: route.to, text: route.text }) });
  actions.push({ op: 'sleep', ms: 120 });
  return { names, routes, actions };
}

function parseRoomScenario(eventSeq) {
  // Room name accepts optional quotes ('alpha' or alpha) -- confirmed too
  // strict without this: a row quoting its room names (matching this file's
  // own convention of quoting message *text* everywhere else) had zero
  // "joins" matches and was reported as an unparseable scenario despite
  // being an otherwise-ordinary room_isolation row.
  const joins = [...eventSeq.matchAll(/(\w+)\s+joins\s+['"]?(\w+)['"]?/gi)];
  if (!joins.length) {
    // Supports explicit group membership such as "a1 and a2 join room
    // amber". The legacy parser only accepted one name per `joins` phrase.
    const grouped = [...String(eventSeq).matchAll(/([\w-]+(?:\s*(?:,|and)\s*[\w-]+)*)\s+joins?\s+(?:room\s+)?['"]?([\w-]+)['"]?/gi)];
    for (const group of grouped) {
      for (const name of group[1].split(/\s*(?:,|and)\s*/i)) joins.push([group[0], name.trim(), group[2]]);
    }
  }
  if (!joins.length) return null;
  const sendMatches = [...String(eventSeq).matchAll(/([\w-]+)\s+sends\s+'([^']+)'/gi)];
  if (!sendMatches.length) return null;
  const names = joins.map((m) => m[1]);
  const preConnect = names.map((n) => ({ op: 'connect', who: n }));
  const joinSends = joins.map((m) => ({ op: 'send', who: m[1], payload: JSON.stringify({ type: 'join', room: m[2] }) }));
  const contentSends = [];
  for (const send of sendMatches) addSettledAction(contentSends, { op: 'send', who: send[1], payload: send[2] });
  return {
    names,
    roomMembers: joins.reduce((out, m) => {
      (out[m[2]] ||= []).push(m[1]);
      return out;
    }, {}),
    actions: [...preConnect, ...joinSends, { op: 'sleep', ms: 60 }, ...contentSends, { op: 'sleep', ms: 120 }],
  };
}

function parseDedupScenario(eventSeq) {
  const sends = [...eventSeq.matchAll(/\{seq:\s*(\d+),\s*value:\s*'([^']+)'\}/gi)];
  if (!sends.length) {
    // Accept explicit message identifiers as the idempotency key. Map each
    // distinct identifier to a stable numeric sequence for the canonical
    // server while preserving the identifier as the observable value.
    const ids = [...String(eventSeq).matchAll(/(?:^|->)\s*(?:\w+[\s,]+)?(?:sends?|resends?)\s+(?:\{\s*)?(?:id\s*[:=]\s*)?['"]?([\w-]+)['"]?/gi)].map((m) => m[1]);
    if (!ids.length) return null;
    const seqById = new Map();
    const normalized = ids.map((id) => {
      if (!seqById.has(id)) seqById.set(id, seqById.size + 1);
      return { seq: String(seqById.get(id)), value: id };
    });
    const actions = [{ op: 'connect', who: 'client1' }];
    for (const item of normalized) addSettledAction(actions, { op: 'send', who: 'client1', payload: JSON.stringify({ seq: Number(item.seq), value: item.value }) });
    actions.push({ op: 'sleep', ms: 100 });
    return { names: ['client1'], expectedValues: [...seqById.keys()], actions };
  }
  const actions = [{ op: 'connect', who: 'client1' }];
  for (const s of sends) {
    actions.push({ op: 'send', who: 'client1', payload: JSON.stringify({ seq: Number(s[1]), value: s[2] }) });
    actions.push({ op: 'sleep', ms: 50 });
  }
  actions.push({ op: 'sleep', ms: 100 });
  return { names: ['client1'], actions };
}

/** Per-topic helper for parseSeqReplayTopicScenario: "prices 1-2 and news 1"
 * -> {prices: 2, news: 1} (message COUNTS, not the literal seq numbers --
 * the real seq numbers are assigned by the server's own per-topic counter
 * as each is seeded, never hardcoded into the scenario). Returns null if
 * any declared topic has no recognizable count in `text`, so the caller
 * can fall through rather than build a scenario off partial data. */
function extractTopicCounts(text, topics) {
  const out = {};
  for (const t of topics) {
    const m = text.match(new RegExp(t + '\\s+(\\d+)(?:\\s*-\\s*(\\d+))?', 'i'));
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] != null ? Number(m[2]) : a;
    out[t] = b - a + 1;
  }
  return out;
}

/** "prices last_seen=2 and news last_seen=1" -> {prices: 2, news: 1}. */
function extractTopicLastSeen(text, topics) {
  const out = {};
  for (const t of topics) {
    const m = text.match(new RegExp(t + '\\s+last_seen[=\\s]+(\\d+)', 'i'));
    if (!m) return null;
    out[t] = Number(m[1]);
  }
  return out;
}

/**
 * Recognizes the "independent sequence replay across two topics" shape: a
 * client subscribes to exactly two named topics, receives some number of
 * messages live on each, disconnects, more messages happen per-topic while
 * offline, then reconnects with a per-topic last_seen and should be
 * replayed exactly the per-topic missed messages (grouped by topic, not
 * globally seq-interleaved). Tried before parseSeqReplayScenario (whose own
 * four branches all require a DIFFERENT vocabulary -- "assigned seq=",
 * "emit(s/ted) seq ... while client is disconnected", "... total", "...
 * with no clients connected" -- none of which this row's text uses, so it
 * would return null anyway; this exists because the OLD canonical
 * seq_replay_handler has no topic concept at all, not just because
 * parseSeqReplayScenario's own regexes do not match this wording).
 *
 * Same "one narrow regex per confirmed phrasing" discipline as this file's
 * other parsers: matched against this dataset's one confirmed convention so
 * far ("X subscribes to A and B", "receives A i-j and B k", "Offline: A
 * m-n and B p-q occur", "reconnects requesting A last_seen=x and B
 * last_seen=y"). Exactly two topics, matching every confirmed row seen so
 * far -- a row describing a different topic count falls through to null
 * here (and then to parsePrivateRoutingScenario's -- sorry,
 * parseSeqReplayScenario's -- own null), same as any unrecognized shape.
 */
function parseSeqReplayTopicScenario(eventSeq, clientScript) {
  const combined = clientScript + ' ' + eventSeq;
  const sub = combined.match(/(\w+)\s+subscribes\s+to\s+(\w+)\s+and\s+(\w+)/i);
  if (!sub) return null;
  const subscriber = sub[1];
  const topics = [sub[2], sub[3]];

  const liveClause = combined.match(/receives\s+([\s\S]*?)(?:,\s*disconnects|\.\s*disconnects|\bdisconnects)/i);
  const offlineClause = combined.match(/offline:\s*([\s\S]*?)\s*occur/i);
  const reconnectClause = combined.match(/requesting\s+([\s\S]*?)\.(?:\s|$)/i);
  if (!liveClause || !offlineClause || !reconnectClause) return null;

  const liveCounts = extractTopicCounts(liveClause[1], topics);
  const offlineCounts = extractTopicCounts(offlineClause[1], topics);
  const lastSeen = extractTopicLastSeen(reconnectClause[1], topics);
  if (!liveCounts || !offlineCounts || !lastSeen) return null;

  const actions = [{ op: 'connect', who: subscriber }];
  const initialResub = {};
  for (const t of topics) initialResub[t] = 0;
  // Doubles as "subscribe me live going forward" (TOPIC_LIVE.add) exactly
  // like the plain single-stream shape's first last_seen_seq_id message
  // already does -- last_seen=0 replays nothing (no topic has any history
  // yet) while still registering for the live sends immediately below.
  actions.push({ op: 'send', who: subscriber, payload: JSON.stringify({ resubscribe: initialResub }) });
  actions.push({ op: 'sleep', ms: 40 });
  for (const t of topics) {
    for (let i = 0; i < liveCounts[t]; i++) {
      actions.push({ op: 'seed_topic', topic: t, payload: t + '-live-' + (i + 1) });
      actions.push({ op: 'sleep', ms: 20 });
    }
  }
  actions.push({ op: 'sleep', ms: 60 });
  actions.push({ op: 'disconnect', who: subscriber });
  // Same reasoning as parsePrivateRoutingBufferScenario's identical sleep:
  // lets the disconnect actually land server-side before anything below
  // depends on this subscriber being genuinely offline.
  actions.push({ op: 'sleep', ms: 80 });
  for (const t of topics) {
    for (let i = 0; i < offlineCounts[t]; i++) {
      actions.push({ op: 'seed_topic', topic: t, payload: t + '-offline-' + (i + 1) });
      actions.push({ op: 'sleep', ms: 20 });
    }
  }
  actions.push({ op: 'connect', who: subscriber });
  const resub = {};
  for (const t of topics) resub[t] = lastSeen[t];
  actions.push({ op: 'send', who: subscriber, payload: JSON.stringify({ resubscribe: resub }) });
  actions.push({ op: 'sleep', ms: 150 });

  return { names: [subscriber], subscriber, topics, liveCounts, offlineCounts, lastSeen, actions };
}

function parseSeqReplayScenario(eventSeq, clientScript) {
  const assignMatches = [...eventSeq.matchAll(/(\w+)\s+sends\s+'([^']+)'\s*\(assigned seq=(\d+)\)/gi)];
  if (assignMatches.length >= 2) {
    const actions = [];
    const names = [];
    for (const m of assignMatches) {
      const name = m[1];
      if (!names.includes(name)) {
        actions.push({ op: 'connect', who: name });
        names.push(name);
      }
      actions.push({ op: 'send', who: name, payload: m[2] });
      actions.push({ op: 'sleep', ms: 60 });
    }
    return { kind: 'assign', names, actions };
  }

  const midStream = eventSeq.match(/emit(?:s|ted) seq (\d+) and (\d+) while client is disconnected/i);
  const initRange = clientScript.match(/receives seq (\d+)\s*-\s*(\d+)/i);
  const reconnectLS = clientScript.match(/last_seen_seq_id=(\d+)/i);
  if (midStream && initRange) {
    const seedCount = Number(initRange[2]);
    const actions = [];
    for (let i = 0; i < seedCount; i++) actions.push({ op: 'seed', payload: 'v' + (i + 1) });
    actions.push({ op: 'connect', who: 'client1' });
    actions.push({ op: 'send', who: 'client1', payload: JSON.stringify({ last_seen_seq_id: 0 }) });
    actions.push({ op: 'sleep', ms: 100 });
    actions.push({ op: 'disconnect', who: 'client1' });
    actions.push({ op: 'seed', payload: 'v' + (seedCount + 1) });
    actions.push({ op: 'seed', payload: 'v' + (seedCount + 2) });
    actions.push({ op: 'sleep', ms: 200 });
    actions.push({ op: 'connect', who: 'client1' });
    actions.push({ op: 'send', who: 'client1', payload: JSON.stringify({ last_seen_seq_id: Number(reconnectLS ? reconnectLS[1] : seedCount) }) });
    actions.push({ op: 'sleep', ms: 150 });
    return { kind: 'total', names: ['client1'], actions };
  }

  const mTotal = eventSeq.match(/emit(?:s|ted) seq (\d+)\s*-\s*(\d+) total/i);
  if (mTotal) {
    const seedCount = Number(mTotal[2]);
    const actions = [];
    for (let i = 0; i < seedCount; i++) actions.push({ op: 'seed', payload: 'v' + (i + 1) });
    const reconnects = [...eventSeq.matchAll(/(\w+)\s+reconnects[^\->]*?last_seen_seq_id=(\d+)/gi)];
    const names = [];
    if (reconnects.length) {
      for (const r of reconnects) {
        const name = r[1];
        names.push(name);
        actions.push({ op: 'connect', who: name });
        actions.push({ op: 'send', who: name, payload: JSON.stringify({ last_seen_seq_id: Number(r[2]) }) });
        actions.push({ op: 'sleep', ms: 80 });
      }
    } else {
      const single = eventSeq.match(/last_seen_seq_id=(\d+)/i) || clientScript.match(/last_seen_seq_id=(\d+)/i);
      names.push('client1');
      actions.push({ op: 'connect', who: 'client1' });
      actions.push({ op: 'send', who: 'client1', payload: JSON.stringify({ last_seen_seq_id: single ? Number(single[1]) : 0 }) });
      actions.push({ op: 'sleep', ms: 120 });
    }
    return { kind: 'total', names, actions };
  }

  const mList = eventSeq.match(/emit(?:s|ted) seq ([\d, ]+) with no clients connected/i);
  if (mList) {
    const seedCount = mList[1].split(',').length;
    const actions = [];
    for (let i = 0; i < seedCount; i++) actions.push({ op: 'seed', payload: 'v' + (i + 1) });
    const lsMatch = eventSeq.match(/last_seen_seq_id=(\d+)/i);
    actions.push({ op: 'connect', who: 'client1' });
    actions.push({ op: 'send', who: 'client1', payload: JSON.stringify({ last_seen_seq_id: lsMatch ? Number(lsMatch[1]) : 0 }) });
    actions.push({ op: 'sleep', ms: 150 });
    return { kind: 'total', names: ['client1'], actions };
  }

  return null;
}

/**
 * Recognizes the "checksum-verified corrupted-replay-halt" shape: a client
 * reconnects with a plain last_seen (single global stream, no topic
 * concept), the buffered history it is owed contains one or more items
 * explicitly marked corrupt, and replay must stop at the FIRST corrupt item
 * -- sending a `replay_corrupt` marker for that item's seq and withholding
 * every later item, even ones the text separately calls "valid" -- rather
 * than skipping just the bad one and continuing. Matched against this
 * dataset's one confirmed convention so far ("X reconnects with last_seen
 * N", "Buffer contains valid seqA, corrupt seqB, valid seqC, ..."); a row
 * describing this same idea with different wording falls through to null
 * here and then to parseSeqReplayScenario's own four (unrelated-vocabulary)
 * branches, same as any unrecognized shape.
 *
 * Seeded via plain `seed_emit` (this is the single-global-stream shape, not
 * the per-topic one) with a run of harmless filler items first so the real,
 * described items land at the exact seq numbers the row's own text names
 * them by (lastSeen=7 -> the first described item becomes seq=8) --
 * mirrors parseSeqReplayScenario's own midStream/mTotal filler-seeding
 * convention, not a new technique.
 */
function parseSeqReplayCorruptScenario(eventSeq, clientScript) {
  const combined = clientScript + ' ' + eventSeq;
  const reconnect = combined.match(/(\w+)\s+reconnects?\s+with\s+last_seen\s+(\d+)/i);
  const bufferClause = combined.match(/buffer contains\s+([\s\S]*?)\.(?:\s|$)/i);
  if (!reconnect || !bufferClause) return null;

  const subscriber = reconnect[1];
  const lastSeen = Number(reconnect[2]);
  const items = [...bufferClause[1].matchAll(/(valid|corrupt)\s+seq\s*(\d+)/gi)]
    .map((m) => ({ corrupt: /corrupt/i.test(m[1]), seq: Number(m[2]) }))
    .sort((a, b) => a.seq - b.seq);
  // No corrupt entry at all is not this shape -- falls through to
  // parseSeqReplayScenario same as any row using different wording.
  if (!items.length || !items.some((it) => it.corrupt)) return null;

  const actions = [];
  for (let i = 0; i < lastSeen; i++) actions.push({ op: 'seed', payload: 'seen' + (i + 1) });
  for (const it of items) actions.push({ op: 'seed', payload: 'v' + it.seq, corrupt: it.corrupt });
  actions.push({ op: 'connect', who: subscriber });
  actions.push({ op: 'send', who: subscriber, payload: JSON.stringify({ last_seen_seq_id: lastSeen }) });
  actions.push({ op: 'sleep', ms: 150 });

  return { names: [subscriber], subscriber, lastSeen, corruptItems: items, actions };
}

/**
 * Parse a capacity scenario's explicit arrow-chain connection transitions.
 * In particular, this preserves a rejected connection followed by a later
 * departure and a successful new connection; the old fixed three-connect
 * simulation cannot represent that state transition at all.
 */
function parseExplicitCapacityScenario(eventSeq) {
  const actions = [];
  const names = [];
  const addName = (name) => {
    if (name && !names.includes(name)) names.push(name);
  };

  for (const clause of String(eventSeq).split(/\s*->\s*/)) {
    let m = clause.match(/^\s*([\w-]+(?:\s*(?:,|and)\s*[\w-]+)*)\s+connects?\b/i);
    if (m) {
      for (const name of m[1].split(/\s*(?:,|and)\s*/i)) {
        addName(name);
        addSettledAction(actions, { op: 'connect', who: name });
      }
      continue;
    }
    m = clause.match(/^\s*([\w-]+)\s+(?:disconnects?|closes?|leaves)\b/i);
    if (m) {
      addName(m[1]);
      // The settle delay is semantically important: it lets the server's
      // finally block release the slot before the next connect is attempted.
      addSettledAction(actions, { op: 'disconnect', who: m[1] });
    }
  }

  return names.length >= 2 && actions.some((action) => action.op === 'connect')
    ? { names, actions }
    : null;
}

// Legacy corpus fallback for the documented "two succeed, third rejected"
// wording, whose clients are not expressed as individual arrow-chain steps.
function parseCapacityScenario() {
  return {
    names: ['client1', 'client2', 'client3'],
    actions: [
      { op: 'connect', who: 'client1' },
      { op: 'sleep', ms: 60 },
      { op: 'connect', who: 'client2' },
      { op: 'sleep', ms: 60 },
      { op: 'connect', who: 'client3' },
      { op: 'sleep', ms: 200 },
    ],
  };
}

/**
 * Recognizes the "3 named clients connect, the middle one disconnects, the
 * first queries the count" shape -- distinct from parseConnCountScenario's
 * fixed 2-client A/B scenario below, which that function's own hardcoded
 * names/count-query cannot express at all (there is no third client to
 * distinguish "currently active" from "the peak that was connected before
 * one left"). Tried before parseConnCountScenario for the same reason
 * parsePrivateRoutingBufferScenario is tried before its own plainer
 * sibling: this shape's anchors (three connects, then a disconnect of the
 * SECOND, then a send by the FIRST) are strictly more specific, and a row
 * using the plain 2-client wording never matches this regex anyway.
 * `[\s\S]*?` between anchors (rather than a literal `->`) tolerates
 * this dataset's own inline "-> server responds with ..." annotations
 * between beats without requiring them -- same discipline as
 * parseBroadcastScenario's "late joiner" branch. Matched against this
 * dataset's one confirmed convention so far ("X connects -> Y connects ->
 * Z connects -> Y disconnects -> X sends {...}"); a row using a different
 * client count or ordering falls through to null here and then to
 * parseConnCountScenario's own fixed shape, same as any unrecognized shape
 * elsewhere in this file.
 */
function parseConnCountThreeClientScenario(eventSeq) {
  const m = eventSeq.match(/(\w+)\s+connects[\s\S]*?(\w+)\s+connects[\s\S]*?(\w+)\s+connects[\s\S]*?\2\s+disconnects[\s\S]*?\1\s+sends/i);
  if (!m) return null;
  const [, first, middle, last] = m;
  return {
    names: [first, middle, last],
    asker: first,
    actions: [
      { op: 'connect', who: first },
      { op: 'sleep', ms: 40 },
      { op: 'connect', who: middle },
      { op: 'sleep', ms: 40 },
      { op: 'connect', who: last },
      { op: 'sleep', ms: 60 },
      { op: 'disconnect', who: middle },
      // Lets the disconnecting client's handler task actually reach its
      // `finally: CONN_COUNT -= 1` before the count query below depends on
      // having observed the decrement -- same reasoning as this file's other
      // post-disconnect settle sleeps (parsePrivateRoutingBufferScenario,
      // parseBroadcastScenario's late-joiner branch).
      { op: 'sleep', ms: 100 },
      { op: 'send', who: first, payload: JSON.stringify({ type: 'get_count' }) },
      { op: 'sleep', ms: 150 },
    ],
  };
}

/** Parse an explicit arrow chain of named connects, disconnects, and count
 * queries. This is used before the two legacy fixed scenarios so the server
 * is exercised with the contributor's actual membership transitions. */
function parseExplicitConnCountScenario(eventSeq) {
  const actions = [];
  const names = [];
  const askers = [];
  const addName = (name) => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const clause of String(eventSeq).split(/\s*->\s*/)) {
    let m = clause.match(/^\s*([\w-]+(?:\s*(?:,|and)\s*[\w-]+)*)\s+connects?\b/i);
    if (m) {
      for (const name of m[1].split(/\s*(?:,|and)\s*/i)) {
        addName(name);
        addSettledAction(actions, { op: 'connect', who: name });
      }
      continue;
    }
    m = clause.match(/^\s*([\w-]+)\s+(?:disconnects?|closes?|leaves)\b/i);
    if (m) {
      addSettledAction(actions, { op: 'disconnect', who: m[1] });
      continue;
    }
    m = clause.match(/^\s*([\w-]+)\s+(?:asks?|requests?|sends?)\s+(?:for\s+)?count\b/i);
    if (m) {
      addName(m[1]);
      askers.push(m[1]);
      addSettledAction(actions, { op: 'send', who: m[1], payload: JSON.stringify({ type: 'get_count' }) });
    }
  }
  return names.length >= 2 && askers.length ? { names, asker: askers[0], askers, actions } : null;
}

function parseConnCountScenario(eventSeq) {
  const actions = [{ op: 'connect', who: 'A' }, { op: 'sleep', ms: 40 }, { op: 'connect', who: 'B' }, { op: 'sleep', ms: 40 }];
  if (/B disconnects/i.test(eventSeq)) {
    actions.push({ op: 'disconnect', who: 'B' });
    actions.push({ op: 'sleep', ms: 100 });
  }
  actions.push({ op: 'send', who: 'A', payload: JSON.stringify({ type: 'get_count' }) });
  actions.push({ op: 'sleep', ms: 150 });
  return { names: ['A', 'B'], asker: 'A', actions };
}

// ---------------------------------------------------------- claim checkers ---

function checkBroadcastClaim(claim, names, received, errors) {
  if (/the server crashes with an unhandled exception/i.test(claim)) {
    // We only ever reach claim-checking after a clean run producing a valid
    // @@OUT -- a real unhandled crash never occurred, so this claim is false
    // by construction whenever it is asserted.
    return { passed: false, reason: 'claim asserts an unhandled server crash that did not occur (script ran clean)' };
  }

  // Accept the direct prose form generated from an explicit arrow chain:
  // "Every client receives alpha, then beta, then gamma in that order." The
  // values are still compared exactly against real delivery, rather than
  // trusting the claimed order.
  let m = claim.match(/every clients? receives\s+(.+?)\s+in that order/i);
  if (m) {
    const expected = m[1]
      .split(/\s*,?\s*(?:then|,)\s*/i)
      .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const ok = expected.length > 0 && names.every((name) => arraysEqual(received[name] || [], expected));
    return { passed: ok, reason: ok ? '' : `expected all of ${names.join(',')} to receive ${JSON.stringify(expected)}, got ${JSON.stringify(names.map((name) => received[name]))}` };
  }

  m = claim.match(/all \d+ clients? receive\s+'([^']+)'\s+before\s+'([^']+)'/i);
  if (m) {
    const expected = [m[1], m[2]];
    const ok = names.every((n) => arraysEqual(received[n] || [], expected));
    return { passed: ok, reason: ok ? '' : `expected all of ${names.join(',')} to receive ${JSON.stringify(expected)}, got ${JSON.stringify(names.map((n) => received[n]))}` };
  }

  m = claim.match(/receives all \d+ messages? in the correct order\s*\(([^)]+)\)/i);
  if (m) {
    const expected = splitList(m[1]);
    const scope = /slow client/i.test(claim) ? ['slow'] : names;
    const ok = scope.every((n) => arraysEqual(received[n] || [], expected));
    return { passed: ok, reason: ok ? '' : `expected ${scope.join(',')} to receive ${JSON.stringify(expected)}, got ${JSON.stringify(scope.map((n) => received[n]))}` };
  }

  m = claim.match(/every client receives all \d+ messages in the exact order they were sent:\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'/i);
  if (m) {
    const expected = [m[1], m[2], m[3]];
    const ok = names.every((n) => arraysEqual(received[n] || [], expected));
    return { passed: ok, reason: ok ? '' : `expected all of ${names.join(',')} to receive ${JSON.stringify(expected)}` };
  }

  m = claim.match(/(\w+) and (\w+) both receive '([^']+)';\s*(\w+)\s*\(the sender\)\s*receives nothing/i);
  if (m) {
    const [_, n1, n2, msg, senderName] = m;
    const ok = arraysEqual(received[n1] || [], [msg]) && arraysEqual(received[n2] || [], [msg]) && (received[senderName] || []).length === 0;
    return { passed: ok, reason: ok ? '' : `expected ${n1},${n2} to receive [${msg}] and ${senderName} nothing` };
  }

  m = claim.match(/(\w+), (\w+), and (\w+) all receive '([^']+)', including the sender itself/i);
  if (m) {
    const [_, n1, n2, n3, msg] = m;
    const ok = [n1, n2, n3].every((n) => arraysEqual(received[n] || [], [msg]));
    return { passed: ok, reason: ok ? '' : `expected ${n1},${n2},${n3} to all receive [${msg}]` };
  }

  if (/malformed message is never broadcast to anyone/i.test(claim) && /broadcast normally/i.test(claim)) {
    // Exact match against the one message that should survive, not a
    // presence check -- consistent with the exact-match discipline used
    // everywhere else in this file, so this stays correct if this fixed
    // 1-client/2-message scenario is ever extended to more messages/clients.
    const list = received['client1'] || [];
    const ok = arraysEqual(list, ['{"valid": true}']);
    return { passed: ok, reason: ok ? '' : `client1 received ${JSON.stringify(list)}` };
  }

  m = claim.match(/client B receives its own broadcasted '([^']+)' normally/i);
  if (m) {
    const ok = arraysEqual(received['B'] || [], [m[1]]) && !errors['B'];
    return { passed: ok, reason: ok ? '' : `B received ${JSON.stringify(received['B'])}, errors=${JSON.stringify(errors['B'] || null)}` };
  }

  m = claim.match(/receives all 5 of its own broadcasted messages back in the exact order sent:\s*([^-]+?)\s*--/i);
  if (m) {
    const expected = splitList(m[1]);
    const ok = arraysEqual(received['client1'] || [], expected);
    return { passed: ok, reason: ok ? '' : `client1 received ${JSON.stringify(received['client1'])}` };
  }

  m = claim.match(/\b(\w+)\s+receives\s+'([^']+)'\s+normally/i);
  if (m) {
    const ok = arraysEqual(received[m[1]] || [], [m[2]]);
    return { passed: ok, reason: ok ? '' : `${m[1]} received ${JSON.stringify(received[m[1]])}` };
  }

  // Matches parseBroadcastScenario's "late joiner" shape's claim: "<late>
  // never receives '<first>' (...), <early> never receives '<second>'
  // (...), and <sender> receives both '<first>' and '<second>' in that
  // order". Checks exactly the three things claimed -- not a broader
  // "no client receives a message twice" sniff -- consistent with this
  // file's exact-assertion discipline; the sender's exact-order check
  // already rules out any duplicate delivery to the sender by construction.
  m = claim.match(
    /(\w+)\s+never receives\s+'([^']+)'[^,]*,\s*(\w+)\s+never receives\s+'([^']+)'[^,]*,\s*and\s+(\w+)\s+receives both\s+'([^']+)'\s+and\s+'([^']+)'\s+in that order/i
  );
  if (m) {
    const [, neverA, neverAMsg, neverB, neverBMsg, both, bothMsg1, bothMsg2] = m;
    const gotNeverA = (received[neverA] || []).includes(neverAMsg);
    const gotNeverB = (received[neverB] || []).includes(neverBMsg);
    const bothOk = arraysEqual(received[both] || [], [bothMsg1, bothMsg2]);
    const ok = !gotNeverA && !gotNeverB && bothOk;
    return {
      passed: ok,
      reason: ok
        ? ''
        : `${neverA} got=${JSON.stringify(received[neverA])} (must not include '${neverAMsg}'), ${neverB} got=${JSON.stringify(received[neverB])} (must not include '${neverBMsg}'), ${both} got=${JSON.stringify(received[both])} (expected exactly ['${bothMsg1}','${bothMsg2}'])`,
    };
  }

  return null;
}

function checkPrivateRoutingClaim(claim, target, other, received) {
  const targetGot = (received[target] || []).some((s) => {
    try {
      return JSON.parse(s).text != null;
    } catch (e) {
      return false;
    }
  });
  const otherGot = (received[other] || []).length > 0;

  // Both branches below capture the NAMES the claim itself asserts (e.g.
  // "only A receives the message, B receives nothing") but used to only
  // .test() the shape and then substitute the scenario-derived target/other
  // unconditionally -- confirmed exploitable without this check: a claim
  // that names the exact WRONG recipient (the literal inverse of what
  // really happened) still matched the shape regex and was scored against
  // targetGot/otherGot as if it had named the real target/other, so an
  // inverted claim passed outright. The claim's own named entities must
  // actually BE the real target/other before targetGot/otherGot mean
  // anything about what the claim is asserting.
  // `.*` here (not `.*?`) previously let greedy backtracking swallow all but
  // the LAST character of the second name before handing off to `(\w+)` --
  // confirmed exploitable without this: on "only orin receives the
  // message; pax receives nothing", it captured "x", not "pax", silently
  // truncating the claimed name to one character. Invisible on this
  // dataset's existing single-letter names (A/B/C), where the truncated
  // capture happens to equal the full name -- but a genuine bug for any
  // multi-character name, wrongly reporting "claim names ...x receiving
  // nothing, but real scenario is ...pax" for an otherwise-correct claim.
  // Non-greedy `.*?` finds the nearest word boundary instead of the
  // farthest, capturing the whole name.
  let m = claim.match(/only (\w+) receives the message.*?(\w+) receives nothing/i);
  if (m) {
    const [claimedRecipient, claimedNothing] = [m[1], m[2]];
    if (claimedRecipient !== target || claimedNothing !== other) {
      return { passed: false, reason: `claim names ${claimedRecipient} receiving / ${claimedNothing} receiving nothing, but the real scenario is target=${target}, other=${other}` };
    }
    const ok = targetGot && !otherGot;
    return { passed: ok, reason: ok ? '' : `target(${target}) got=${targetGot}, other(${other}) got=${otherGot}` };
  }
  m = claim.match(/both (\w+) and (\w+) receive the private message/i);
  if (m) {
    const [n1, n2] = [m[1], m[2]];
    const namesMatch = (n1 === target && n2 === other) || (n1 === other && n2 === target);
    if (!namesMatch) {
      return { passed: false, reason: `claim names ${n1}/${n2} but the real scenario is target=${target}, other=${other}` };
    }
    // Claims both receive it -- true only if reality also shows both receiving.
    const ok = targetGot && otherGot;
    return { passed: ok, reason: ok ? '' : `target(${target}) got=${targetGot}, other(${other}) got=${otherGot}` };
  }
  return null;
}

function checkExplicitPrivateRoutingClaim(claim, routes, received) {
  const asserted = [...String(claim).matchAll(/([\w-]+)\s+receives\s+only\s+([\w-]+)/gi)];
  if (!asserted.length) return null;

  const expectedByRecipient = new Map();
  for (const route of routes) {
    const list = expectedByRecipient.get(route.to) || [];
    list.push(route.text);
    expectedByRecipient.set(route.to, list);
  }
  const claimedNames = new Set(asserted.map((m) => m[1]));
  const namesMatch = asserted.every((m) => {
    const expected = expectedByRecipient.get(m[1]) || [];
    return expected.length === 1 && expected[0] === m[2];
  });
  const receivedMatch = [...expectedByRecipient.entries()].every(([recipient, expected]) => {
    const actual = (received[recipient] || [])
      .map((raw) => {
        try {
          return JSON.parse(raw).text;
        } catch (e) {
          return null;
        }
      })
      .filter((value) => value != null);
    return arraysEqual(actual, expected);
  });
  const allRecipientsClaimed = [...expectedByRecipient.keys()].every((name) => claimedNames.has(name));
  const ok = namesMatch && receivedMatch && allRecipientsClaimed;
  return {
    passed: ok,
    reason: ok
      ? ''
      : `explicit routes=${JSON.stringify([...expectedByRecipient])}, assertions=${JSON.stringify(asserted.map((m) => [m[1], m[2]]))}, received=${JSON.stringify(received)}`,
  };
}

/**
 * Checks the buffered-private-routing claim shape: "<recipient> receives
 * <m1> then <m2> [then <m3> ...][; <dropped> is lost by [...] overflow
 * [...] policy]." The lost-message clause is optional -- a scenario with no
 * more buffered messages than the declared capacity legitimately claims no
 * loss at all, and is the same feature's natural non-overflow sibling case,
 * not a different claim shape. Exact-order, exact-membership -- not a
 * presence check -- consistent with this file's other checkXClaim
 * functions, and when a lost message IS claimed, explicitly confirms it
 * never shows up at all (a claim could otherwise pass by accident if the
 * real buffer eviction picked a different victim than the row claims).
 */
function checkPrivateRoutingBufferClaim(claim, received) {
  const m = claim.match(/(\w+)\s+receives?\s+([\w]+(?:\s+then\s+[\w]+)*)\s*(?:;\s*(\w+)\s+is\s+lost)?/i);
  if (!m) return null;
  const recipient = m[1];
  const expectedOrder = m[2].split(/\s+then\s+/i);
  const lost = m[3] || null;
  const texts = (received[recipient] || [])
    .map((s) => {
      try {
        return JSON.parse(s).text;
      } catch (e) {
        return null;
      }
    })
    .filter((v) => v != null);
  const ok = arraysEqual(texts, expectedOrder) && (!lost || !texts.includes(lost));
  return {
    passed: ok,
    reason: ok ? '' : `${recipient} received texts=${JSON.stringify(texts)}, expected order=${JSON.stringify(expectedOrder)}, lost=${lost}`,
  };
}

/**
 * Checks the "routing to a never-registered recipient replies with an
 * error" claim shape: "<other> receives nothing at all; <sender> receives
 * only the unknown_recipient error referencing '<target>', never the
 * original ... text echoed back ...". Only ever dispatched to when
 * FLAGS.unknownRecipientError was detected on this row's own
 * server_implementation (see privateRoutingUnknownRecipient / the
 * private_routing_handler `elif` branch) -- a plain silent-drop or
 * buffered row never reaches this checker, so this is additive to
 * checkPrivateRoutingClaim's existing shapes, not a replacement.
 * Same named-entity validation discipline as checkPrivateRoutingClaim: the
 * claim's own asserted sender/other/target must actually BE the real
 * scenario's, not just matched by shape, before anything else is checked.
 */
function checkPrivateRoutingUnknownRecipientClaim(claim, sender, other, target, received) {
  const m = claim.match(/(\w+)\s+receives nothing at all;\s*(\w+)\s+receives only the unknown_recipient error referencing\s+'(\w+)'/i);
  if (!m) return null;
  const [, claimedOther, claimedSender, claimedTarget] = m;
  if (claimedSender !== sender || claimedOther !== other || claimedTarget !== target) {
    return {
      passed: false,
      reason: `claim names sender=${claimedSender}/other=${claimedOther}/target=${claimedTarget}, but the real scenario is sender=${sender}, other=${other}, target=${target}`,
    };
  }
  const senderMsgs = (received[sender] || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
  const gotError = senderMsgs.some((o) => o && o.error === 'unknown_recipient' && o.to === target);
  const gotEcho = senderMsgs.some((o) => o && typeof o.text !== 'undefined');
  const otherGot = (received[other] || []).length > 0;
  const ok = gotError && !gotEcho && !otherGot;
  return {
    passed: ok,
    reason: ok ? '' : `${sender} received ${JSON.stringify(senderMsgs)}, ${other} received ${JSON.stringify(received[other] || [])}`,
  };
}

function checkRoomClaim(claim, names, received, scenario) {
  // "Both amber clients receive a-first then a-second ..." is the natural
  // counterpart to grouped `join room amber` actions. Validate the complete
  // observed delivery list for every named member; the room name is resolved
  // from the scenario, never inferred from the claim alone.
  if (scenario && scenario.roomMembers) {
    const grouped = [...String(claim).matchAll(/both\s+([\w-]+)\s+clients\s+receive\s+([\w-]+)(?:\s+then\s+([\w-]+))?/gi)];
    if (grouped.length) {
      const ok = grouped.every((m) => {
        const members = scenario.roomMembers[m[1]] || [];
        const expected = [m[2], ...(m[3] ? [m[3]] : [])];
        return members.length > 0 && members.every((name) => arraysEqual(received[name] || [], expected));
      });
      return {
        passed: ok,
        reason: ok ? '' : `grouped room claim=${JSON.stringify(grouped.map((m) => [m[1], m[2], m[3] || null]))}, received=${JSON.stringify(received)}`,
      };
    }
  }

  // Tried first: a claim naming the actual sent text in quotes (e.g. "B
  // receives 'hello-alpha'; C ... receives nothing") -- confirmed too
  // narrow without this, since the ONLY previously-recognized shape required
  // the literal words "receives the message", and a row phrasing the same
  // fact around the real payload (this file's own quoting convention for
  // message content everywhere else) had no matching claim checker despite
  // its scenario parsing and running fine. Exact-membership, not presence --
  // same discipline as this file's other checkXClaim functions.
  let m = claim.match(/(\w+)\s+receives\s+'([^']+)'.*?;\s*(\w+)[^,]*receives nothing/i);
  if (m) {
    const [, inName, msg, outName] = m;
    const inList = received[inName] || [];
    const outList = received[outName] || [];
    const ok = inList.includes(msg) && outList.length === 0;
    return { passed: ok, reason: ok ? '' : `${inName} got=${JSON.stringify(inList)} (expected to include '${msg}'), ${outName} got=${JSON.stringify(outList)}` };
  }

  m = claim.match(/(\w+) receives the message;\s*(\w+)[^,]*receives nothing/i);
  if (!m) return null;
  const inRoom = (received[m[1]] || []).length > 0;
  const outRoom = (received[m[2]] || []).length > 0;
  const ok = inRoom && !outRoom;
  return { passed: ok, reason: ok ? '' : `${m[1]} got=${inRoom}, ${m[2]} got=${outRoom}` };
}

function checkDedupClaim(claim, appliedValues, scenario) {
  const m = claim.match(/applied-values list ends up as\s*\[([^\]]+)\]/i);
  const expected = m
    ? splitList(m[1])
    : /processed once each|applied once each/i.test(claim) && scenario && scenario.expectedValues
      ? scenario.expectedValues
      : null;
  if (!expected) return null;
  const ok = arraysEqual(appliedValues || [], expected);
  return { passed: ok, reason: ok ? '' : `applied_values=${JSON.stringify(appliedValues)} expected ${JSON.stringify(expected)}` };
}

/**
 * Checks the "independent per-topic replay" claim shape: "... <topicA>
 * ends at <N> and <topicB> ends at <M>" (the row's own way of asserting
 * each topic's final seq counter). Two independent checks, both required:
 *  1. the ACTUAL final seq reached per topic (from real received messages,
 *     never from this function's own expectation) equals what the claim
 *     asserts -- catches a claim that states the wrong final count.
 *  2. the exact ORDERED, topic-grouped tail of what the subscriber
 *     actually received (real messages tagged {topic, seq, value} by
 *     topic_seed_emit) matches the missed-items set this checker computes
 *     independently from liveCounts/offlineCounts/lastSeen -- catches a
 *     real implementation bug where topics' seq counters or histories
 *     leak into each other (exactly the "no cross-topic seq
 *     interpretation" the row's claim explicitly calls out), which check
 *     1 alone could miss if the miscount happened to cancel out.
 */
function checkSeqReplayTopicClaim(claim, subscriber, topics, liveCounts, offlineCounts, lastSeen, received) {
  const endsAt = {};
  for (const t of topics) {
    const m = claim.match(new RegExp(t + '\\s+ends?\\s+at\\s+(\\d+)', 'i'));
    if (!m) return null;
    endsAt[t] = Number(m[1]);
  }

  const msgs = (received[subscriber] || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch (e) {
        return null;
      }
    })
    .filter((v) => v && typeof v.topic === 'string' && typeof v.seq === 'number');

  const maxSeqByTopic = {};
  for (const m of msgs) maxSeqByTopic[m.topic] = Math.max(maxSeqByTopic[m.topic] || 0, m.seq);
  const endsMatch = topics.every((t) => maxSeqByTopic[t] === endsAt[t]);

  const expectedReplay = [];
  for (const t of topics) {
    for (let seq = (lastSeen[t] || 0) + 1; seq <= (liveCounts[t] || 0) + (offlineCounts[t] || 0); seq++) {
      expectedReplay.push(t + ':' + seq);
    }
  }
  const actualTail = msgs.slice(-expectedReplay.length).map((m) => m.topic + ':' + m.seq);
  const replayMatch = arraysEqual(actualTail, expectedReplay);

  const ok = endsMatch && replayMatch;
  return {
    passed: ok,
    reason: ok
      ? ''
      : `endsMatch=${endsMatch} (actual=${JSON.stringify(maxSeqByTopic)}, claimed=${JSON.stringify(endsAt)}), replayMatch=${replayMatch} (actual tail=${JSON.stringify(actualTail)}, expected=${JSON.stringify(expectedReplay)})`,
  };
}

function checkSeqReplayClaim(claim, names, history, receivedSeqsByName) {
  const assigns = [...claim.matchAll(/message from (\w+) is assigned seq=(\d+)/gi)];
  if (assigns.length) {
    // `history.find()` always resolves to a given sender's FIRST history
    // entry, no matter which occurrence (1st, 2nd, ...) of that sender the
    // claim is currently describing -- confirmed exploitable without this:
    // a claim describing a sender's SECOND message was silently checked
    // against that sender's FIRST real seq value instead, so an
    // objectively false claim about the second message ("also gets seq=1",
    // when the real global counter assigned it seq=2) passed as long as
    // the claimed number happened to equal the first entry's real seq.
    // Tracking a per-sender consumed-count and indexing into that sender's
    // Nth real history entry (matching claim occurrence order to emission
    // order) resolves each ordinal reference correctly instead.
    const consumedBySender = {};
    const ok = assigns.every((a) => {
      const sender = a[1];
      const idx = consumedBySender[sender] || 0;
      consumedBySender[sender] = idx + 1;
      const entry = history.filter((h) => h.sender === sender)[idx];
      return !!entry && entry.seq === Number(a[2]);
    });
    return { passed: ok, reason: ok ? '' : `history=${JSON.stringify(history)}` };
  }

  if (/zero messages are replayed/i.test(claim)) {
    const ok = names.every((n) => (receivedSeqsByName[n] || []).length === 0);
    return { passed: ok, reason: ok ? '' : `receivedSeqs=${JSON.stringify(receivedSeqsByName)}` };
  }

  let m = claim.match(/both client (\w+) and (?:client )?(\w+) receive the exact same replayed messages\s*\(([^)]*)\)/i);
  if (m) {
    // Scoped to the matched parenthetical (m[3]), not the whole claim --
    // parsing the whole claim let an earlier decoy "seq N,M,..." substring
    // anywhere else in the free-form prose get parsed instead of the
    // number list this clause actually asserts.
    const list = parseSeqNums(m[3]);
    const ok = !!list && arraysEqual(receivedSeqsByName[m[1]] || [], list) && arraysEqual(receivedSeqsByName[m[2]] || [], list);
    return { passed: ok, reason: ok ? '' : `receivedSeqs=${JSON.stringify(receivedSeqsByName)} expected both=${JSON.stringify(list)}` };
  }

  const perClient = [...claim.matchAll(/client (\w+) receives? (?:only )?seq[^;.]*/gi)];
  if (perClient.length >= 1) {
    let allOk = true;
    const details = [];
    for (const pc of perClient) {
      const list = parseSeqNums(pc[0]);
      const nameMatch = pc[0].match(/client (\w+)/i);
      if (!nameMatch || !list) {
        allOk = false;
        continue;
      }
      const ok = arraysEqual(receivedSeqsByName[nameMatch[1]] || [], list);
      if (!ok) allOk = false;
      details.push(`${nameMatch[1]}:expected ${JSON.stringify(list)} got ${JSON.stringify(receivedSeqsByName[nameMatch[1]])}`);
    }
    return { passed: allOk, reason: allOk ? '' : details.join('; ') };
  }

  if (/ends up with seq/i.test(claim) || /historical messages/i.test(claim)) {
    const list = parseSeqNums(claim);
    if (!list) return null;
    const ok = names.every((n) => arraysEqual(receivedSeqsByName[n] || [], list));
    return { passed: ok, reason: ok ? '' : `receivedSeqs=${JSON.stringify(receivedSeqsByName)} expected ${JSON.stringify(list)}` };
  }

  return null;
}

/**
 * Checks the "halted by corrupted buffered event" claim shape: "<recipient>
 * receives seq<A>[ ... ] followed by replay_corrupt for seq<C>; seq<D> is
 * withheld ...". Checks against the real received messages, not just that a
 * replay_corrupt marker showed up somewhere:
 *  1. every claimed-good seq was delivered normally, in order, first;
 *  2. the very next (and last) message is the replay_corrupt marker for the
 *     claimed corrupt seq -- not merely present anywhere in the stream;
 *  3. the claimed-withheld seq never appears as a normal delivery -- catches
 *     a real implementation bug where replay resumes past the corrupt item
 *     instead of halting, which the row's own claim explicitly rules out
 *     ("continuity cannot be guaranteed").
 */
function checkSeqReplayCorruptClaim(claim, received) {
  const m = claim.match(/(\w+)\s+receives\s+([\s\S]*?)\s*followed by replay_corrupt for seq(\d+)\s*;\s*seq(\d+)\s+is withheld/i);
  if (!m) return null;
  const recipient = m[1];
  const goodSeqs = [...m[2].matchAll(/seq(\d+)/gi)].map((g) => Number(g[1]));
  const corruptSeq = Number(m[3]);
  const withheldSeq = Number(m[4]);
  if (!goodSeqs.length) return null;

  const msgs = (received[recipient] || [])
    .map((s) => {
      try {
        return JSON.parse(s);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);

  const ok =
    msgs.length === goodSeqs.length + 1 &&
    goodSeqs.every((seq, i) => msgs[i] && msgs[i].seq === seq && msgs[i].type !== 'replay_corrupt') &&
    !!msgs[goodSeqs.length] &&
    msgs[goodSeqs.length].type === 'replay_corrupt' &&
    msgs[goodSeqs.length].seq === corruptSeq &&
    !msgs.some((mm) => mm.seq === withheldSeq && mm.type !== 'replay_corrupt');

  return {
    passed: ok,
    reason: ok
      ? ''
      : `${recipient} received ${JSON.stringify(msgs)}, expected [${goodSeqs.join(',')}] then replay_corrupt seq=${corruptSeq}, seq=${withheldSeq} withheld`,
  };
}

function checkCapacityClaim(claim, scenario, received, errors, acceptedSessions) {
  // "Only first and third become sessions. The second gets a retryable busy
  // response and never receives application events."  This validates the
  // actual server-side admissions recorded during the run and the exact
  // structured reply seen by the rejected client.  It does not infer either
  // fact from the prose alone.
  const busy = claim.match(/only\s+([\w-]+)\s+and\s+([\w-]+)\s+become\s+sessions?\.\s*the\s+([\w-]+)\s+gets?\s+a\s+retryable\s+busy\s+response\s+and\s+never\s+receives\s+application\s+events/i);
  if (busy) {
    const [, firstAccepted, secondAccepted, rejected] = busy;
    const expectedAccepted = [firstAccepted, secondAccepted];
    const reply = (received[rejected] || [])
      .map((raw) => {
        try {
          return JSON.parse(raw);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
    const admissionsMatch = arraysEqual(acceptedSessions || [], expectedAccepted);
    const onlyBusyReply = reply.length === 1 && reply[0].status === 'busy' && reply[0].retryable === true;
    const namesMatch = scenario.names.includes(firstAccepted) && scenario.names.includes(secondAccepted) && scenario.names.includes(rejected);
    const ok = admissionsMatch && onlyBusyReply && namesMatch;
    return {
      passed: ok,
      reason: ok
        ? ''
        : `accepted=${JSON.stringify(acceptedSessions || [])}, ${rejected} received=${JSON.stringify(reply)}, claimed accepted=${JSON.stringify(expectedAccepted)}`,
    };
  }

  if (/not actually enforced|all 3 clients connect successfully/i.test(claim)) {
    const ok = !errors['client3'];
    return { passed: ok, reason: ok ? '' : `client3 errors=${JSON.stringify(errors['client3'] || null)}` };
  }
  if (/rejected|closes immediately/i.test(claim)) {
    const ok = !!errors['client3'] && !errors['client1'] && !errors['client2'];
    return { passed: ok, reason: ok ? '' : `errors=${JSON.stringify(errors)}` };
  }
  return null;
}

/**
 * `asker` defaults to 'A' to match parseConnCountScenario's own fixed
 * 2-client shape (the only shape this checker recognized before
 * parseConnCountThreeClientScenario existed) -- a caller using the newer
 * 3-client shape passes its own scenario.asker instead of relying on the
 * hardcoded name.
 */
function checkConnCountClaim(claim, received, asker) {
  const who = asker || 'A';
  // "<asker> receives {count: N}, ..." -- this dataset's own way of writing
  // the literal reply payload, confirmed missing: the only previously
  // recognized shape was the bare "count=N." sentence below, and a row
  // phrasing the same fact around the real JSON payload (this file's own
  // quoting/braces convention for message content elsewhere) had no
  // matching claim checker despite its scenario parsing and running fine.
  // The claim's own named asker must actually BE the real scenario's asker
  // before the count comparison means anything -- same named-entity
  // validation discipline as checkPrivateRoutingClaim/
  // checkPrivateRoutingUnknownRecipientClaim.
  let m = claim.match(/(\w+)\s+receives\s*\{count:\s*(\d+)\}/i);
  if (m) {
    if (m[1] !== who) {
      return { passed: false, reason: `claim names ${m[1]} as receiving the count, but the real scenario has ${who} sending the get_count request` };
    }
    return checkConnCountAgainst(Number(m[2]), received, who);
  }
  m = claim.match(/count=(\d+)/i);
  if (!m) return null;
  return checkConnCountAgainst(Number(m[1]), received, who);
}

function checkExplicitConnCountClaim(claim, received, askers) {
  const assertions = [...String(claim).matchAll(/([\w-]+)\s+receives\s+connections?=(\d+)(?:\s+then\s+connections?=(\d+))?/gi)];
  if (!assertions.length) return null;
  const expectedByAsker = new Map();
  for (const assertion of assertions) {
    const values = [Number(assertion[2]), ...(assertion[3] ? [Number(assertion[3])] : [])];
    expectedByAsker.set(assertion[1], values);
  }
  const asked = new Set(askers || []);
  // A count query is an observable action. Requiring an assertion for every
  // asker prevents a partial claim from silently ignoring a later query in
  // the same scenario; each asserted list is then compared exactly against
  // that client's real replies, in order.
  const allAskersClaimed = [...asked].every((name) => expectedByAsker.has(name));
  const ok = allAskersClaimed && [...expectedByAsker.entries()].every(([name, expected]) => {
    if (!asked.has(name)) return false;
    const actual = (received[name] || [])
      .map((raw) => {
        try {
          const parsed = JSON.parse(raw);
          return typeof parsed.count === 'number' ? parsed.count : null;
        } catch (e) {
          return null;
        }
      })
      .filter((value) => value !== null);
    return arraysEqual(actual, expected);
  });
  return { passed: ok, reason: ok ? '' : `count assertions=${JSON.stringify([...expectedByAsker])}, received=${JSON.stringify(received)}` };
}

function checkConnCountAgainst(expected, received, who) {
  const msgs = received[who] || [];
  let actual = null;
  for (const s of msgs) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o.count === 'number') actual = o.count;
    } catch (e) {
      /* skip */
    }
  }
  const ok = actual === expected;
  return { passed: ok, reason: ok ? '' : `${who} received ${JSON.stringify(msgs)}, parsed count=${actual}, expected ${expected}` };
}

// ------------------------------------------------------------ python codegen ---

const PY_PRELUDE = [
  'import asyncio, json, sys',
  'import websockets',
  '',
  'CLIENTS = set()',
  'NAME_TO_WS = {}',
  'WS_TO_NAME = {}',
  'PRIVATE_REGISTRY = NAME_TO_WS',
  'ROOMS = {}',
  'APPLIED_VALUES = []',
  'HISTORY = []',
  'LIVE = set()',
  'CONN_COUNT = 0',
  'CAP_CLIENTS = set()',
  // Append on admission instead of inspecting CAP_CLIENTS at the end of the
  // run, because normal cleanup intentionally empties that live set before
  // @@OUT is produced.
  'CAP_ACCEPTED = []',
  // Keyed by registered name (survives disconnect -- NAME_TO_WS does not),
  // bounded per-name to FLAGS.bufferMax with oldest-drop eviction, flushed
  // oldest-first the moment that name re-identifies on any connection. See
  // private_routing_handler below and this file's module docstring.
  'PRIVATE_BUFFERS = {}',
  // A SEPARATE per-topic history/live-set/counter, deliberately never
  // sharing HISTORY/LIVE/seed_emit above -- those stay exactly as they were
  // for the single-global-stream seq_replay shape a plain last_seen_seq_id
  // reconnect still uses. Keyed by topic name so each topic's own seq
  // counter is genuinely independent (topic_seed_emit reads/writes only
  // TOPIC_SEQ[topic]), not a shared counter that different topics'
  // messages would otherwise silently interleave into. See
  // seq_replay_handler below and this file's module docstring.
  'TOPIC_HISTORY = {}',
  'TOPIC_LIVE = {}',
  'TOPIC_SEQ = {}',
  '',
  'async def identify(ws):',
  '    try:',
  '        raw = await asyncio.wait_for(ws.recv(), timeout=5)',
  '        data = json.loads(raw)',
  '        name = data.get("__id__") if isinstance(data, dict) else None',
  '    except Exception:',
  '        name = None',
  '    if name:',
  '        NAME_TO_WS[name] = ws',
  '        WS_TO_NAME[ws] = name',
  '    return name',
  '',
  'async def seed_emit(payload, sender=None, corrupt=False):',
  '    seq = len(HISTORY) + 1',
  '    HISTORY.append({"seq": seq, "payload": payload, "sender": sender, "corrupt": corrupt})',
  '    for c in list(LIVE):',
  '        try:',
  '            await c.send(json.dumps({"seq": seq, "value": payload}))',
  '        except Exception:',
  '            LIVE.discard(c)',
  '',
  'async def topic_seed_emit(topic, payload):',
  '    seq = TOPIC_SEQ.get(topic, 0) + 1',
  '    TOPIC_SEQ[topic] = seq',
  '    TOPIC_HISTORY.setdefault(topic, []).append({"seq": seq, "payload": payload})',
  '    for c in list(TOPIC_LIVE.get(topic, set())):',
  '        try:',
  '            await c.send(json.dumps({"topic": topic, "seq": seq, "value": payload}))',
  '        except Exception:',
  '            TOPIC_LIVE[topic].discard(c)',
  '',
  'async def broadcast_handler(ws, *_a):',
  '    await identify(ws)',
  '    CLIENTS.add(ws)',
  '    try:',
  '        async for msg in ws:',
  '            if FLAGS.get("jsonGuard"):',
  '                try:',
  '                    json.loads(msg)',
  '                except Exception:',
  '                    continue',
  '            targets = [c for c in CLIENTS if c is not ws] if FLAGS.get("excludeSender") else list(CLIENTS)',
  '            for c in targets:',
  '                if FLAGS.get("guardSendErrors"):',
  '                    try:',
  '                        await c.send(msg)',
  '                    except websockets.exceptions.ConnectionClosed:',
  '                        CLIENTS.discard(c)',
  '                else:',
  '                    await c.send(msg)',
  '    finally:',
  '        CLIENTS.discard(ws)',
  '',
  'async def private_routing_handler(ws, *_a):',
  '    name = await identify(ws)',
  // Flushed on every (re)identify, not just an explicit "reconnect" action --
  // a client's first-ever registration can never have a pending buffer
  // (nothing addressed it before it existed), so this is unconditionally
  // safe to run for a brand-new name too, not just a genuine reconnect.
  '    if name is not None:',
  '        buffered = PRIVATE_BUFFERS.pop(name, None)',
  '        if buffered:',
  '            for item in buffered:',
  '                await ws.send(json.dumps(item))',
  '    try:',
  '        async for msg in ws:',
  '            try:',
  '                data = json.loads(msg)',
  '            except Exception:',
  '                continue',
  '            if isinstance(data, dict) and "to" in data:',
  '                target_name = data["to"]',
  '                target = NAME_TO_WS.get(target_name)',
  '                payload = {"from": name, "text": data.get("text")}',
  '                if target is not None:',
  '                    await target.send(json.dumps(payload))',
  '                elif FLAGS.get("unknownRecipientError"):',
  // A THIRD real private_routing shape (see privateRoutingUnknownRecipient
  // in the JS above and this file's module docstring): the sender is told
  // immediately, by an explicit error reply, that the recipient is not
  // reachable, instead of the message being buffered for a later
  // reconnect. Only reachable when the row's own server_implementation
  // text described exactly this idea -- every existing row leaves this
  // flag False and takes the unchanged buffering `else` branch below,
  // so this is additive, never a replacement for it.
  '                    await ws.send(json.dumps({"error": "unknown_recipient", "to": target_name}))',
  '                else:',
  // Bounded, oldest-drop -- matches this file's own documented capacity_limit
  // convention (a fixed ceiling read from FLAGS, defaulting to 2) rather than
  // an unbounded queue. A target that never re-identifies during this test
  // run leaves its buffer entry unread, which is observationally identical
  // to the pre-fix "silently dropped" behavior for any claim that only
  // checks who received what -- this is a strict superset, not a
  // replacement, of the old stateless-routing behavior.
  '                    buf = PRIVATE_BUFFERS.setdefault(target_name, [])',
  '                    buf.append(payload)',
  '                    if len(buf) > FLAGS.get("bufferMax", 2):',
  '                        buf.pop(0)',
  '    finally:',
  '        for k in list(NAME_TO_WS):',
  '            if NAME_TO_WS[k] is ws:',
  '                del NAME_TO_WS[k]',
  '',
  'async def room_handler(ws, *_a):',
  '    await identify(ws)',
  '    try:',
  '        async for msg in ws:',
  '            try:',
  '                data = json.loads(msg)',
  '            except Exception:',
  '                data = None',
  '            if isinstance(data, dict) and data.get("type") == "join":',
  '                ROOMS[ws] = data.get("room")',
  '            else:',
  '                room = ROOMS.get(ws)',
  '                for other_ws, other_room in list(ROOMS.items()):',
  '                    if other_room == room:',
  '                        await other_ws.send(msg)',
  '    finally:',
  '        ROOMS.pop(ws, None)',
  '',
  'async def dedup_handler(ws, *_a):',
  '    await identify(ws)',
  '    processed = set()',
  '    async for msg in ws:',
  '        try:',
  '            data = json.loads(msg)',
  '        except Exception:',
  '            continue',
  '        seq = data.get("seq")',
  '        value = data.get("value")',
  '        if seq not in processed:',
  '            processed.add(seq)',
  '            APPLIED_VALUES.append(value)',
  '        try:',
  '            await ws.send(json.dumps({"ack": seq}))',
  '        except Exception:',
  '            pass',
  '',
  'async def seq_replay_handler(ws, *_a):',
  '    name = await identify(ws)',
  '    first = True',
  '    try:',
  '        async for msg in ws:',
  '            try:',
  '                data = json.loads(msg)',
  '            except Exception:',
  '                data = None',
  '            if first and isinstance(data, dict) and "resubscribe" in data:',
  // Checked BEFORE the plain last_seen_seq_id branch: a resubscribe message
  // is a dict {topic: last_seen, ...} for potentially SEVERAL topics in
  // one reconnect, processed in the dict's own key order (Python dicts
  // preserve insertion order, which is the JSON object's own key order --
  // matching a row's own stated per-topic replay ordering rather than
  // interleaving strictly by global seq). Each topic's replay+resubscribe
  // is entirely independent of every other topic's TOPIC_HISTORY/TOPIC_SEQ
  // -- this is the actual "isolated per topic" behavior the plain
  // single-stream branch below has no way to express at all.
  '                for topic, last_seen in data["resubscribe"].items():',
  '                    for h in TOPIC_HISTORY.get(topic, []):',
  '                        if h["seq"] > last_seen:',
  '                            await ws.send(json.dumps({"topic": topic, "seq": h["seq"], "value": h["payload"]}))',
  '                    TOPIC_LIVE.setdefault(topic, set()).add(ws)',
  '            elif first and isinstance(data, dict) and "last_seen_seq_id" in data:',
  '                last_seen = data["last_seen_seq_id"]',
  // A corrupt entry (seed-time only -- see seed_emit's default-False
  // corrupt flag) halts replay at that entry instead of skipping over it:
  // every row with no corrupt entries at all takes the plain `else` branch
  // every time and this never fires, so this is additive to the loop below,
  // not a replacement for it. See this file's module docstring.
  '                for h in HISTORY:',
  '                    if h["seq"] > last_seen:',
  '                        if h.get("corrupt"):',
  '                            await ws.send(json.dumps({"type": "replay_corrupt", "seq": h["seq"]}))',
  '                            break',
  '                        await ws.send(json.dumps({"seq": h["seq"], "value": h["payload"]}))',
  '                LIVE.add(ws)',
  // A live send while already resubscribed to a topic. Only reachable
  // after the resubscribe branch above has run at least once for this ws
  // (first is False by then) -- the pre-existing single-stream `else`
  // clause below still owns every OTHER shape (plain single-stream sends,
  // and any non-dict/non-topic message), unchanged.
  '            elif isinstance(data, dict) and "topic" in data:',
  '                await topic_seed_emit(data["topic"], data.get("value"))',
  '            else:',
  '                await seed_emit(msg, sender=name)',
  '            first = False',
  '    finally:',
  '        LIVE.discard(ws)',
  '        for topic_set in TOPIC_LIVE.values():',
  '            topic_set.discard(ws)',
  '',
  'async def capacity_limit_handler(ws, *_a):',
  '    if len(CAP_CLIENTS) >= FLAGS.get("max", 2):',
  '        if FLAGS.get("busyReply"):',
  '            await ws.send(json.dumps({"status": "busy", "retryable": True}))',
  '        await ws.close(code=1013)',
  '        return',
  '    name = await identify(ws)',
  '    CAP_CLIENTS.add(ws)',
  '    CAP_ACCEPTED.append(name)',
  '    try:',
  '        async for msg in ws:',
  '            pass',
  '    finally:',
  '        CAP_CLIENTS.discard(ws)',
  '',
  'async def connection_count_handler(ws, *_a):',
  '    global CONN_COUNT',
  '    await identify(ws)',
  '    CONN_COUNT += 1',
  '    try:',
  '        async for msg in ws:',
  '            try:',
  '                data = json.loads(msg)',
  '            except Exception:',
  '                data = None',
  '            if isinstance(data, dict) and data.get("type") == "get_count":',
  '                await ws.send(json.dumps({"count": CONN_COUNT}))',
  '    finally:',
  '        CONN_COUNT -= 1',
  '',
  'HANDLERS = {',
  '    "broadcast": broadcast_handler,',
  '    "private_routing": private_routing_handler,',
  '    "room_isolation": room_handler,',
  '    "dedup_idempotent": dedup_handler,',
  '    "seq_replay": seq_replay_handler,',
  '    "capacity_limit": capacity_limit_handler,',
  '    "connection_count": connection_count_handler,',
  '}',
  '',
  'received = {}',
  'errors = {}',
  'reader_tasks = {}',
  '',
  'async def reader(name, ws):',
  '    try:',
  '        async for msg in ws:',
  '            received.setdefault(name, []).append(msg)',
  '    except Exception as e:',
  '        errors[name] = errors.get(name, "") + " reader:" + str(e)',
  '',
  'async def run_actions(uri):',
  '    conns = {}',
  '    for act in ACTIONS:',
  '        op = act["op"]',
  '        if op == "connect":',
  '            who = act["who"]',
  '            try:',
  '                ws = await websockets.connect(uri)',
  '                conns[who] = ws',
  '                received.setdefault(who, [])',
  '                try:',
  '                    await ws.send(json.dumps({"__id__": who}))',
  '                except Exception as e:',
  '                    errors[who] = errors.get(who, "") + " identify:" + str(e)',
  '                if not act.get("deferRead"):',
  '                    reader_tasks[who] = asyncio.create_task(reader(who, ws))',
  '            except Exception as e:',
  '                errors[who] = errors.get(who, "") + " connect:" + str(e)',
  '        elif op == "send":',
  '            who = act["who"]',
  '            ws = conns.get(who)',
  '            if ws is None:',
  '                errors[who] = errors.get(who, "") + " send-no-conn"',
  '                continue',
  '            try:',
  '                await ws.send(act["payload"])',
  '            except Exception as e:',
  '                errors[who] = errors.get(who, "") + " send:" + str(e)',
  '        elif op == "disconnect":',
  '            who = act["who"]',
  '            ws = conns.get(who)',
  '            if ws is not None:',
  '                try:',
  '                    await ws.close()',
  '                except Exception:',
  '                    pass',
  '        elif op == "sleep":',
  '            await asyncio.sleep(act["ms"] / 1000)',
  '        elif op == "recv":',
  '            who = act["who"]',
  '            ws = conns.get(who)',
  '            for _ in range(act.get("times", 1)):',
  '                try:',
  '                    msg = await asyncio.wait_for(ws.recv(), timeout=5)',
  '                    received.setdefault(who, []).append(msg)',
  '                except Exception as e:',
  '                    errors[who] = errors.get(who, "") + " recv:" + str(e)',
  '        elif op == "seed":',
  '            await seed_emit(act["payload"], corrupt=act.get("corrupt", False))',
  '        elif op == "seed_topic":',
  '            await topic_seed_emit(act["topic"], act["payload"])',
  '    await asyncio.sleep(0.2)',
  '    for name, task in list(reader_tasks.items()):',
  '        task.cancel()',
  '    for name, ws in conns.items():',
  '        try:',
  '            await ws.close()',
  '        except Exception:',
  '            pass',
  '    out = {',
  '        "received": received,',
  '        "errors": errors,',
  '        "history": HISTORY,',
  '        "applied_values": APPLIED_VALUES,',
  '        "accepted_sessions": CAP_ACCEPTED,',
  '    }',
  '    print("@@OUT " + json.dumps(out, default=str))',
  '',
  'async def main():',
  '    handler = HANDLERS[ARCHETYPE]',
  '    server = await websockets.serve(handler, "127.0.0.1", 0)',
  '    port = server.sockets[0].getsockname()[1]',
  '    uri = "ws://127.0.0.1:%d" % port',
  '    try:',
  '        await run_actions(uri)',
  '    finally:',
  '        server.close()',
  '        await server.wait_closed()',
].join('\n');

// ------------------------------------------------------------------ verify ---

module.exports = {
  contract: 'claim-vs-simulated-execution contradiction check',
  requires: ['python3'],

  verify(row, h) {
    const impl = h.str(row, 'server_implementation');
    const clientScript = h.str(row, 'client_script');
    const eventSeq = h.str(row, 'event_sequence');
    const connectionScenario = h.str(row, 'connection_scenario');
    const claim = h.str(row, 'expected_message_order_and_state');
    if (!impl || !clientScript || !eventSeq || !claim) {
      return { passed: false, detail: { reason: 'missing server_implementation, client_script, event_sequence or expected_message_order_and_state' } };
    }

    const archetype = classifyArchetype(impl, connectionScenario);
    const flags = { excludeSender: false, guardSendErrors: false, jsonGuard: false, max: 2, bufferMax: 2, unknownRecipientError: false, busyReply: false };
    if (archetype === 'broadcast') Object.assign(flags, broadcastFlags(impl));
    if (archetype === 'capacity_limit') {
      flags.max = capacityMax(impl);
      flags.busyReply = capacityBusyReply(impl);
    }
    if (archetype === 'private_routing') {
      flags.bufferMax = privateBufferMax(impl);
      flags.unknownRecipientError = privateRoutingUnknownRecipient(impl);
    }

    let scenario = null;
    if (archetype === 'broadcast') scenario = parseBroadcastScenario(clientScript, eventSeq);
    // Tried in this order because the buffer-scenario regexes are strictly
    // more specific (require "disconnect"+"while offline"+"reconnect") --
    // the plain single-message parser would otherwise never even get a
    // chance to run its own, unrelated shape check first.
    else if (archetype === 'private_routing') scenario = parsePrivateRoutingBufferScenario(eventSeq, clientScript) || parsePrivateRoutingScenario(eventSeq) || parseExplicitPrivateRoutingScenario(eventSeq);
    else if (archetype === 'room_isolation') scenario = parseRoomScenario(eventSeq);
    else if (archetype === 'dedup_idempotent') scenario = parseDedupScenario(eventSeq);
    else if (archetype === 'seq_replay')
      scenario =
        parseSeqReplayTopicScenario(eventSeq, clientScript) ||
        parseSeqReplayCorruptScenario(eventSeq, clientScript) ||
        parseSeqReplayScenario(eventSeq, clientScript);
    else if (archetype === 'capacity_limit') scenario = parseExplicitCapacityScenario(eventSeq) || parseCapacityScenario();
    // Tried in this order for the same reason as private_routing above: the
    // 3-client shape's regex is strictly more specific (three connects, a
    // disconnect of the middle one, then a send by the first), so the
    // fixed-A/B parser would otherwise always win first and never let this
    // shape's own scenario (with its own real client names) run instead.
    else if (archetype === 'connection_count') scenario = parseExplicitConnCountScenario(eventSeq) || parseConnCountThreeClientScenario(eventSeq) || parseConnCountScenario(eventSeq);

    if (!scenario) {
      return { passed: false, logs: `could not parse a scenario for archetype "${archetype}" from event_sequence: ${eventSeq.slice(0, 200)}`, detail: { archetype } };
    }

    if (!h.have('python3')) return { passed: false, runtimeUnavailable: true, logs: 'python3 unavailable', detail: { runtime: 'python3' } };
    // From the verified image only — no runtime install (no-network sandbox).
    // Explicit timeoutMs: an unspecified opts.timeoutMs falls back to
    // helpers.js's own 25000ms default, which summed with the main run
    // below's timeout comfortably exceeded the outer sandbox command
    // budget deployed at the time (30000ms; raised to 120000ms as of the
    // current deploy, infra/terraform/ssm.tf's
    // EXECUTION_RUNNER_TIMEOUT_MS) -- the same class of gap already found
    // and fixed for web_scraping's analogous import-probe calls.
    const wsOk = h.run('python3', ['-c', 'import websockets'], { timeoutMs: 3000 }).status === 0;
    if (!wsOk) return { passed: false, runtimeUnavailable: true, logs: 'websockets unavailable in this sandbox image', detail: { runtime: 'websockets' } };

    const SPEC = { archetype, flags, actions: scenario.actions };

    const d = h.workdir();
    // PY_PRELUDE defines main()/handlers but does not call anything -- the
    // SPEC/ARCHETYPE/FLAGS/ACTIONS globals it references must exist BEFORE
    // asyncio.run(main()) executes, so they are assigned here and the actual
    // run call is appended last.
    const scriptLines = [
      PY_PRELUDE,
      '',
      'SPEC = json.loads(' + JSON.stringify(JSON.stringify(SPEC)) + ')',
      'ARCHETYPE = SPEC["archetype"]',
      'FLAGS = SPEC["flags"]',
      'ACTIONS = SPEC["actions"]',
      '',
      'asyncio.run(main())',
    ];
    h.fs.writeFileSync(h.path.join(d, 'run_ws.py'), scriptLines.join('\n'));

    const r = h.run('python3', [h.path.join(d, 'run_ws.py')], { cwd: d, timeoutMs: 12000 });
    if (r.status !== 0) {
      return { passed: false, logs: 'harness script crashed: ' + String(r.stderr).slice(0, 1500), detail: { ranClean: false, archetype, scenario } };
    }
    const outRaw = h.lastMarked(String(r.stdout), '@@OUT ');
    if (outRaw === null) {
      return { passed: false, logs: 'no @@OUT marker in script output', detail: { stdout: String(r.stdout).slice(0, 500), stderr: String(r.stderr).slice(0, 500) } };
    }
    const out = h.jsonOf(outRaw);
    if (out === null) {
      return { passed: false, logs: 'could not parse harness script output', detail: { outRaw: outRaw.slice(0, 500) } };
    }

    const received = out.received || {};
    const errors = out.errors || {};
    const history = out.history || [];
    const appliedValues = out.applied_values || [];
    const acceptedSessions = out.accepted_sessions || [];

    let result = null;
    if (archetype === 'broadcast') {
      result = checkBroadcastClaim(claim, scenario.names, received, errors);
    } else if (archetype === 'private_routing') {
      // scenario.bufferedMsgs only exists on the buffer-scenario shape
      // (parsePrivateRoutingBufferScenario) -- the plain shape's own
      // scenario.to/scenario.nonTarget have no meaning for this claim shape
      // and vice versa, so the scenario's own shape decides which checker
      // runs, not a second independent text sniff of the claim. The
      // unknown-recipient-error shape reuses the PLAIN scenario's own
      // to/sender/nonTarget fields (it is a real behavior of the same
      // stateless routing path, just a different server reply on a miss),
      // gated on FLAGS.unknownRecipientError -- the row's own
      // server_implementation text, not the scenario shape -- since nothing
      // about parsePrivateRoutingScenario's output distinguishes the two.
      result = scenario.bufferedMsgs
        ? checkPrivateRoutingBufferClaim(claim, received)
        : scenario.routes
          ? checkExplicitPrivateRoutingClaim(claim, scenario.routes, received)
        : flags.unknownRecipientError
          ? checkPrivateRoutingUnknownRecipientClaim(claim, scenario.sender, scenario.nonTarget, scenario.to, received)
          : checkPrivateRoutingClaim(claim, scenario.to, scenario.nonTarget, received);
    } else if (archetype === 'room_isolation') {
      result = checkRoomClaim(claim, scenario.names, received, scenario);
    } else if (archetype === 'dedup_idempotent') {
      result = checkDedupClaim(claim, appliedValues, scenario);
    } else if (archetype === 'seq_replay') {
      // scenario.topics/scenario.corruptItems only exist on their own shape
      // (parseSeqReplayTopicScenario / parseSeqReplayCorruptScenario) --
      // extractSeqs/history below have no meaning for either (topic_seed_emit's
      // TOPIC_HISTORY and the corrupt shape's replay_corrupt marker are not
      // seq lists), so the scenario's own shape decides which checker runs
      // here too, same as the private_routing dispatch above.
      if (scenario.topics) {
        result = checkSeqReplayTopicClaim(claim, scenario.subscriber, scenario.topics, scenario.liveCounts, scenario.offlineCounts, scenario.lastSeen, received);
      } else if (scenario.corruptItems) {
        result = checkSeqReplayCorruptClaim(claim, received);
      } else {
        const receivedSeqsByName = {};
        for (const n of scenario.names) receivedSeqsByName[n] = extractSeqs(received[n]);
        result = checkSeqReplayClaim(claim, scenario.names, history, receivedSeqsByName);
      }
    } else if (archetype === 'capacity_limit') {
      result = checkCapacityClaim(claim, scenario, received, errors, acceptedSessions);
    } else if (archetype === 'connection_count') {
      result = scenario.askers
        ? checkExplicitConnCountClaim(claim, received, scenario.askers)
        : checkConnCountClaim(claim, received, scenario.asker);
    }

    if (result === null) {
      return {
        passed: false,
        logs: `could not parse expected_message_order_and_state into a checkable claim for archetype "${archetype}": ${claim.slice(0, 200)}`,
        detail: { archetype, received, errors, history, appliedValues },
      };
    }

    return {
      passed: result.passed,
      logs: result.passed ? '' : result.reason,
      detail: { archetype, flags, scenarioNames: scenario.names, received, errors, history, appliedValues, acceptedSessions },
    };
  },
};
