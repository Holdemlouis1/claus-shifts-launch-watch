// Claus Shifts · Launch Watch server entry point. MIT.
// HTTP mode, port 8080, health at /health. Public read-only endpoints:
//   /health          liveness + how far behind the chain head the watcher is
//   /checkpoint.json?page=N  compact state in pages (each under 4,000 characters) that Claus Shifts' runtime copies into public records
//   /state.json      pools, recent alerts, gaps, recent X-rays and RPC call counts
//   /coverage.json   one coverage report per pool (closed windows first)
//   /bridge.json?after=KEY&page=N  what Claus Shifts' runtime copies next: the oldest alert after KEY, else checkpoint page N
// No request ever changes state. Nothing here holds a key, signs, or writes to the network.
import http from 'node:http';
import { C, makeRpc, emptyState, restore, checkpoint, cycle, coverage, bridge } from './watch.mjs';

const PORT = 8080;
const INTERVAL_MS = 5 * 60 * 1000;
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://gateway.tenderly.co/public/mainnet']; // keyless public endpoints; Tenderly also serves full log history for catch-up after an outage
const CHECKPOINTS = 'https://claus-network-api.vercel.app/v1/public/apps/prj_fe5de2f5-b5b2-478c-a1e7-79b97fe99aa4/records?collection=watchstate&limit=100';
// Only Claus Shifts' own managed runtime (one of its nine slot principals) may supply a checkpoint.
const WRITERS = new Set(['runtime_26f2ea55e7956c83237e03b3f53386ee37b44da53bd7ce28ff1f13e78a96eb56', 'runtime_ed17cd2c1102a32befbbec6e223f1a3724bb837b9d145da92314eb10a1c994ba', 'runtime_305273810996bbc06e140c6017ec968669f663df4dba08f7d2dff2200be6d20a', 'runtime_d57813ed2ce98659227c5d64a7f72ddb2282d2f277fcc75239a1c76e8bc3c7f1', 'runtime_92f1f6b6198eb0d4f4abecd07f5dad4c06209136116a2c91fa208fe5c6dec007', 'runtime_b8db15e8aa3aac1fcffb67bcfcf9be5ba5fca982e34a012ddb9bb684b794eebd', 'runtime_1e06cb2d74ed635b0cf4ef9b9579db13ae64dff050cff675a073ddc4753f66e8', 'runtime_64c053e46cb2b5c8842d66aa94db7dcfd0b90b1c874b96ad93d0fd8514ad6eeb', 'runtime_9f763ad854c82ff6e9b297a71e4f6ab33abf8508492e42970bc68c94b64b684f']);

const counts = {};
const rpc = makeRpc(RPCS, fetch, counts);
const log = m => console.log(new Date().toISOString() + ' ' + m);
let s = null, boot = { at: Date.now(), from: 'unknown' }, lastCycle = null, running = false, okAt = 0;

// Restart: resume from the newest public checkpoint written by our runtime. Without one, start at the
// current head and say so: earlier blocks are a stated gap, never reported as checked.
async function start() {
  try {
    const r = await fetch(CHECKPOINTS, { signal: AbortSignal.timeout(15000) });
    const j = r.ok ? await r.json() : { items: [] };
    const pages = (j.items || []).filter(x => x && WRITERS.has(x.authorId) && x.data && Number.isInteger(x.data.lastBlock) && Array.isArray(x.data.pools)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(x => x.data);
    if (pages.length) { s = restore(pages); boot.from = 'checkpoint at block ' + s.lastBlock + ' (' + s.pools.length + ' pools)'; }
  } catch (e) { log('checkpoint read failed: ' + e.message); }
  if (!s) {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    s = emptyState(head);
    s.gaps.push({ kind: 'cold-start', from: 0, to: head });
    boot.from = 'cold start at block ' + head;
  }
  log('started from ' + boot.from);
}

async function tick() {
  if (running) return; running = true;
  try {
    // Catch up in bounded steps after an outage; each step is a normal cycle with its own coverage.
    for (let i = 0; i < 12; i++) { lastCycle = await cycle(rpc, s, log); okAt = Date.now(); if (lastCycle.idle || lastCycle.behind <= 0) break; }
  } catch (e) { log('cycle failed, will retry: ' + e.message); lastCycle = { error: e.message.slice(0, 200), at: Date.now() }; }
  finally { running = false; }
}

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
http.createServer((req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'read_only' });
  const path = req.url.split('?')[0];
  if (!s) return send(res, 503, { starting: true });
  // Healthy = alive and a successful cycle within the last hour. A single failed RPC round is not a reason to restart the service.
  if (path === '/health') { const stale = Date.now() - (okAt || boot.at) > 3600000; return send(res, stale ? 503 : 200, { ok: !stale, lastBlock: s.lastBlock, lastAt: s.lastAt, behind: lastCycle && lastCycle.behind, lastError: lastCycle && lastCycle.error || null, boot }); }
  if (path === '/checkpoint.json') { const page = Math.max(0, parseInt(new URL(req.url, 'http://x').searchParams.get('page') || '0', 10) || 0); return send(res, 200, checkpoint(s, page)); }
  if (path === '/bridge.json') { const q = new URL(req.url, 'http://x').searchParams; const after = /^[0-9a-z:]{0,80}$/.test(q.get('after') || '') ? q.get('after') || '' : ''; return send(res, 200, bridge(s, after, Math.max(0, parseInt(q.get('page') || '0', 10) || 0))); }
  if (path === '/state.json') return send(res, 200, { lastBlock: s.lastBlock, lastAt: s.lastAt, cycles: s.cycles, pools: s.pools, alerts: s.alerts, gaps: s.gaps, xrays: s.xrays, rpcCalls: counts, boot, spec: 'https://claus.si/c/claus-shifts/pages/launch-watch.html' });
  if (path === '/coverage.json') return send(res, 200, s.pools.slice().sort((a, b) => Number(b.closed) - Number(a.closed)).map(p => coverage(s, p)));
  send(res, 404, { error: 'not_found' });
}).listen(PORT, () => log('listening on ' + PORT));

await start();
await tick();
setInterval(tick, INTERVAL_MS);
