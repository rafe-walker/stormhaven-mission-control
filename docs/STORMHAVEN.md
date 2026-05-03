# STORMHAVEN.md — Operator notes for Stormhaven Mission Control

**Last built:** 2026-05-02
**Lives in:** `github.com/rafe-walker/stormhaven-mission-control` (fork of `daggerhashimoto/openclaw-nerve`)
**LAN URL:** `http://192.168.4.41:3080/stormhaven` (from any device on the LAN)
**Tailscale URL:** `https://stormhaven-mc.tail44fd36.ts.net/stormhaven` *(once `tailscale serve` is wired — see §5)*

## What this is

A read-only dashboard that shows the live state of the Stormhaven media stack — disk gauges, container grid (with the gluetun↔qBT NetNS dependency line drawn red when dangling), *ARR queues, setup gaps, recent Hestia health-cron-run dots, morning brief timeline, and quick facts. Reads from `~/.openclaw/stormhaven/state.json` which is written every 60 seconds by the `stormhaven-collector` Hestia skill.

Phase 1 is read-only. No write actions in the UI — restart-container, force-recreate-qbt, approve-jellyseerr-request etc. all stay in Telegram → Atlas for now. That keeps the build low-risk: the dashboard cannot break the media stack.

## How the pieces fit together

```
NUC (192.168.4.78)            Mac (192.168.4.41)
  ┌────────────────┐            ┌──────────────────────────────────────┐
  │  16-container  │            │  ~/.openclaw/agents/media-manager/   │
  │  media stack   │  HTTP/SSH  │  workspace/skills/stormhaven-collector│
  │  + APIs        │ ◄────────  │  └ collect.sh (cron: every minute)   │
  └────────────────┘            │       │                              │
                                │       ▼ writes                       │
                                │  ~/.openclaw/stormhaven/state.json   │
                                │       │                              │
                                │       ▼ chokidar watches             │
                                │  Nerve fork (port 3080, launchd)     │
                                │   /stormhaven (HTML dashboard)       │
                                │   /api/stormhaven/state              │
                                │   /api/stormhaven/stream (SSE)       │
                                │   /api/stormhaven/cost-history       │
                                └──────────────────────────────────────┘
```

## §1 — Install (already done on Joshua's Mac as of 2026-05-02)

1. The collector skill lives at `~/.openclaw/agents/media-manager/workspace/skills/stormhaven-collector/`. Canonical copy in `github.com/rafe-walker/stormhaven-openclaw` under `workspaces/media-manager/skills/stormhaven-collector/`.
2. The cron is registered as a Hestia job, `* * * * *` (every minute), agentId=media-manager, no auto-deliver. Confirm via `openclaw cron list | grep stormhaven`.
3. The Nerve fork is cloned at `/Users/Apple/git/stormhaven-mission-control` and built with `npm run prod`.
4. Two launchd LaunchAgents:
   - `~/Library/LaunchAgents/com.stormhaven.mission-control.plist` — runs Nerve at `127.0.0.1:3080`, `RunAtLoad=true`, `KeepAlive=Crashed`.
   - `~/Library/LaunchAgents/com.stormhaven.cost-rollup.plist` — runs `cost-rollup.js` daily at 23:55 Phoenix.
5. Both loaded via `launchctl bootstrap gui/$UID <plist>`.

Verify with:
```bash
launchctl list | grep stormhaven
curl http://127.0.0.1:3080/stormhaven        # should return HTML
curl http://127.0.0.1:3080/api/stormhaven/state | jq .schemaVersion  # should be 1
```

## §2 — How the snapshot is shaped

