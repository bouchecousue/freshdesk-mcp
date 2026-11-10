import Database from "better-sqlite3";
import { resolve } from "node:path";

interface RawUsageRow {
  user_id: string;
  agent_id: string;
  agent_name: string | null;
  agent_email: string | null;
  tenant_origin: string;
  tool: string;
  action_kind: string;
  action_name: string | null;
  outcome: string;
  call_count: number;
  duration_sample_count: number;
  total_duration_ms: number;
  max_duration_ms: number;
  result_count_sample_count: number;
  total_result_count: number;
  write_sample_count: number;
  writes_applied: number;
  readbacks_verified: number;
  first_occurred_at: number;
  last_occurred_at: number;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const databasePath = resolve(argument("--database") ?? process.env.DATABASE_PATH ?? "var/freshdesk-mcp.sqlite3");
const days = Number(argument("--days") ?? "30");
if (!Number.isSafeInteger(days) || days < 1 || days > 3_650) throw new Error("--days must be an integer between 1 and 3650");
const sinceDayUtc = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
const database = new Database(databasePath, { readonly: true, fileMustExist: true });

try {
  const rows = database.prepare(`
    SELECT
      user_id,
      agent_id,
      MAX(agent_name) AS agent_name,
      MAX(agent_email) AS agent_email,
      tenant_origin,
      tool,
      action_kind,
      NULLIF(action_name, '') AS action_name,
      outcome,
      SUM(call_count) AS call_count,
      SUM(duration_sample_count) AS duration_sample_count,
      SUM(total_duration_ms) AS total_duration_ms,
      MAX(max_duration_ms) AS max_duration_ms,
      SUM(result_count_sample_count) AS result_count_sample_count,
      SUM(total_result_count) AS total_result_count,
      SUM(write_sample_count) AS write_sample_count,
      SUM(writes_applied) AS writes_applied,
      SUM(readbacks_verified) AS readbacks_verified,
      MIN(first_occurred_at) AS first_occurred_at,
      MAX(last_occurred_at) AS last_occurred_at
    FROM usage_daily_stats
    WHERE day_utc >= ?
    GROUP BY user_id, agent_id, tenant_origin, tool, action_kind, action_name, outcome
    ORDER BY agent_name COLLATE NOCASE, agent_id, call_count DESC, tool, action_kind, action_name, outcome
  `).all(sinceDayUtc) as RawUsageRow[];
  const report = rows.map((row) => ({
    identity: {
      userId: row.user_id,
      agentId: row.agent_id,
      name: row.agent_name,
      email: row.agent_email,
      tenantOrigin: row.tenant_origin,
    },
    tool: row.tool,
    actionKind: row.action_kind,
    actionName: row.action_name,
    outcome: row.outcome,
    calls: row.call_count,
    duration: row.duration_sample_count === 0 ? null : {
      samples: row.duration_sample_count,
      averageMs: Math.round(row.total_duration_ms / row.duration_sample_count),
      maximumMs: row.max_duration_ms,
    },
    results: row.result_count_sample_count === 0 ? null : {
      samples: row.result_count_sample_count,
      total: row.total_result_count,
    },
    writes: row.write_sample_count === 0 ? null : {
      samples: row.write_sample_count,
      applied: row.writes_applied,
      readbackVerified: row.readbacks_verified,
    },
    firstOccurredAt: new Date(row.first_occurred_at * 1_000).toISOString(),
    lastOccurredAt: new Date(row.last_occurred_at * 1_000).toISOString(),
  }));
  process.stdout.write(`${JSON.stringify({
    generatedAt: new Date().toISOString(),
    databasePath,
    sinceDayUtc,
    days,
    aggregateRows: report.length,
    calls: report.reduce((total, row) => total + row.calls, 0),
    usage: report,
  }, null, 2)}\n`);
} finally {
  database.close();
}
