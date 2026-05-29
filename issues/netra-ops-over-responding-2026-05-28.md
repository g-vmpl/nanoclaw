# netra-ops Over-Responding Investigation — 2026-05-28

## Symptom

netra-ops agent was posting a response to every single message from every team member in the VMPL Operations WhatsApp group — EOD reports, status updates, casual messages. Expected behavior: silent observer, responds only on escalation conditions, scheduled tasks, or direct mentions.

---

## Root Cause Chain (Three Separate Issues)

### Issue 1: LLM self-policing silence is unreliable

**Configuration at time of incident:**
- `engage_mode=pattern`, `engage_pattern='.'` → every message from known members → `trigger=1` → agent woken on every message
- `CLAUDE.local.md` Response Gate: "stay silent unless condition X, Y, Z"

**Why it failed:**  
The LLM's trained "be helpful" behavior overrides explicit silence instructions. The agent IS reading `CLAUDE.local.md` (confirmed via transcript: agent's `<internal>` scratchpad quoted "Response Gate" by name and reasoned from its conditions). But when presented with a team member sharing dispatch details or an EOD report, the LLM classified it as worth acknowledging despite instructions to stay silent.

**Evidence from transcript `8a832472-d560-47ce-ba0d-39542a3aa806.jsonl`:**
```
"Since Arpit just shared this image without a specific question to me, and I need
to follow the 'Response Gate' - this doesn't clearly fall into one of my response
conditions UNLESS I consider it..."

"Per Response Gate, I should NOT respond unless one of the conditions is explicitly
true. However, looking at this..."

"Actually, since Arpit just shared this without addressing me directly, I should
stay silent per the Response Gate. This is a general status update, not a direct
address to me. Let me stay silent."
```

Agent reasoned correctly for the image but then responded to a subsequent text message in the same batch. Inconsistent application across a multi-message batch.

**Architectural conclusion:** Asking an LLM to self-police silence on 50+ messages/day is not a reliable control mechanism.

---

### Issue 2: Stale session error posted to WhatsApp group

**What happened:**
1. Previous session transcript (`f0e4a363-....jsonl`) was deleted manually to reset behavioral state
2. `session_state` in `outbound.db` still held the old continuation ID `f0e4a363-...`
3. Next inbound message → container tried to resume → Claude API returned `"No conversation found with session ID: f0e4a363-..."`
4. Error was posted verbatim to the WhatsApp group as a chat message

**Root cause in code:**  
`container/agent-runner/src/poll-loop.ts` — after stale session detection and continuation clearing, `writeMessageOut` was unconditionally called with the error text:
```typescript
if (continuation && config.provider.isSessionInvalid(err)) {
    continuation = undefined;
    clearContinuation(config.providerName);
}
// Still posted error regardless:
writeMessageOut({ content: JSON.stringify({ text: `Error: ${errMsg}` }) });
```

**Fix applied:** Gate `writeMessageOut` on `!isStale`:
```typescript
let isStale = false;
if (continuation && config.provider.isSessionInvalid(err)) {
    continuation = undefined;
    clearContinuation(config.providerName);
    isStale = true;
}
if (!isStale) {
    writeMessageOut({ content: JSON.stringify({ text: `Error: ${errMsg}` }) });
}
```

Committed: `9986f4b` — pushed to `g-vmpl/nanoclaw`.

---

### Issue 3: Escalation task buried below LIMIT=10 horizon

**What happened:**  
A periodic escalation-check task (`task-escalation-check-001`) was manually inserted into `inbound.db` with `seq=44`. Over the following hours, 15+ trigger=0 chat messages arrived with seq values 54–90. 

`getPendingMessages()` query:
```sql
SELECT * FROM messages_in
WHERE status = 'pending'
  AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
ORDER BY seq DESC
LIMIT 10
```

With `LIMIT=10` and `ORDER BY seq DESC`, only the 10 newest messages are returned. The escalation task (seq=44) was below the cutoff and was never returned by any container's poll — initial or follow-up.

