// server/routes/stormhaven.ts
// Stormhaven Mission Control backend routes — read state.json, stream changes, query cost history.
//
// Endpoints:
//   GET  /api/stormhaven/state         — current snapshot, X-Stormhaven-Age-Seconds header
//   GET  /api/stormhaven/stream        — SSE: state events on file change, heartbeat every 30s
//   GET  /api/stormhaven/cost-history  — daily cost rollup from SQLite

import { Hono } from "hono";
import { stream } from "hono/streaming";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import chokidar from "chokidar";

const STATE_PATH =
  process.env.STORMHAVEN_STATE_PATH ||
  path.join(os.homedir(), ".openclaw", "stormhaven", "state.json");
const HISTORY_DB =
  process.env.STORMHAVEN_HISTORY_DB ||
  path.join(os.homedir(), ".openclaw", "stormhaven", "history.db");
const STALE_AFTER_MS = 5 * 60 * 1000; // 5 minutes

let cachedSnapshot: any = null;
let cachedSnapshotMtimeMs = 0;
const sseClients = new Set<{
  enqueue: (msg: string) => void;
  close: () => void;
}>();

async function readSnapshot(): Promise<{ data: any; mtimeMs: number } | null> {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const stat = await fs.stat(STATE_PATH);
    return { data: JSON.parse(raw), mtimeMs: stat.mtimeMs };
  } catch (e) {
    return null;
  }
}

function ageSeconds(generatedAt: string): number {
  const t = new Date(generatedAt).getTime();
  return Math.floor((Date.now() - t) / 1000);
}

// File watcher — broadcast changes to all SSE clients
let watcherStarted = false;
function ensureWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;
  const watcher = chokidar.watch(STATE_PATH, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });
  let debounceTimer: NodeJS.Timeout | null = null;
  watcher.on("change", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const snap = await readSnapshot();
      if (!snap) return;
      cachedSnapshot = snap.data;
      cachedSnapshotMtimeMs = snap.mtimeMs;
      const payload = JSON.stringify(snap.data);
      for (const c of sseClients) {
        try {
          c.enqueue(`event: state\ndata: ${payload}\n\n`);
        } catch (_) {}
      }
    }, 500);
  });
}

const app = new Hono();

// Resolve the directory containing this file at runtime (works after tsc compile)
const __THIS_DIR = path.dirname(new URL(import.meta.url).pathname);
const HTML_PATH = path.join(__THIS_DIR, "stormhaven.html");

// GET /stormhaven — standalone HTML dashboard, served independently of the React SPA
const JS_PATH = path.join(__THIS_DIR, "stormhaven-dashboard.js");

app.get("/stormhaven", async (c) => {
  try {
    const html = await fs.readFile(HTML_PATH, "utf8");
    return c.html(html);
  } catch (e) {
    return c.text(`stormhaven.html not found at ${HTML_PATH}`, 500);
  }
});

// External script — referenced by stormhaven.html. Served separately so the
// existing global helmet CSP (script-src self) accepts it without inline allowance.
app.get("/stormhaven-dashboard.js", async (c) => {
  try {
    const js = await fs.readFile(JS_PATH, "utf8");
    c.header("content-type", "application/javascript; charset=utf-8");
    c.header("cache-control", "no-cache");
    return c.body(js);
  } catch (e) {
    return c.text(`stormhaven-dashboard.js not found at ${JS_PATH}`, 500);
  }
});

app.get("/api/stormhaven/state", async (c) => {
  ensureWatcher();
  const snap = await readSnapshot();
  if (!snap) {
    return c.json({ error: "snapshot not found", lastSeen: null }, 503);
  }
  const age = snap.data.generatedAt ? ageSeconds(snap.data.generatedAt) : 9999;
  if (age * 1000 > STALE_AFTER_MS) {
    return c.json(
      { error: "snapshot stale", lastSeen: snap.data.generatedAt, ageSeconds: age },
      503,
    );
  }
  c.header("X-Stormhaven-Age-Seconds", String(age));
  return c.json(snap.data);
});

