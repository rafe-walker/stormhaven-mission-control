// server/scripts/cost-rollup.ts
// Run daily at 23:55 Phoenix via launchd. Reads today's stormhaven snapshot
// and inserts a cost_daily row into ~/.openclaw/stormhaven/history.db.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import Database from "better-sqlite3";

const STATE_PATH =
  process.env.STORMHAVEN_STATE_PATH ||
  path.join(os.homedir(), ".openclaw", "stormhaven", "state.json");
const DB_PATH =
  process.env.STORMHAVEN_HISTORY_DB ||
  path.join(os.homedir(), ".openclaw", "stormhaven", "history.db");

function todayPhoenix(): string {
  // Phoenix = UTC-7 year-round (no DST)
  const now = new Date();
  const phoenix = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  return phoenix.toISOString().slice(0, 10);
}

function main() {
  if (!fs.existsSync(STATE_PATH)) {
    console.error(`No snapshot found at ${STATE_PATH}`);
    process.exit(1);
  }
  const snap = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const date = todayPhoenix();
  const cost = snap.openclaw?.today?.estimatedCostUSD || 0;
  const breakdown = JSON.stringify({
    main: cost, // single-bucket placeholder; expand with per-agent breakdown when collector emits it
  });

  const db = new Database(DB_PATH);
  db.prepare(
    `CREATE TABLE IF NOT EXISTS cost_daily (
       date TEXT PRIMARY KEY,
       cost_usd REAL NOT NULL,
       agent_breakdown TEXT,
       created_at TEXT NOT NULL
     )`,
  ).run();
  db.prepare(
    `INSERT INTO cost_daily (date, cost_usd, agent_breakdown, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       cost_usd = excluded.cost_usd,
       agent_breakdown = excluded.agent_breakdown,
       created_at = excluded.created_at`,
  ).run(date, cost, breakdown, new Date().toISOString());
  db.close();

  console.log(`cost-rollup: wrote ${date} = $${cost.toFixed(2)}`);
}

main();