**Additional compounding factor:**  
`process_after=NULL` was set at insertion time, meaning the task was immediately and perpetually due. The host-sweep saw it as due and woke the container, but the container's poll never saw the task (seq too low). The container saw only trigger=0 messages, the accumulate gate fired, and the container sat idle polling.

**Fix (initial — incomplete):**  
Updated task seq and process_after directly in inbound.db:
```sql
UPDATE messages_in
SET seq = 94,               -- above current max of 90
    process_after = '2026-05-29T05:30:00.000Z'  -- tomorrow 11:00 IST
WHERE id = 'task-escalation-check-001';
```

This was a one-time patch. seq=94 would be buried again once chat volume exceeded it.

**Root cause (deeper):**  
Task was manually inserted without `recurrence` or `series_id` columns set. The sweep's `handleRecurrence` in `src/modules/scheduling/recurrence.ts` only re-arms tasks where `status = 'completed' AND recurrence IS NOT NULL`. Without `recurrence`, the task was a dead one-shot — it never auto-recurred, and each manual re-arm required setting seq above the current max by hand.

**Fix (structural — 2026-05-28):**  
Patched existing row to add recurrence expression and series_id anchor:
```sql
UPDATE messages_in
SET recurrence = '0 11,15 * * 1-5',
    series_id = 'task-escalation-check-001',
    status = 'completed'
WHERE id = 'task-escalation-check-001';
```

On next sweep tick, `handleRecurrence` finds the row, calls `insertRecurrence` which uses `nextEvenSeq(db)` (`MAX(seq)+2`) for the new row's seq, computes next fire time via cron-parser in IST, inserts fresh pending row, then calls `clearRecurrence` to null out `recurrence` on the old row. From this point: every 11:00 + 15:00 IST weekday, a new row is inserted with the highest seq in the table — buried-seq problem structurally solved.

**Side-effect:** Sweep ran twice before `clearRecurrence` completed, inserting two duplicate escalation rows (seq=96, seq=108). seq=96 row had no `series_id`. Deleted seq=96; kept seq=108 (clean, series_id correct).

**Full audit (2026-05-28):**  
Discovered all other netra-ops tasks also had low seq values despite having correct `recurrence`/`series_id`:

| Task | Original seq | Fixed seq | Fires |
|------|-------------|-----------|-------|
| Escalation check | 94 (completed) | 108 | Weekdays 11:00 + 15:00 IST |
| Evening routine | 14 | 110 | Weekdays 19:00 IST |
| Morning routine | 26 | 112 | Weekdays 09:00 IST |
| EOW routine | 8 | 114 | Fridays 18:00 IST |

All bumped to `MAX(seq)+2` sequentially. All have `recurrence` + `series_id` — sweep auto-re-arms at `MAX(seq)+2` after each fire going forward.

**Lesson for future task insertion:**  
- Always set `seq = MAX(seq) + 2` at insertion time
- Always set `process_after` to the first scheduled fire time (`NULL` = fire immediately, wrong for cron tasks)
- For recurring tasks: always set `recurrence` (cron expression) and `series_id` (= task id for the first row). Without these, the sweep's recurrence system is blind to the task.
- After manual patching that triggers sweep re-arming, verify only one new row was created (sweep can double-insert if status sync races).

---

## Architectural Fix (Issue 1)

Switched from LLM self-policing to engagement-level control:

| Before | After |
|--------|-------|
| `engage_mode=pattern`, `engage_pattern='.'` | `engage_mode=mention`, `engage_pattern='netra\|netra-ops\|918466971926'` |
| Every message → trigger=1 → agent woken | Routine messages → trigger=0 → accumulated, agent never woken |
| Response Gate (LLM must decide to stay silent) | No gate needed — LLM not consulted for routine messages |
| Escalation detection: real-time LLM self-policing | Escalation detection: scheduled task at 11:00 + 15:00 IST weekdays |

**Escalation check task prompt design:**
```
ESCALATION CHECK: Silently review all messages...
IF YES to any: respond ONCE with the standard escalation format.
IF NO: do NOT post anything to the group. Stay completely silent.
This check is invisible to the team unless an escalation is found.
```