app.get("/api/stormhaven/stream", async (c) => {
  ensureWatcher();
  return stream(c, async (s) => {
    s.write(`: connected\n\n`);
    const snap = await readSnapshot();
    if (snap) {
      s.write(`event: state\ndata: ${JSON.stringify(snap.data)}\n\n`);
    }
    const client = {
      enqueue: (msg: string) => s.write(msg),
      close: () => s.close(),
    };
    sseClients.add(client);
    const heartbeat = setInterval(() => {
      try {
        s.write(`event: heartbeat\ndata: {}\n\n`);
      } catch (_) {}
    }, 30000);
    const staleCheck = setInterval(async () => {
      const snap = await readSnapshot();
      if (!snap) return;
      const age = snap.data.generatedAt ? ageSeconds(snap.data.generatedAt) : 9999;
      if (age * 1000 > STALE_AFTER_MS) {
        try {
          s.write(`event: stale\ndata: ${JSON.stringify({ lastSeen: snap.data.generatedAt, ageSeconds: age })}\n\n`);
        } catch (_) {}
      }
    }, 60000);
    c.req.raw.signal.addEventListener("abort", () => {
      clearInterval(heartbeat);
      clearInterval(staleCheck);
      sseClients.delete(client);
    });
    // keep open
    await new Promise<void>((resolve) => {
      c.req.raw.signal.addEventListener("abort", () => resolve());
    });
  });
});

app.get("/api/stormhaven/cost-history", async (c) => {
  const days = parseInt(c.req.query("days") || "30", 10);
  try {
    const Database = (await import("better-sqlite3")).default as any;
    const db = new Database(HISTORY_DB, { readonly: true, fileMustExist: false });
    const rows = db
      .prepare(
        "SELECT date, cost_usd, agent_breakdown FROM cost_daily ORDER BY date DESC LIMIT ?",
      )
      .all(days);
    db.close();
    return c.json(
      rows.map((r: any) => ({
        date: r.date,
        costUSD: r.cost_usd,
        agentBreakdown: r.agent_breakdown ? JSON.parse(r.agent_breakdown) : {},
      })),
    );
  } catch (e: any) {
    // Graceful empty when DB doesnt exist yet (first nightly rollup is at 23:55 Phoenix)
    return c.json([]);
  }
});


// GET /api/stormhaven/run/:id — fetch full Hestia health run text for the dot-click modal.
app.get("/api/stormhaven/run/:id", async (c: any) => {
  try {
    const id = c.req.param("id");
    const HESTIA_HEALTH_ID = "600f541b-09bf-4688-84cb-ea474d4a7ccf";
    const cronLog = path.join(os.homedir(), ".openclaw", "cron", "runs", `${HESTIA_HEALTH_ID}.jsonl`);
    let summary: any = null;
    let sessionId: any = null;
    try {
      const lines = (await fs.readFile(cronLog, "utf8")).trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const r = JSON.parse(lines[i]);
          if (r.runId === id || r.sessionId === id || String(r.runAtMs) === id) {
            summary = r.summary;
            sessionId = r.sessionId;
            break;
          }
        } catch {}
      }
    } catch {}
    if (!sessionId) return c.json({error: "run not found", id}, 404);
    const sessionFile = path.join(os.homedir(), ".openclaw", "agents", "media-manager", "sessions", `${sessionId}.jsonl`);
    let text = summary || "(no summary)";
    try {
      const sf = await fs.readFile(sessionFile, "utf8");
      const all = sf.trim().split("\n").map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const parts = all
        .filter((e: any) => e.type === "text" || e.type === "assistant_message" || e.role === "assistant")
        .map((e: any) => {
          if (typeof e.text === "string") return e.text;
          if (typeof e.content === "string") return e.content;
          if (Array.isArray(e.content)) return e.content.map((c: any) => c.text || "").join("");
          return "";
        }).filter(Boolean);
      if (parts.length) text = parts.join("\n\n");
    } catch {}
    return c.json({sessionId, summary, text});
  } catch (e: any) {
    return c.json({error: String(e)}, 500);
  }
});


export default app;
