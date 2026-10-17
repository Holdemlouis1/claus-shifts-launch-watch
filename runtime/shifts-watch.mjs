// Claus Shifts watcher: a managed-runtime worker on the Claus Network.
// Each cycle receives {state, observation, cycle} and returns {state, action?}.
// It never throws, never holds keys, and treats any failed read as "could not check".
// Source: public, MIT. Community build, not made by Claus. Revision 4: adds the Launch Watch server bridge
// (dormant while SERVER is empty): read the server's /bridge.json, then copy one alert or one checkpoint page into public records.

const PID = "prj_fe5de2f5-b5b2-478c-a1e7-79b97fe99aa4";
const BS = "https://eth.blockscout.com/api/v2/addresses/";
const SRC = {
  module: { addr: "0xea0436465676eA7001535Bfe2E5cbd4b137b7f91", topic: "0x6af262ca96275dc40852dc5ae38406689d6f49c801c16c17cb6c84f103052fc3" }, // ModuleChanged on TradeExtensionHost
  owner: { addr: "0x1b54E762aa34CF6E28E9C082F2848e28E45DA6b8", topic: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0" } // OwnershipTransferred on the CLAUS token
};
const ZERO = "0x0000000000000000000000000000000000000000";
// Launch Watch server base URL (https, no trailing slash). Empty = bridge off, and the plan is exactly revision 3's.
const SERVER = "";
const MAXI = 99999999999;

const int = (v, d = 0) => { const n = Math.floor(Number(v)); return Number.isSafeInteger(n) && n >= 0 && n <= MAXI ? n : d; };
const addr = (v, d = ZERO) => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : d);
const short = a => a.slice(0, 6) + "…" + a.slice(-4);
const cut = (s, n) => String(s).slice(0, n);
const topicAddr = t => (typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t) ? "0x" + t.slice(-40).toLowerCase() : ZERO);

export function initial() {
  return { v: 1, i: 0, round: 0, wait: "", from: { module: 26201254, owner: 26197789 }, cur: { module: "0x3dc1183ff95889359e00987b55d9164aad306762", owner: "0xbb145ca83272c3806d4ddc75ca1d5514789cf1c5" }, chk: { module: { at: 0, ok: false, n: 0 }, owner: { at: 0, ok: false, n: 0 } }, out: [], sid: "", srev: 0, seen: [], cards: 0, lastCardAt: 0, note: "", br: { after: "", page: 0, pages: 1, ok: 0, fail: 0, at: 0, copied: 0 }, next: null };
}

function clean(s) {
  const b = initial();
  if (!s || typeof s !== "object" || s.v !== 1) return b;
  return {
    v: 1, i: int(s.i), round: int(s.round), wait: typeof s.wait === "string" ? s.wait : "",
    from: { module: int(s.from && s.from.module, b.from.module), owner: int(s.from && s.from.owner, b.from.owner) },
    cur: { module: addr(s.cur && s.cur.module, b.cur.module), owner: addr(s.cur && s.cur.owner, b.cur.owner) },
    chk: { module: chkOf(s.chk && s.chk.module), owner: chkOf(s.chk && s.chk.owner) },
    out: Array.isArray(s.out) ? s.out.slice(0, 6) : [], sid: typeof s.sid === "string" ? s.sid : "", srev: int(s.srev),
    seen: Array.isArray(s.seen) ? s.seen.filter(x => typeof x === "string").slice(-30) : [], cards: int(s.cards), lastCardAt: int(s.lastCardAt), note: cut(s.note || "", 200),
    br: brOf(s.br), next: nextOf(s.next)
  };
}
function brOf(b) { b = b && typeof b === "object" ? b : {}; return { after: typeof b.after === "string" && /^[0-9a-z:]{0,80}$/.test(b.after) ? b.after : "", page: int(b.page), pages: Math.max(1, Math.min(int(b.pages, 1), 20)), ok: int(b.ok), fail: int(b.fail), at: int(b.at), copied: int(b.copied) }; }
// A queued copy survives exactly one step (the step after the read). Only the two bridge collections are allowed.
function nextOf(n) { return n && typeof n === "object" && (n.c === "alerts" || n.c === "watchstate") && n.d && typeof n.d === "object" && typeof n.k === "string" && JSON.stringify(n.d).length < 4000 ? { c: n.c, d: n.d, k: cut(n.k, 80) } : null; }
// Older state has no attempt count: a check that has a timestamp or succeeded has been tried at least once.
function chkOf(c) { const at = int(c && c.at), ok = !!(c && c.ok); return { at, ok, n: int(c && c.n, at || ok ? 1 : 0) }; }
function mark(s, w, ok, at) { s.chk[w] = { at: ok ? (at || s.chk[w].at) : s.chk[w].at, ok, n: Math.min(s.chk[w].n + 1, MAXI) }; }