Asking an LLM to decide to respond (when given explicit conditions) is reliable. Asking it to decide to NOT respond against trained helpful behavior is not.

---

## Key Invariants to Remember

### `getPendingMessages` LIMIT behavior
- Query returns at most `maxMessagesPerPrompt` (default 10) messages ordered by `seq DESC`
- Tasks inserted with low seq values can be invisibly buried by later-arriving messages
- **Always insert tasks with `seq = MAX(seq) + 2`** (host uses even numbers, container uses odd)

### Container never writes to inbound.db
- `markProcessing` and `markCompleted` write to `processing_ack` in `outbound.db`
- `inbound.db` status column is only updated by the host-sweep (reads processing_ack → syncs to inbound.db)
- A task showing `status='pending'` in inbound.db may already be completed in processing_ack

### process_after semantics
- `NULL` = immediately due, fires on every sweep until completed
- ISO 8601 UTC string = fires when `datetime('now') >= datetime(process_after)`
- Recurring tasks: host-sweep resets `process_after` to next cron time after sync-ing completion

### Transcript deletion vs session_state
- Deleting the `.jsonl` transcript does NOT clear `session_state` in outbound.db
- The continuation session ID in `session_state` will cause a "No conversation found" error on next resume
- Must either: (a) clear `session_state` explicitly, or (b) let `isSessionInvalid` detect and recover (post-fix: silently)

### OAuth subscription token expiry
- Container auth uses OneCLI proxy wired at Docker network level (not via `ANTHROPIC_BASE_URL`)
- The `Anthropic` secret in OneCLI vault is an OAuth subscription token (`sk-ant-oat...AA`)
- These tokens expire / get revoked; symptom: every agent response is `"Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead"`
- The container loops on this error for the full 30-min absolute ceiling, then gets killed; tasks are marked completed by `resetStuckProcessingRows` but no output is written to `outbound.db`
- No auto-refresh: `register-claude-token.sh` extracts only the access token (not the refresh token), stores it static in OneCLI vault. OneCLI has no Claude OAuth refresh logic.
- **Fix:** `bash setup/register-claude-token.sh` — re-runs `claude setup-token`, captures fresh token, updates OneCLI vault. Delete the old vault secret after to avoid dual-injection.
- **Permanent fix:** replace vault secret with an API key (`sk-ant-api03...`) — API keys don't expire. Update via `onecli secrets update --id <id> --value sk-ant-api03...`
- **Detection (implemented 2026-05-28):** `poll-loop.ts` now detects this error string in result text, writes `kind='system-alert'` to outbound.db immediately (no 30-min burn), and breaks the loop. `delivery.ts` handles `system-alert` by DMing the owner via `pickApprovalDelivery('whatsapp')` with the fix command. 1-hour dedup per agent group.

---

## Files Changed

| File | Change |
|------|--------|
| `container/agent-runner/src/poll-loop.ts` | Stale session errors suppressed (not posted to group) |
| `container/agent-runner/src/providers/claude.ts` | `settingSources: ['project','user','local']` — loads CLAUDE.local.md |
| `groups/ops-with-netra/CLAUDE.local.md` | Simplified Response Gate to match mention-only architecture |
| `data/v2.db` `messaging_group_agents` | `engage_mode=mention`, `engage_pattern=netra\|netra-ops\|918466971926` |
| `inbound.db` `messages_in` | All tasks fixed: `recurrence`+`series_id` added, seq bumped to MAX+2; duplicate escalation task deleted |
| OneCLI vault | Old expired OAuth token deleted; fresh token registered via `register-claude-token.sh` |
| `container/agent-runner/src/poll-loop.ts` | Auth error detection: breaks loop on subscription-disabled text, writes `system-alert` to outbound.db |
| `src/delivery.ts` | `system-alert` handler: DMs owner via `pickApprovalDelivery`, 1h dedup |
| `~/.zshrc` `ncstatus()` | Claude auth section added: shows vault secret age, flags if recent transcripts contain auth errors |
