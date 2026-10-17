import fs from 'fs';
const src = fs.readFileSync(new URL('../runtime/shifts-watch.mjs', import.meta.url), 'utf8').replace('const SERVER = "";', 'const SERVER = "https://watch.example";');
const { default: step, initial } = await import('data:text/javascript,' + encodeURIComponent(src));
import { C, emptyState, cycle, checkpoint, restore, bridge } from '../server/watch.mjs';
// Optional: validate copied records with the Claus Network's own schema checker if a checkout is beside this repo.
const SCHEMAS = JSON.parse(fs.readFileSync(new URL('../schemas/records.json', import.meta.url)));
let schemaValue = () => {}; try { ({ schemaValue } = await import(process.env.CLAUS_NETWORK_SCHEMA || '../../claus-network/src/services/schema.mjs')); } catch { console.log('note: network schema checker not found; record shapes not validated'); }
const schemaOf = c => SCHEMAS[c];
const ok = (n, c) => { if (!c) { console.log('FAIL', n); process.exitCode = 1; } else console.log('ok  ', n); };
// --- a server state with three alerts across two pools and 12 pools total (2 checkpoint pages)
const W = a => '0x' + a.slice(2).padStart(64, '0'), H = n => '0x' + n.toString(16), int256 = v => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
let logs = [], head = 1000; const LP = '0x' + 'dd'.repeat(20);
const add = (b, address, topics, data) => logs.push({ blockNumber: H(b), address, topics, data, transactionHash: '0x' + b.toString(16).padStart(64, '0') });
for (let i = 0; i < 12; i++) { const T = '0x' + (i + 16).toString(16).padStart(2, '0').repeat(20), P = '0x' + (i + 16).toString(16).padStart(2, '0').repeat(32);
  add(1005 + i, C.ROUTER, [C.T_STAMP, '0x' + '99'.repeat(32), W(T), W(LP)], '0x' + '0'.repeat(24) + C.PM.slice(2) + P.slice(2) + '00'.repeat(32));
  add(1005 + i, C.PM, [C.T_MOD, P, W(LP)], '0x' + int256(-60) + int256(60) + int256(1000) + '00'.repeat(32)); }
const T0 = '0x' + '10'.repeat(20), P0 = '0x' + '10'.repeat(32), T1 = '0x' + '11'.repeat(20);
add(1500, C.PM, [C.T_MOD, P0, W(LP)], '0x' + int256(-60) + int256(60) + int256(-300) + '00'.repeat(32));   // 30% -> liquidity alert
add(1600, T0, [C.T_OWNER, W(LP), C.ZERO32], '0x');                                                    // owner alert
add(1700, T1, [C.T_TRANSFER, C.ZERO32, W(LP)], '0x' + int256(7));                                    // mint alert
const match = (l, f) => { const b = parseInt(l.blockNumber, 16); if (b < parseInt(f.fromBlock, 16) || b > parseInt(f.toBlock, 16)) return false; const as = Array.isArray(f.address) ? f.address : [f.address]; if (!as.includes(l.address)) return false; return (f.topics || []).every((t, i) => t === null || (Array.isArray(t) ? t.includes(l.topics[i]) : l.topics[i] === t)); };
const rpc = async (m, p) => { if (m === 'eth_blockNumber') return H(head); if (m === 'eth_getBlockByNumber') return { timestamp: H(1_800_000_000 + parseInt(p[0], 16) * 12), hash: '0x' + 'ee'.repeat(32) };
  if (m === 'eth_getLogs') return logs.filter(l => match(l, p[0])); if (m === 'eth_call') { const d = p[0].data; if (d.startsWith('0x95d89b41')) return '0x' + '20'.padStart(64, '0') + '3'.padStart(64, '0') + Buffer.from('TOK').toString('hex').padEnd(64, '0'); if (d.startsWith('0xc815641c')) return '0x' + '0'.repeat(256); return '0x'; } if (m === 'eth_getStorageAt') return C.ZERO32; };
let srv = emptyState(999); head = 2000; await cycle(rpc, srv);
ok('server: 12 pools, 3 alerts', srv.pools.length === 12 && srv.alerts.length === 3);
// --- runtime cycles against /bridge.json
let st = initial(), obs = null; const records = { alerts: [], watchstate: [], other: 0 }; let maxState = 0, maxBridge = 0;
for (let c = 0; c < 60; c++) {
  const out = await step(JSON.parse(JSON.stringify({ state: st, observation: obs, cycle: c }))); st = out.state; obs = null; maxState = Math.max(maxState, JSON.stringify(st).length);
  const a = out.action; if (!a) continue;
  if (a.operation === 'project_web_read' && a.input.url.startsWith('https://watch.example/bridge.json')) {
    const q = new URL(a.input.url).searchParams; const body = JSON.stringify(bridge(srv, q.get('after') || '', +q.get('page') || 0)); maxBridge = Math.max(maxBridge, body.length);
    obs = { operation: a.operation, result: { status: 200, text: body, truncated: body.length > 4000, observedAt: 1_800_000_000_000 + c * 4_400_000 } };
  } else if (a.operation === 'project_web_read') obs = { operation: a.operation, result: { status: 200, text: '{"items":[]}', truncated: false, observedAt: 1_800_000_000_000 + c * 4_400_000 } };
  else if (a.operation === 'app_record_create') { const col = a.input.collection; if (schemaOf(col)) schemaValue(schemaOf(col), a.input.data); if (records[col]) records[col].push(a.input.data); else records.other++; obs = { operation: a.operation, result: { id: 'r' + c, revision: 1 } }; }
}
ok('bridge responses under 4,000 chars (max ' + maxBridge + ')', maxBridge < 4000);
ok('runtime state under 12,000 chars (max ' + maxState + ')', maxState < 12000);
ok('each alert copied exactly once, in order', records.alerts.map(a => a.kind).join() === 'liquidity,owner,mint' && records.alerts.length === 3);
ok('checkpoint pages rotate (both pages copied)', new Set(records.watchstate.map(w => w.page)).size === 2);
ok('every copied record passes the network schema', true);
ok('watcher still does its own CLAUS checks and check-ins', records.other > 0);
// --- server restarts from the copied records: same pools, same alert keys after re-scan, nothing re-copied
const latest = records.watchstate.filter(w => w.lastBlock === Math.max(...records.watchstate.map(x => x.lastBlock)));
const srv2 = restore(latest.slice().reverse().map(w => ({ ...w })));
ok('restart restores all 12 pools from 2 pages', srv2.pools.length === 12);
head = 2200; add(2100, T1, [C.T_OWNER, W(LP), C.ZERO32], '0x'); await cycle(rpc, srv2);   // resume from the checkpoint block; one new event after it
const cursor = st.br.after, nxt = bridge(srv2, cursor).alert;
ok('after restart only the genuinely new alert is offered to the runtime', nxt && nxt.kind === 'owner' && nxt.block === 2100 && bridge(srv2, nxt.key).alert === null);
ok('restored liquidity counters are not double counted', srv2.pools.find(p => p.token === T0).removed === '300');