// Pull log entries out of a Blockscout v2 response, even when the 4,000-character cap truncated it.
export function parseLogs(text) {
  let items = null;
  try { const j = JSON.parse(text); if (j && Array.isArray(j.items)) items = j.items; } catch (e) {}
  if (items) return { ok: true, partial: false, logs: items.map(x => ({ block: int(x.block_number), ts: Math.floor(Date.parse(x.block_timestamp) / 1000) || 0, topics: Array.isArray(x.topics) ? x.topics : [], tx: String(x.transaction_hash || "") })) };
  const logs = [];
  const re = /"block_number":(\d+),"block_timestamp":"([^"]+)"[\s\S]*?"topics":\[([^\]]*)\][\s\S]*?"transaction_hash":"(0x[0-9a-fA-F]{64})"/g;
  let m;
  while ((m = re.exec(text))) logs.push({ block: int(m[1]), ts: Math.floor(Date.parse(m[2]) / 1000) || 0, topics: (m[3].match(/0x[0-9a-fA-F]{64}|null/g) || []), tx: m[4] });
  return { ok: logs.length > 0 && /^\{"items":\[/.test(text), partial: true, logs };
}

function cardFor(kind, log) {
  const from = topicAddr(log.topics[1]), to = topicAddr(log.topics[2]);
  let title, line;
  if (kind === "module") {
    title = to === ZERO ? "Hook program switched off" : "New hook program " + short(to);
    line = to === ZERO
      ? "The token owner removed the hook's program (was " + short(from) + "). Trades no longer run extra program logic."
      : "The token owner switched the hook's program from " + (from === ZERO ? "none" : short(from)) + " to " + short(to) + ". Not reviewed yet: open the code link to see what it does.";
  } else {
    title = to === ZERO ? "Token ownership renounced" : "Token owner changed";
    line = to === ZERO
      ? "Ownership of the CLAUS token was renounced by " + short(from) + ". No one can install new hook programs now."
      : "Ownership of the CLAUS token moved from " + short(from) + " to " + short(to) + ". The owner is the wallet that can install hook programs.";
  }
  return { kind: kind === "module" ? "program" : "owner", tx: cut(log.tx.toLowerCase(), 66), block: int(log.block), at: int(log.ts), from, to, title: cut(title, 80), line: cut(line, 400), by: "watcher" };
}

function handle(s, obs) {
  const w = s.wait;
  s.wait = "";
  if (!w || !obs) return;
  if (obs.error) { if (w === "module" || w === "owner") mark(s, w, false); if (w === "bridge") s.br.fail++; if (w === "copy") s.next = null; s.note = cut("last error: " + obs.error, 200); return; }
  const r = obs.result || {};
  if (w === "module" || w === "owner") {
    const at = int(Math.floor(Number(r.observedAt) / 1000), 0);
    if (int(r.status) !== 200 || typeof r.text !== "string") { mark(s, w, false); s.note = cut(w + " check failed: HTTP " + int(r.status), 200); return; }
    const p = parseLogs(r.text);
    if (!p.ok && !(p.logs.length === 0 && /^\{"items":\[\]/.test(r.text)) && !(p.logs.length === 0 && /^\{"items":\[\{/.test(r.text) && r.truncated)) { mark(s, w, false); s.note = cut(w + " check failed: unreadable response", 200); return; }
    const fresh = p.logs.filter(l => l.block >= s.from[w] && l.block < 1e10 && typeof l.topics[0] === "string" && l.topics[0].toLowerCase() === SRC[w].topic && /^0x[0-9a-fA-F]{64}$/.test(l.tx) && !s.seen.includes(l.tx.toLowerCase())).sort((a, b) => a.block - b.block);
    for (const l of fresh) {
      if (s.out.length < 6) s.out.push(cardFor(w, l));
      s.seen.push(l.tx.toLowerCase());
      s.from[w] = Math.max(s.from[w], l.block + 1);
      s.cur[w] = topicAddr(l.topics[2]);
    }
    s.seen = s.seen.slice(-30);
    mark(s, w, true, at);
    s.note = p.partial && fresh.length ? "response was truncated; older changes may be missing" : "";
    return;
  }
  if (w === "card") { if (r && r.id) { const c = s.out.shift(); s.cards++; s.lastCardAt = Math.max(s.lastCardAt, int(c && c.at)); } return; }
  if (w === "status") { /* create-only: nothing to track */ }
  if (w === "bridge") {
    const r2 = obs.result || {};
    let j = null; try { j = int(r2.status) === 200 && typeof r2.text === "string" && !r2.truncated ? JSON.parse(r2.text) : null; } catch (e) { j = null; }
    s.br.at = int(Math.floor(Number(r2.observedAt) / 1000), s.br.at);
    if (!j || typeof j !== "object") { s.br.fail++; s.note = cut("bridge read failed: HTTP " + int(r2.status), 200); return; }
    s.br.ok++;
    const a = j.alert, cp = j.checkpoint;
    if (a && typeof a === "object" && typeof a.key === "string" && /^[0-9a-z:]{1,80}$/.test(a.key) && a.key > s.br.after) {
      s.next = nextOf({ c: "alerts", k: a.key, d: { kind: cut(a.kind, 16), token: addr(a.token), symbol: cut(a.symbol || "", 16), poolId: cut(a.poolId || "", 66), line: cut(a.line || "", 300), tx: cut(a.tx || "", 66), block: int(a.block), at: int(a.at) } });
    } else if (cp && typeof cp === "object" && Array.isArray(cp.pools) && Number.isInteger(cp.lastBlock)) {
      s.br.pages = Math.max(1, Math.min(int(cp.pages, 1), 20));
      s.next = nextOf({ c: "watchstate", k: "p" + int(cp.page), d: { v: 1, lastBlock: int(cp.lastBlock), lastAt: int(cp.lastAt), cycles: int(cp.cycles), page: int(cp.page), pages: s.br.pages,
        pools: cp.pools.filter(x => typeof x === "string").slice(0, 12).map(x => cut(x, 260)), gaps: (Array.isArray(cp.gaps) ? cp.gaps : []).filter(x => typeof x === "string").slice(0, 8).map(x => cut(x, 60)) } });
    }
    return;
  }
  if (w === "copy") {
    const c = s.next; s.next = null;
    if (!(r && r.id) || !c) return;
    s.br.copied++;
    if (c.c === "alerts") s.br.after = c.k; else s.br.page = (s.br.page + 1) % s.br.pages;
    return;
  }
}

// green: every check that has run succeeded and nothing changed in the last day.
// amber: a check failed (could not check, will retry) or a program/owner change was carded in the last day.
// grey is never written here: readers show grey when the newest check-in is too old.
export function light(s) {
  const at = Math.max(s.chk.module.at, s.chk.owner.at);
  const failed = ["module", "owner"].filter(k => s.chk[k].n > 0 && !s.chk[k].ok).map(k => k === "module" ? "programs" : "owner");
  const recent = s.lastCardAt > 0 && at - s.lastCardAt < 86400;
  if (failed.length) return { light: "amber", reason: cut("Could not check " + failed.join(" and ") + " on the last try (rate limit or timeout); retrying next cycle.", 160), couldNotCheck: failed };
  if (recent) return { light: "amber", reason: "A hook program or owner change was recorded in the last 24 hours. See cards.", couldNotCheck: [] };
  return { light: "green", reason: s.chk.owner.n ? "Programs and owner checked; nothing new." : "Programs checked; first owner check pending.", couldNotCheck: [] };
}

function statusData(s, cycle) {
  const at = Math.max(s.chk.module.at, s.chk.owner.at);
  return { at, round: s.round, cycle: int(cycle), moduleAt: s.chk.module.at, moduleOk: s.chk.module.ok, ownerAt: s.chk.owner.at, ownerOk: s.chk.owner.ok, module: s.cur.module, owner: s.cur.owner, cards: s.cards, note: cut(s.note, 200), ...light(s) };
}

export function next(s, cycle) {
  if (s.out.length) { s.wait = "card"; return { operation: "app_record_create", input: { projectId: PID, collection: "cards", data: s.out[0] } }; }
  if (s.next) { s.wait = "copy"; return { operation: "app_record_create", input: { projectId: PID, collection: s.next.c, data: s.next.d } }; }
  // Revision 3 plan, one round = 6 cycles (~7.5 h): programs every 2, owner every 6, a status check-in every 3.
  // With the bridge on, a bridge read replaces one program check and one status check-in per round.
  const plan = SERVER ? ["module", "bridge", "module", "owner", "bridge", "status"] : ["module", "status", "module", "owner", "module", "status"];
  const k = plan[Math.min(s.i, plan.length - 1)];
  s.i++;
  if (s.i >= plan.length) { s.i = 0; s.round++; }
  if (k === "status") {
    s.wait = "status";
    return { operation: "app_record_create", input: { projectId: PID, collection: "status", data: statusData(s, cycle) } };
  }
  s.wait = k;
  if (k === "bridge") return { operation: "project_web_read", input: { url: SERVER + "/bridge.json?after=" + encodeURIComponent(s.br.after) + "&page=" + s.br.page } };
  return { operation: "project_web_read", input: { url: BS + SRC[k].addr + "/logs?topic=" + SRC[k].topic } };
}

export default async function step(input) {
  let s;
  try {
    s = clean(input && input.state);
    handle(s, input && input.observation);
    const action = next(s, input && input.cycle);
    return { state: s, action };
  } catch (e) {
    // Never fail the VM: keep the last good state and skip this cycle.
    return { state: s || clean(input && input.state) };
  }
}
