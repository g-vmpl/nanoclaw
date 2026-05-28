import { getDb } from './db/connection.js';
import { readEnvFilePrefixed } from './env.js';
import { log } from './log.js';

/**
 * Sync mention-mode sender whitelists from .env into messaging_group_agents.
 *
 * .env format:
 *   MENTION_WHITELIST_<mga-id with dashes replaced by underscores>=918466971926,919999404525
 *
 * Example:
 *   MENTION_WHITELIST_mga_1779422057429_77pkfm=918466971926,919999404525
 *
 * Only wirings with engage_mode='mention' are updated. The value becomes
 * engage_pattern (comma-separated phone numbers). '.' or empty = any sender.
 * Runs at startup — idempotent, safe to call multiple times.
 */
export function syncMentionWhitelists(): void {
  const entries = readEnvFilePrefixed('MENTION_WHITELIST_');
  if (Object.keys(entries).length === 0) return;

  const db = getDb();
  const getRow = db.prepare<[string]>("SELECT id FROM messaging_group_agents WHERE id = ? AND engage_mode = 'mention'");
  const update = db.prepare<[string, string]>('UPDATE messaging_group_agents SET engage_pattern = ? WHERE id = ?');

  for (const [suffix, value] of Object.entries(entries)) {
    // Env key suffix uses underscores; mga IDs use dashes. Reverse the swap.
    const mgaId = suffix.replace(/_/g, '-');
    const row = getRow.get(mgaId) as { id: string } | undefined;
    if (!row) {
      log.warn('MENTION_WHITELIST entry has no matching mention-mode wiring — skipped', { mgaId });
      continue;
    }
    update.run(value, mgaId);
    log.info('Mention whitelist synced from .env', { mgaId, pattern: value });
  }
}
