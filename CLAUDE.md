# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local full-text search engine over coding-agent session transcripts (Claude Code, Codex CLI, pluggable others). It makes no LLM calls: indexing and search are plain SQLite FTS5. It has an Express + TypeScript backend and a React + Vite frontend, set up as npm workspaces under one root `package.json`.

## Commands

Run from the repo root (Node version in `.nvmrc`, currently 22.9.0):

```bash
cp .env.example .env         # all paths and settings come from .env
npm install                  # installs both workspaces
npm run build                # frontend (tsc -b && vite build), then backend (tsc)
npm start                    # node backend/dist/index.js: serves the API and the built frontend on PORT (default 4173)

npm run dev:backend          # ts-node-dev --respawn on backend/src/index.ts (port 4173; stop the Docker container first)
npm run dev:frontend         # Vite dev server on :5173; proxies /api to localhost:4173

docker compose up -d --build # always-on deployment; session dirs are bind-mounted read-only
curl -X POST http://localhost:4173/api/reindex   # force a rescan
```

`config.ts` loads the repo-root `.env` and resolves a relative `INDEX_DB_PATH` against the repo root, so dev runs from `backend/` use the same `data/index.sqlite3` as everything else. (Before this, a run from `backend/` silently opened a stray `backend/data/` index.) Never run the dev server and the Docker container at the same time: they would open the same index.

There is no test suite and no linter. `npm run build` (strict `tsc` in both workspaces) is the only automated check.

Use the Node version in `.nvmrc` (`nvm use`). `better-sqlite3` is a native addon compiled for whichever Node ran `npm install`, so switching Node versions afterwards needs `npm rebuild better-sqlite3`.

**Verifying changes.** Past changes were checked by running the built server against real session data and calling the API, e.g. `GET /api/search?q=<term>&agent=codex`. For anything that writes (rebuild, schema migrations), run on a spare port against a *copy* of the index: `PORT=4180 INDEX_DB_PATH=/tmp/copy.sqlite3 npm start`. Don't experiment on the live index (see below). A running Docker container keeps the old build until `docker compose up -d --build`.

## Architecture

**Adapters are the only agent-specific code.** `backend/src/adapters/types.ts` defines `AgentAdapter`: `listSessions()` yields `SessionMeta`, `readMessages()` streams normalized `{role, text, timestamp}`, and `buildResumeTemplate()` builds the resume command. `buildRebuiltTranscript()` is optional. `adapters/registry.ts` maps ids from `ENABLED_AGENTS` to factories. An adapter whose `isAvailable()` returns false is skipped with a warning, not an error. To add an agent, write one adapter file, add one registry line, and add its settings to `config.ts`. Keep the indexer, routes and frontend agent-agnostic.

**A session can span several files.** Codex writes each subagent's work to its own rollout file whose `session_meta` carries the *parent's* `session_id` but its own `id`. `CodexAdapter.listSessions` groups files by `session_id`, takes the file whose own id equals it as the main one, and returns the rest in `SessionMeta.relatedFiles`; `readMessages` interleaves all of them by timestamp, prefixing subagent roles with `subagent:` (presented as background: tool activity as usual, its own user/assistant text as `meta`). The indexer takes the newest mtime across the files, so a change to any of them re-indexes the session. Don't key sessions on a per-file id for Codex, or one conversation turns into dozens of rows that overwrite each other.

**Text extraction is schema-agnostic on purpose.** `adapters/textExtract.ts` walks each parsed JSONL line and collects any string values, with size caps and base64/blob filtering. This keeps adapters working when the CLIs change their transcript schemas. Don't replace it with hard-coded field paths.

