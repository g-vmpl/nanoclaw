# Mention-Mode Sender Whitelisting

## Problem

`engage_mode='mention'` previously fired for any sender who @mentioned the agent. No way to restrict which senders could invoke an agent in a group.

## Solution

`engage_pattern` field repurposed for mention mode: comma-separated sender whitelist. `.` or null = any sender (original behavior preserved).

Whitelists are managed via `.env` and synced into the DB on every startup — no manual SQL needed.

## How It Works

### Router (`src/router.ts`)

`evaluateEngage` now accepts `userId` and checks it against `engage_pattern` in mention mode:

```
mention mode + engage_pattern set → extract bare phone from userId → check against comma-separated list
```

Sender ID extraction: `whatsapp:918466971926@s.whatsapp.net` → `918466971926` (strips channel prefix and `@...` suffix).

### `.env` Format

```
# Key: MENTION_WHITELIST_ + mga-id with dashes → underscores
# Value: comma-separated bare phone numbers

MENTION_WHITELIST_mga_1779422057429_77pkfm=918466971926
# Multiple senders:
MENTION_WHITELIST_mga_1779422057429_77pkfm=918466971926,919999404525
```

Restart the service after editing `.env` — `syncMentionWhitelists()` runs at startup and writes to DB.

### Startup Sync (`src/sync-mention-whitelists.ts`)

Called from `src/index.ts` after migrations. Reads all `MENTION_WHITELIST_*` keys from `.env`, finds matching `engage_mode='mention'` wiring rows, updates `engage_pattern`. Idempotent.

## Message Accumulation

Set `ignored_message_policy='accumulate'` on a wiring to have the agent consume all group messages as context while only responding to whitelisted @mentions.

Current Vm sales wiring:

| Field | Value |
|---|---|
| `engage_mode` | `mention` |
| `engage_pattern` | `918466971926` |
| `ignored_message_policy` | `accumulate` |

Agent reads every message in the group. Responds only when @mentioned by `918466971926`.

## Adding Whitelists for New Agents / Groups

1. Find the mga ID: `pnpm exec tsx scripts/list-wirings.ts`
2. Add to `.env`:
   ```
   MENTION_WHITELIST_mga_<id with _ not ->= <phone1>,<phone2>
   ```
3. Restart service.

## Files Changed

| File | Change |
|---|---|
| `src/router.ts` | `evaluateEngage` — mention mode checks `engage_pattern` as sender whitelist |
| `src/types.ts` | `engage_pattern` JSDoc updated — documents dual use |
| `src/env.ts` | Added `readEnvFilePrefixed(prefix)` |
| `src/sync-mention-whitelists.ts` | New — startup sync of `MENTION_WHITELIST_*` env keys to DB |
| `src/index.ts` | Calls `syncMentionWhitelists()` after `backfillContainerConfigs()` |
| `.env` | Added `MENTION_WHITELIST_mga_1779422057429_77pkfm=918466971926` |
| `.env.example` | Documented the format |
| `scripts/list-wirings.ts` | New — prints wirings table with group name + platform ID columns |

## Utility Script

```bash
pnpm exec tsx scripts/list-wirings.ts
```

Prints all wirings with agent name, engage config, group name, and platform ID in one table.
