/**
 * scripts/list-wirings.ts — print wirings table with WhatsApp group name column.
 *
 * Usage: pnpm exec tsx scripts/list-wirings.ts
 */
import path from 'path';
import Database from 'better-sqlite3';

const dbPath = path.join(process.cwd(), 'data', 'v2.db');
const db = new Database(dbPath, { readonly: true });

interface Row {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  agent_name: string;
  engage_mode: string;
  engage_pattern: string | null;
  sender_scope: string;
  ignored_message_policy: string;
  session_mode: string;
  mg_name: string | null;
  platform_id: string;
  created_at: string;
}

const rows = db
  .prepare<[], Row>(
    `SELECT
       mga.id,
       mga.messaging_group_id,
       mga.agent_group_id,
       ag.name       AS agent_name,
       mga.engage_mode,
       mga.engage_pattern,
       mga.sender_scope,
       mga.ignored_message_policy,
       mga.session_mode,
       mg.name       AS mg_name,
       mg.platform_id,
       mga.created_at
     FROM messaging_group_agents mga
     JOIN agent_groups ag ON ag.id = mga.agent_group_id
     JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
     ORDER BY mga.created_at`,
  )
  .all();

if (rows.length === 0) {
  console.log('No wirings found.');
  process.exit(0);
}

const cols = [
  { key: 'id',                    label: 'id' },
  { key: 'agent_name',            label: 'agent' },
  { key: 'engage_mode',           label: 'engage_mode' },
  { key: 'engage_pattern',        label: 'engage_pattern' },
  { key: 'sender_scope',          label: 'sender_scope' },
  { key: 'ignored_message_policy',label: 'ignored_msg_policy' },
  { key: 'session_mode',          label: 'session_mode' },
  { key: 'mg_name',               label: 'group_name' },
  { key: 'platform_id',           label: 'platform_id' },
] as const;

// Compute column widths
const widths = cols.map(({ key, label }) =>
  Math.max(label.length, ...rows.map((r) => String(r[key as keyof Row] ?? '').length)),
);

const sep = widths.map((w) => '─'.repeat(w)).join('  ');
const header = cols.map(({ label }, i) => label.padEnd(widths[i]!)).join('  ');

console.log(header);
console.log(sep);
for (const row of rows) {
  const line = cols
    .map(({ key }, i) => String(row[key as keyof Row] ?? '').padEnd(widths[i]!))
    .join('  ');
  console.log(line);
}