**Indexing** (`indexer.ts`): `runFullScan` runs at startup and then every `REINDEX_INTERVAL_SECONDS`. A session is reindexed only when its file mtime differs from `sessions.indexed_mtime_ms`. Reindexing reads the whole session first, then replaces its `messages` rows in one synchronous transaction, so a read failure or crash leaves the old rows and mtime untouched (the session is retried next scan, and one unreadable session doesn't stop the others). **Paths are resolved, not stored** (`paths.ts`). A transcript's absolute path depends on the environment (host: `~/.claude/projects/...`; Docker: `/sessions/claude-code/...`), so the index stores `sessions.rel_path`, the path *under the agent's sessions root*, which is identical everywhere, and `resolveSessionPaths()` builds the real file path (`adapter.sessionsDir` + `rel_path`) and the display path (`adapter.hostSessionsDir ?? sessionsDir` + `rel_path`) at runtime. Availability, the resume display and rebuild all use it, so switching between Docker and a host run needs no refresh and no re-index. `file_path`/`display_path` remain only as what the last scan saw; never trust them. Rows from before `rel_path` existed are backfilled at startup by `backfillRelPaths` (metadata only), and the scan keeps `rel_path` current for unchanged sessions. If you add anything that opens a transcript, resolve its path; don't read `file_path`. Only one scan runs at a time: `runFullScan` is single-flight, and a caller arriving mid-scan shares the running scan's result. Keep it that way: never `await` between deleting a session's rows and finishing its inserts, and never write index rows outside a transaction. `index.ts` handles SIGTERM/SIGINT by closing the DB (Node as container PID 1 otherwise ignores SIGTERM and gets SIGKILLed). FTS5 (`messages_fts`) is an external-content table kept in sync by triggers in `db.ts`. Schema changes go in `db.ts` as `CREATE ... IF NOT EXISTS` plus `PRAGMA table_info`-based `ALTER TABLE` migrations for existing indexes.

**The index holds data that exists nowhere else. Never lose it.** The indexer never deletes a session row when its file disappears. Agent CLIs (or cleanup settings like Claude Code's `cleanupPeriodDays`) do delete transcripts, so for those "dead" sessions the index is the *only* remaining copy, and the tool is used for exactly that. Rules:
- Never delete, recreate, truncate or "reset" the index as a fix, and never run destructive experiments on it. Schema changes are additive migrations only.
- Before any risky operation on the index, take a consistent backup with SQLite's backup API (`sqlite3 <db> ".backup <file>"`, or `db.backup()` in better-sqlite3), not a plain `cp` while it's open.
- Code that deletes `messages` rows (the indexer's reindex) must only touch sessions whose transcript file is present and being re-read.
- Journal mode is `INDEX_JOURNAL_MODE` (`db.ts`): `wal` (default for host runs) or `delete` (rollback journal; `docker-compose.yml` defaults to this). WAL needs shared memory on the same machine, which a bind mount through a VM (Docker Desktop's virtiofs) or a network share doesn't reliably give. The index was found corrupt on 2026-11-11 while stored on a virtiofs bind mount in WAL mode with a single writer; the root cause is **unproven** (see CLAUDE.local.md). `delete` mode still relies on file locks and write ordering, so it reduces the risk rather than removing it. `db.ts` also sets `synchronous = FULL` and throws at startup if the requested journal mode can't be applied. The server uses a single connection, so `delete` costs no concurrency.
- Don't open the live index from the host (not even read-only, not even the `sqlite3` CLI) while the container is running: lock visibility across the virtiofs bridge is unreliable. Stop the container first, or work on a `.backup` copy.
- To check health: `PRAGMA quick_check;` and `INSERT INTO messages_fts(messages_fts) VALUES('integrity-check');`. To recover: `sqlite3 bad.db ".recover" | sqlite3 recovered.db`, copy the rows into a fresh schema, then verify the dead sessions against an older backup.

**Search** (`routes/search.ts`): `toFtsQuery` quotes every whitespace-separated term, so user input never reaches FTS5 syntax. SQLite only allows `snippet()`/`bm25()` in the top-level SELECT doing the MATCH (not in a subquery or under GROUP BY), so the query returns ranked message rows (capped at 1000) and the grouping into per-session results happens in JS. Results include `available` (the transcript file still exists).

**Resume commands** (`config.ts`): `renderResumeTemplate` substitutes `{sessionId}`/`{cwd}` and leaves a literal `{args}` slot, appended at the end if the template has none. The API returns both `resumeTemplate` (slot kept) and `resumeCommand` (filled with the `.env` default `*_RESUME_ARGS`). The frontend fills the slot from per-browser overrides kept in `localStorage` (`frontend/src/settings.ts`, `SettingsPanel.tsx`). `fillArgsSlot` exists twice, in `backend/src/config.ts` and `frontend/src/api.ts`, so change both together. The tool only displays the command and never runs it: resuming needs the user's own terminal (TTY), and the server runs detached.

**Docker path mapping:** inside the container, `*_SESSIONS_DIR` are mount paths (`/sessions/...`). `*_HOST_SESSIONS_DIR` plus `toDisplayPath` turn them back into host paths for display. `SessionMeta.filePath` is the path that gets read; `displayPath` is the path shown to the user. Don't mix them up.

**Rebuilding missing sessions** (`rebuild.ts`, `adapters/claudeCodeRebuild.ts`, `routes/sessions.ts`, Claude Code only): writes a lossy plain-text transcript back to the original path from indexed text. Invariants:
- Files are created exclusively and never overwritten. The target must be inside the adapter's `sessionsDir` and writable. In Docker that requires `CLAUDE_CODE_SESSIONS_MOUNT_MODE=rw`.
- Before writing, indexed messages are copied to `messages_archive`. Every rebuilt line carries `"rebuiltFromIndex": true` (`REBUILT_LINE_FLAG`). Adapters skip flagged lines, and the indexer puts archived messages back ahead of any new turns, so the index never degrades to the lossy copy.
- `GET .../rebuild` is a dry-run eligibility check and `POST` performs the rebuild. The POST rejects requests whose `Origin` header doesn't match the host; the API otherwise allows CORS from any origin.
- The rebuilt file opens with a `[Reconstructed session: rebuilt by agent-session-search ...]` user turn. `claudeCodeRebuild.ts` drops injected text (`<system-reminder>`, the local-command `Caveat:` preamble) so it doesn't become fake user prompts, and folds tool calls and results into assistant text.

**Conversation viewer** (a right-hand drawer opened from a search result; design in `docs/plans/conversation-viewer.md` if present). It reads one session's messages from the index, not from the transcript file, so it works for dead sessions. Backend: `GET /api/sessions/:agent/:id/messages?anchor=&before=&after=` returns a window of rows around a seq, `GET .../matches?q=` lists the matching seqs, and `GET /api/sessions/:agent/:id?messages=0` returns just the header. `messages.role` is really the record *type*, and the text is flattened, so each adapter implements the optional `presentMessage()` (`claudeCodePresent.ts`, `codexPresent.ts`; fallback in `present.ts`) to classify a row as user / assistant / tool_call / tool_result / thinking / meta and strip block-type prefixes. The window quota counts only user and assistant turns, with a hard cap of 400 rows per response. A tool result says which tool it answers ("Bash result", not an opaque `toolu_…` id): `toolPairing.ts` matches each result to its call by id where the index has one (Claude Code) and by position otherwise (Codex outputs carry no id in the index; each output directly follows its own call), looking back `CALL_LOOKBACK_ROWS` rows when a page starts with results whose calls are on the previous page. `/messages` rows carry `toolName`, `toolCallId` and `callSeq`. Search results carry `bestKind`/`bestToolName`, and `bestSnippet` is cut from the cleaned display text (`snippet.ts`) so it never begins with an id or block-type token, with the full-text index's own snippet as a fallback. Frontend (`ConversationPanel`, `MessageList`, `MessageItem`): the panel is a modal dialog (focus trap, Esc, `inert` on the page behind, focus returned to the opener by `App`). The URL hash `#view=<agent>/<sessionId>/<seq>` mirrors it, so Back closes it and the link can be shared. `MessageList` pages in both directions; when older rows are prepended it restores the scroll position itself, which is why the scroller has `overflow-anchor: none`. All text is rendered as React nodes (`highlight.tsx`), never as HTML.

**Icons** are individual SVG files in `frontend/src/assets/icons/` (no icon package), with sources, pinned commits, licences and a trademark note in `NOTICE.md` there. Add any new file to that table. Single-colour UI icons (Lucide, ISC) are drawn with a CSS mask by `MaskIcon` so they follow the theme; the agent logos (lobe-icons, MIT) are coloured and shown with `<img>` by `AgentBadge`. `agentIcons.ts` maps agent id to icon and falls back to a neutral one, so a new adapter works without touching the frontend. Tooltips are the CSS-only `.has-tip` / `data-tip` pattern (it also shows on keyboard focus, which `title` doesn't).

## Known open issues

These came up in a code review and were deliberately left unfixed:
- `available` is computed with a synchronous `fs.existsSync` for each search result.

## Conventions

- Keep the repo generic: no hardcoded user paths, usernames or orgs. New settings go in `config.ts` and `.env.example` (and `docker-compose.yml` if they matter in Docker). `~` is expanded with `expandHome`.
- The tool only reads session files. The rebuild feature is the single, opt-in exception.
