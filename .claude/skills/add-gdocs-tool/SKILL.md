---
name: add-gdocs-tool
description: Add Google Drive/Docs as an MCP tool (read, search, list Google Docs and Drive files) using OneCLI-managed OAuth. The agent gets Drive tools in every enabled group; OneCLI injects real tokens at request time so no raw credentials ever reach the container. Read-only by default.
---

# Add Google Docs / Drive Tool (OneCLI-native)

This skill wires [`@modelcontextprotocol/server-gdrive`](https://www.npmjs.com/package/@modelcontextprotocol/server-gdrive) into selected agent groups. The MCP server reads stub credentials containing the `onecli-managed` placeholder; the OneCLI gateway intercepts outbound calls to `*.googleapis.com` and injects the real OAuth bearer from its vault.

Tools exposed (surfaced as `mcp__gdrive__<name>`): `search` (full-text search across Drive), `get_file_contents` (reads any Drive file — Docs are returned as Markdown text, Sheets as CSV, Slides as text, PDFs as text), `list_files` (directory listing by folder/query). Exact tool set depends on version — run `tools/list` against the server to enumerate.

**Why this package:** `@modelcontextprotocol/server-gdrive` is the official MCP SDK reference implementation for Google Drive. It natively exports Google Docs as text (no binary download needed), supports any Drive file type, and uses the same OAuth stub pattern as `/add-gmail-tool` and `/add-gcal-tool`.

**Scope:** `drive.readonly` by default — agents can read and search all files but cannot write, move, or delete. If the use case requires writes, reconnect in OneCLI with `drive` (full) scope.

## Phase 1: Pre-flight

### Verify OneCLI has Google Drive connected

```bash
onecli apps get --provider google-drive
```

Expected: `"connection": { "status": "connected" }` with scopes including `drive.readonly`.

If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → Google Drive, and click Connect. Sign in with the Google account whose documents the agent should be able to read. `drive.readonly` is sufficient for reading; use `drive` if the agent also needs to create or edit files.

### Verify stub credentials exist

The stub lives at `~/.gdrive-mcp/` by convention (mirroring `~/.gmail-mcp/` from `/add-gmail-tool`).

```bash
ls -la ~/.gdrive-mcp/gcp-oauth.keys.json ~/.gdrive-mcp/credentials.json 2>&1
```

If both exist with `onecli-managed`:

```bash
grep -l onecli-managed ~/.gdrive-mcp/gcp-oauth.keys.json ~/.gdrive-mcp/credentials.json
```

...skip to Phase 2. If either file has real credentials (no `onecli-managed`), **STOP** — back up and delete before proceeding.

If absent, write them:

```bash
mkdir -p ~/.gdrive-mcp
cat > ~/.gdrive-mcp/gcp-oauth.keys.json <<'EOF'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
EOF
cat > ~/.gdrive-mcp/credentials.json <<'EOF'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/drive.readonly"
}
EOF
chmod 600 ~/.gdrive-mcp/*.json
```

### Verify mount allowlist covers the path

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

`~/.gdrive-mcp` must sit under an `allowedRoots` entry (e.g. `/home/<user>` or `/Users/<user>`). If it doesn't, run `/manage-mounts` first or add the home directory.

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject Drive credentials:

```bash
onecli agents list
```

`secretMode: all` is sufficient. If `selective`, explicitly assign the Drive secret:

```bash
GDRIVE_IDS=$(onecli secrets list | jq -r '[.data[] | select(.name | test("(?i)drive|gdrive")) | .id] | join(",")')
CURRENT=$(onecli agents secrets --id <agent-id> | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,$GDRIVE_IDS" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id <agent-id> --secret-ids "$MERGED"
onecli agents secrets --id <agent-id>
```

## Phase 2: Check Code Changes

`@modelcontextprotocol/server-gdrive` is pre-installed in the container image. Verify:

```bash
grep -q 'GDRIVE_MCP_VERSION' container/Dockerfile && \
echo "ALREADY IN IMAGE — no Dockerfile changes needed, skip to Phase 3"
```

If the grep fails (unexpected on a standard install), add the ARG and install block following the same pattern as `/add-gmail-tool`:

```dockerfile
ARG GDRIVE_MCP_VERSION=2025.1.14
```

And in the pnpm global-install block:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@modelcontextprotocol/server-gdrive@${GDRIVE_MCP_VERSION}"
```

Then rebuild: `./container/build.sh`

**No `TOOL_ALLOWLIST` edit needed.** `container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map, so registering `gdrive` in Phase 3 automatically allows `mcp__gdrive__*`.

## Phase 3: Wire Per-Agent-Group

For each agent group, persist two changes to the **central DB** (`data/v2.db`): the `mcpServers.gdrive` entry and an `additionalMounts` entry for `.gdrive-mcp`. Both flow through `materializeContainerJson` on every spawn — editing `groups/<folder>/container.json` by hand does **not** stick.

### List groups, pick which ones get Drive

```bash
ncl groups list
```

### Register the MCP server

For each chosen `<group-id>`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name gdrive \
  --command mcp-server-gdrive \
  --args '[]' \
  --env '{"GDRIVE_OAUTH_PATH":"/workspace/extra/.gdrive-mcp/gcp-oauth.keys.json","GDRIVE_CREDENTIALS_PATH":"/workspace/extra/.gdrive-mcp/credentials.json"}'
```

From a host shell this executes immediately. From inside a container it is approval-gated (an admin must approve before it lands).

### Add the `.gdrive-mcp` mount

There is no `ncl groups config add-mount` verb yet (tracked in [#2395](https://github.com/nanocoai/nanoclaw/issues/2395)). Edit the DB directly via the in-tree wrapper:

```bash
GROUP_ID='<group-id>'
HOST_PATH="$HOME/.gdrive-mcp"
MOUNT=$(jq -cn --arg h "$HOST_PATH" '{hostPath:$h, containerPath:".gdrive-mcp", readonly:false}')
pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
  SET additional_mounts = json_insert(additional_mounts, '\$[#]', json('$MOUNT')), \
      updated_at = datetime('now') \
  WHERE agent_group_id = '$GROUP_ID';"
```

Run from the NanoClaw project root. `$[#]` appends to the JSON array without disturbing existing mounts. `readonly:false` — the MCP server writes a token cache file on first auth; the mount must be writable.

**Switch to `ncl groups config add-mount` once #2395 lands.**

## Phase 4: Restart

```bash
pnpm run build
```

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Kill any running containers so they respawn with the updated mcpServers config:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## Phase 5: Verify

### Test from a wired agent

> Send: **"search my Google Drive for the quarterly report"** or **"list recent documents in my Drive"** or **"read the contents of my onboarding doc"**.
>
> First call takes 2–3s while the MCP server starts and OneCLI does the token exchange.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log | grep -iE 'gdrive|drive|mcp'
```

Common signals:
- `command not found: mcp-server-gdrive` → image not rebuilt or `GDRIVE_MCP_VERSION` ARG missing.
- `ENOENT ...credentials.json` → mount missing or not in allowlist.
- `401 Unauthorized` from `*.googleapis.com` → OneCLI isn't injecting; verify agent secret mode and that Google Drive is connected (`onecli apps get --provider google-drive`).
- Agent says "I don't have Drive tools" → `gdrive` MCP server not registered for this group (re-run the `ncl groups config add-mcp-server` step in Phase 3 for that group and restart it), or image is stale (rebuild with `./container/build.sh`).
- `insufficient authentication scopes` → Drive app in OneCLI was connected with a scope that doesn't include `drive.readonly`. Reconnect via the OneCLI web UI.

## Removal

1. For each group that had Drive wired, remove the MCP server:
   ```bash
   ncl groups config remove-mcp-server --id <group-id> --name gdrive
   ```
2. Remove the `.gdrive-mcp` mount (no `remove-mount` verb yet — same #2395 dependency):
   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "UPDATE container_configs \
     SET additional_mounts = (SELECT json_group_array(value) FROM json_each(additional_mounts) \
                              WHERE json_extract(value, '\$.containerPath') != '.gdrive-mcp'), \
         updated_at = datetime('now') \
     WHERE agent_group_id = '<group-id>';"
   ```
3. Restart the service and kill containers.
4. (Optional) `rm -rf ~/.gdrive-mcp/` and `onecli apps disconnect --provider google-drive`.

No Dockerfile changes to revert — `@modelcontextprotocol/server-gdrive` is a core image package, not removed when this skill is uninstalled.

## Notes

- **Google Docs are returned as Markdown text** — `get_file_contents` asks the Drive API for `text/plain` or `text/markdown` export, so the agent receives readable text rather than the binary `.docx` format.
- **Shared drives are included** — the Drive API with `drive.readonly` scope returns files from both My Drive and any Shared Drives the account has access to.
- **Rate limits:** Drive API has a 1000 requests/100 seconds/user limit. For bulk document reading, add delays or batch via `search` first, then `get_file_contents` for specific files.
- **Credential cache:** On first use the MCP server writes a token cache to the mounted `.gdrive-mcp/` directory. Subsequent starts skip the auth handshake and are faster.

## Credits & references

- **MCP server:** [`@modelcontextprotocol/server-gdrive`](https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive) — official MCP reference implementation, MIT-licensed.
- **Skill pattern:** sibling of [`/add-gmail-tool`](../add-gmail-tool/SKILL.md) and [`/add-gcal-tool`](../add-gcal-tool/SKILL.md).
