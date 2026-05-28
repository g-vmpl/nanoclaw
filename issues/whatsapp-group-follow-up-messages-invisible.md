# WhatsApp Group: Follow-up Messages Invisible After First Reply

**Status:** Fixed (verified 2026-05-23)
**Affected component:** `src/channels/whatsapp.ts` — `getNormalizedGroupMetadata`, `cachedGroupMetadata`, `groups.update` handler
**Related upstream:** [nanocoai/nanoclaw#2535](https://github.com/nanocoai/nanoclaw/issues/2535) — LID encryption desync

---

## Description

In WhatsApp groups with 3+ members (agent + 2+ humans), agent messages are invisible to group members after the first reply. Pattern:

1. Restart host → agent sends message 1 → **visible to all** ✓
2. Agent sends message 2+ → **invisible to all members** ✗

Host logs confirm delivery with valid WA message IDs (`platformMsgId`). Agent container logs show correct responses. Issue is silent — WA server accepts all messages, no errors returned.

Workaround (before fix): restart host. Only message 1 after each restart is visible.

**Does not occur** in 1:1 DMs or groups where agent is the only non-owner member.

---

## Investigation

### Ruled out

- **Admin permissions** — made agent a group admin, no effect
- **Baileys version** — upgraded `@whiskeysockets/baileys` rc9 → rc13, no effect
- **`getMessage` callback** — was returning `proto.Message.create({})` (empty proto). Changed to return `undefined` so Baileys fetches from WA server on retry. No effect on visibility.
- **Host-side delivery** — confirmed working; all messages get valid `platformMsgId` ACKs from WA

### Key observations

1. **`groups.update` fires with no subject change after every group send** — WA server sends a server-pushed group state notification back to the client after each send. This is WA signaling that sender key redistribution (SKDM resend) is needed for participants it can't route to.

2. **LID translations in logs** — participants with newer WA multi-device sessions appear as `@lid` JIDs (e.g., `37263555739869@lid`, `69724566253686@lid`). These are translated to phone JIDs at inbound message time.

3. **Signal session churn in logs** — `Decrypted message with closed session` entries visible in error log. Sessions close and reopen between messages, consistent with SKDM desync.

4. **`sender-key-memory-<group>.json` files** — Baileys persists sender key memory to disk under `store/auth/`. These track which participants have received the agent's sender key. Stale entries here cause Baileys to skip SKDM redistribution for subsequent messages.

### Root cause (two-part)

**Part 1 — LID pre-translation in `cachedGroupMetadata` (original bug):**

`getNormalizedGroupMetadata` was translating participant LID JIDs → phone JIDs before returning metadata to Baileys:

```typescript
// BROKEN — was doing this:
const participants = await Promise.all(
  metadata.participants.map(async (p) => ({
    ...p,
    id: await translateJid(p.id),  // ← translates LID → phone JID
  })),
);
```

Baileys v7 handles LID internally via `signalRepository.lidMapping`. When pre-translated:
1. Baileys receives participant list with phone JIDs (`919650404404@s.whatsapp.net`)
2. Looks up signal session under phone JID
3. Actual session is stored under LID (`37263555739869@lid`)
4. Session mismatch → SKDM sent under wrong key
5. Message 1 works (fresh session), message 2+ fails (stale wrong session)

Fix: return raw metadata without translating participant IDs.

**Part 2 — `groups.update` event unhandled (root cause of persistence after Part 1 fix):**

After fixing Part 1, WA still pushes `groups.update` after each group send. This is WA signaling that sender key state has changed and redistribution is needed. Without a handler:

- Baileys' in-memory and on-disk `sender-key-memory` stays stale
- Next send: Baileys sees "already distributed sender key to all participants" → skips SKDM
- Recipients still can't decrypt with the now-stale key
- All messages invisible (even message 1 after session churn from rapid reconnects)

---

## Fix

Both fixes are in `src/channels/whatsapp.ts`.

### Fix 1 — Remove LID translation from `cachedGroupMetadata`

```typescript
// FIXED — return raw metadata; Baileys resolves LID internally
groupMetadataCache.set(jid, {
  metadata,  // no participant ID translation
  expiresAt: Date.now() + GROUP_METADATA_CACHE_TTL_MS,
});
return metadata;
```

`translateJid` is still correct for **inbound** routing (sender JID → user record lookup), but must not be applied to outbound encryption metadata.

### Fix 2 — Handle `groups.update` to clear sender key memory

Save a reference to the wrapped signal key store:

```typescript
const wrappedKeys = makeCacheableSignalKeyStore(state.keys, baileysLogger);
signalKeyStore = wrappedKeys;  // outer-scoped, updated on reconnect

sock = makeWASocket({
  auth: { creds: state.creds, keys: wrappedKeys },
  ...
});
```

Add `groups.update` handler:

```typescript
sock.ev.on('groups.update', (updates) => {
  for (const update of updates) {
    if (!update.id) continue;
    groupMetadataCache.delete(update.id);
    if (signalKeyStore) {
      void Promise.resolve(
        signalKeyStore.set({ 'sender-key-memory': { [update.id]: null } }),
      ).catch((err) => log.debug('Failed to clear sender key memory', { jid: update.id, err }));
      log.info('Cleared sender key memory on groups.update', { jid: update.id });
    }
  }
});
```

Setting `sender-key-memory[groupJid] = null` tells Baileys "no participants have the sender key for this group" → redistributes SKDMs on next send → recipients can decrypt.

### Emergency recovery (degraded signal state)

If the session has accumulated stale sender-key-memory from many reconnects, delete the file directly and restart:

```bash
rm store/auth/sender-key-memory-<group-jid>.json
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

---

## Commits

- Baileys rc9 → rc13 upgrade attempt (no effect, reverted)
- `getMessage` callback: `proto.Message.create({})` → `undefined`
- **Fix 1:** Remove LID→phone translation from `cachedGroupMetadata`
- **Fix 2:** Save `signalKeyStore` reference; add `groups.update` handler to clear sender key memory

---

## Verification

Log confirms fix is active when `groups.update` fires after a group send:

```
[16:15:05] INFO Cleared sender key memory on groups.update jid="120363409765528962@g.us"
```

Test: restart → send 5+ messages to group with LID participants → all visible to all members.
