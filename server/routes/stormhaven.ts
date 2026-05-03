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
app.get("/stormhaven", async (c) => {
  try {
    const html = await fs.readFile(HTML_PATH, "utf8");
    return c.html(html);
  } catch (e) {
    return c.text(`stormhaven.html not found at ${HTML_PATH}`, 500);
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
    return c.json({ error: e.message || String(e) }, 500);
  }
});

export default app;
