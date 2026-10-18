# Claus Shifts · Launch Watch server

A small, keyless server that finds new token launches on Ethereum (every launch through Programmable's launch router, and any Uniswap v4 pool paired with CLAUS), X-rays each one, and watches it for 14 days against five fixed triggers. Built for a bounded pilot on the Claus Network's project servers.

- Spec (acceptance test): https://claus.si/c/claus-shifts/pages/launch-watch.html
- Pilot proposal and budget: https://claus.si/c/claus-shifts/pages/launch-server.html
- Launch Index (records it extends): https://claus.si/c/claus-shifts/pages/launches.html

It holds no key, signs nothing, writes nothing to any network and keeps nothing on disk. It reads the chain through public RPC and serves what it found as read-only JSON.

## Why Go

The Claus Network's builder caps images at 32 MiB. The Node base image alone is 60.7 MB, so the first version (`server/`, the one Claus reviewed at e491bcb, unchanged) could not be built there. `server-go/` is a line-for-line Go port: standard library only, a static binary on an empty `scratch` image, about 7 MB in total. It serves the same endpoints with the same JSON, and `test/diff.test.mjs` proves it: both servers run side by side against identical mock Ethereum nodes and must agree on every endpoint through launches, every trigger, retries, gaps, fee reads and a restart from checkpoint records (88 checks).

## Layout

| Path | What |
|---|---|
| `server-go/watch.go` | Discovery, X-ray, the five triggers, paged checkpoint, coverage report, bridge. |
| `server-go/main.go` | HTTP (port 8080), start-up from the last complete checkpoint set, the 5-minute loop. Cycles run on a copy of the state, so HTTP reads never wait on the network. |
| `server-go/Dockerfile` | **What the network builds.** Build context `server-go/`. Builder pinned to the same golang digest as the network's own OCI verification fixture; final image `scratch` with only the binary and CA certificates, unprivileged user. No downloads at build time. |
| `server/` | The reviewed JavaScript version (`watch.mjs`, `server.mjs`, Node `Dockerfile`), unchanged since e491bcb and kept as the specification the Go port is tested against. |
| `runtime/shifts-watch.mjs` | Revision 4 of Claus Shifts' existing managed-runtime worker. Adds the bridge that copies alerts and checkpoint pages into public records. Dormant while `SERVER` is empty: its plan is then identical to revision 3. |
| `schemas/records.json` | The `launches`, `alerts` and `watchstate` record schemas (additive to the existing app). |
| `test/` | `node test/server.test.mjs` (22 scenarios), `node test/e2e.test.mjs` (server → bridge → runtime → records → restart, 10 checks), and `node test/diff.test.mjs server <go-binary>` (Go vs reference, 88 checks). |

## Endpoints (all GET, read-only)

`/health` · `/state.json` · `/coverage.json` · `/checkpoint.json?page=N` · `/bridge.json?after=KEY&page=N`

`/health` returns 503 only if no cycle has succeeded for an hour; a single failed RPC round is retried, not treated as a crash.

## Runtime manifest (for `resource_release_prepare`)

```json
{ "version": 1, "mode": "http", "image": "<registry address from resource_image_publish>", "region": "<from resource_profiles>",
  "cpu": 1, "memoryMiB": 512, "gpu": null, "port": 8080, "healthPath": "/health",
  "command": ["/server"], "storageGiB": 0 }
```

## Every 5 minutes

1. Discover: one log query on the router for `ProgrammableLaunchStampedV1`, two on the PoolManager for `Initialize` with CLAUS on either side (routine pairs with ETH, WETH, USDC, USDT, DAI, WBTC ignored).
2. X-ray each new launch at the current head.
3. Watch every pool inside its 14 days with four log queries covering all pools: liquidity (`ModifyLiquidity`, net removals against baseline L0), owner, upgrade or admin change, mint. Pool fee read hourly. Baseline window: fixed at launch block + 50, wherever the first scan happened to end; everything inside it, including blocks scanned in later cycles, is baseline (L0), not alerts.
4. All or nothing: a block range is applied only if every query succeeded. A failing range is retried whole; after 6 straight failures (30 minutes) it is recorded as a gap. A gap is never reported as "nothing happened".

## Restart

The server has no disk. Claus Shifts' managed runtime reads `/bridge.json` and copies either the next alert (by a stable key: block, kind, token) or one checkpoint page (9 pools, under 4,000 characters) into public records. Page 0 freezes a snapshot of the state and every later page of that set is served from the same snapshot, so a set describes one block even though the runtime copies one page per read, hours apart. On start, the server restores only a complete set (every page of one snapshot), taking the newest complete set and skipping any newer incomplete one, then re-scans from that set's block. A missing page therefore delays the restore point instead of dropping watched pools; with no complete set the server cold-starts and records the gap. Repeated page copies cannot duplicate pools. Alerts re-found in the re-scan keep their key, so the runtime never copies them twice.

## Budget, 14 days

About 45,000 RPC calls (11 per cycle × 4,032 cycles, plus hourly fee reads and X-rays), on keyless public endpoints: publicnode.com, with Tenderly's public gateway as fallback (it also serves full log history). Server: 1 vCPU, 512 MiB, no storage, 336 hours at the profile's CPU rate. Runtime: at most 19 record writes a day.

## Known limits

- Public nodes serve recent contract state only, so X-rays are pinned to the current head.
- At most 25 pools are watched at once; further launches are X-rayed and listed as a capacity gap.
- With the bridge on, the runtime's 19 daily runs give a bridge read about every 5 hours, so an alert is on `/state.json` within 5 minutes but reaches public records within about 5 hours. More runtime runs shorten that.
- A runtime web read that times out retires that runtime slot (the network does not recover a held read). Claus Shifts' updater moves to the next of nine slot IDs.
- Hook buy and sell fee values have no standard getter; they are listed as "could not check" unless read from verified source.

MIT licence. A community build by a CLAUS holder, not made by Claus or Programmable.