`~/.openclaw/stormhaven/state.json` (atomically rewritten every 60s):

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-05-02T...Z",
  "collector": { "elapsedMs": 2728, "sourcesOk": 17, "sourcesFailed": 0 },
  "stack": { "overall": "GREEN|YELLOW|RED", "overallReason": "..." },
  "host": { "load": [...], "memUsedMB": ..., "kernel": "..." },
  "disks": [{ "mount": "/mnt/media1", "usedPct": 79, "trend": {...} }, ...],
  "containers": [{ "name": "gluetun", "state": "running", ... }, ...],
  "dependencies": { "gluetunQbtNetns": { "dangling": false, "alert": null, ... } },
  "vpn": { "ip": "...", "country": "...", "healthy": true },
  "arr": { "radarr": {...}, "sonarr": {...}, "lidarr": {...} },
  "qbittorrent": { "active": 4, "seeding": 28, ... },
  "jellyfin": { "version": "10.11.8", "transcodeCount": 0, "transcodeWarning": null },
  "jellyseerr": { ... }, "prowlarr": { ... }, "bazarr": { ... }, "sabnzbd": { ... },
  "adguard": { ... }, "tailscale": { "peerCount": 0, "alert": "..." },
  "openclaw": { "today": {...}, "hestiaHealthRuns24h": [...], ... },
  "setupGaps": [...],
  "errors": []
}
```

The collector's `stack.overall` is computed locally — not from Hestia's verbatim line — so the dashboard has its own opinion that updates every minute. The Hestia health summary lands in `stack.lastHealthRunSummary` for context.

## §3 — Adding a new panel

1. Edit `server/routes/stormhaven.html` — add a new `<div id="my-panel" class="panel"></div>` and render logic in the `render(snap, ...)` function.
2. The HTML is served by `app.get('/stormhaven', ...)` from `server/routes/stormhaven.ts`. After editing, copy the file into `server-dist/routes/` (or run `npm run build:server` again — it's not in the TS build path so a manual `cp` works fine).
3. Hot reload via `launchctl kickstart -k gui/$UID/com.stormhaven.mission-control`.

## §4 — Extending the snapshot schema

If you add a new field, update three places:

- `~/.openclaw/agents/media-manager/workspace/skills/stormhaven-collector/scripts/lib-*.sh` — emit the field
- `scripts/collect.sh` — add it to the final `jq -n ...` assembly
- `server/routes/stormhaven.html` — render it

Bump `schemaVersion` if the change is not backward-compatible.

## §5 — Tailscale Serve setup (manual, ~5 min)

The dashboard binds to `127.0.0.1:3080` on the Mac (Nerve safety check refuses 0.0.0.0 without auth). To reach it from a phone on the tailnet:

```bash
# One-time setup on the Mac:
brew install --cask tailscale
open -a Tailscale       # follow GUI to log in to Joshua's tailnet
sudo tailscale set --hostname stormhaven-mc

# Map port 443 -> local 3080 over Tailscale Serve:
sudo tailscale serve --bg --https=443 http://127.0.0.1:3080

# Verify:
tailscale serve status
# Expected: "https://stormhaven-mc.tail44fd36.ts.net (tailnet only)"
#           "  └ http://127.0.0.1:3080"
```

Then `https://stormhaven-mc.tail44fd36.ts.net/stormhaven` works from any tailnet device.

## §6 — Merging upstream Nerve updates

```bash
cd /Users/Apple/git/stormhaven-mission-control
git fetch upstream
git checkout master
git merge upstream/master
# Conflicts in server/app.ts are expected at the marker comments:
#   // STORMHAVEN: route import
#   // STORMHAVEN: registered
#   // STORMHAVEN: SSE excluded
# Reapply our 3 lines if upstream changed nearby code.
git push origin master
```

## §7 — Operator runbook

| Symptom | Check |
|---|---|
| Dashboard says "stale" | `openclaw cron run <stormhaven-cron-id>` and re-check `~/.openclaw/stormhaven/state.json` mtime |
| Dashboard returns 503 | `state.json` doesn't exist or is older than 5 minutes — collector cron broken |
| `/stormhaven` 404 | `stormhaven.html` not in `server-dist/routes/` — `cp server/routes/stormhaven.html server-dist/routes/` |
| Nerve service won't start | `tail ~/.openclaw/stormhaven/nerve.err` |
| Cost trend chart empty | First nightly run hasn't fired yet (23:55 Phoenix) — give it a day |
| Container grid shows 22 not 16 | Collector uses `docker ps -a` — exited containers show too. Will be fixed in collector v1.1 (use `docker ps`) |

## §8 — Rollback

If anything breaks Stormhaven:

```bash
launchctl bootout gui/$UID/com.stormhaven.mission-control
launchctl bootout gui/$UID/com.stormhaven.cost-rollup
openclaw cron disable <stormhaven-cron-id>
sudo tailscale serve --https=443 off   # if Tailscale was wired
```

The media stack is untouched at all times — Stormhaven only reads. Telegram alerts continue working independently. Worst case is "the dashboard is broken."
