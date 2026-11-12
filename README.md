# Agent Session Search

A local, self-hosted search engine over your coding-agent session history (Claude Code, Codex CLI, and any other agent you plug in). Find "which session was debugging X" or "where did I touch file Y" without spending a single LLM token — search is pure local full-text search over an indexed SQLite database built from each agent's own on-disk session files.

## Why this exists

Digging through `~/.claude/projects/**/*.jsonl` (or the equivalent for another agent) by hand with `grep` every time you want to resume an old session doesn't scale. This tool indexes those files once, watches them for changes, and gives you a fast web UI (and a JSON API) to search across all of them — filterable by agent, project/working-directory, and date — and hands you back the exact session id, file path, and the resume command to re-enter it.

## Design

- **No LLM calls, ever.** Indexing and search are 100% local text/SQL operations (SQLite FTS5). This is a search tool, not an agent.
- **Plugin architecture for agents.** Each agent's on-disk session format is wrapped behind one `AgentAdapter` class (`backend/src/adapters/`). Adding support for a new agent means writing one adapter file and registering it — no changes to the indexer, API, or frontend.
- **Fully generic / shareable.** Nothing in the code is specific to any person, org, or machine. All paths and per-agent settings come from `.env` (see `.env.example`). Safe to hand this repo to anyone.
- **Clean separation.** `backend/` (Express API + indexer + adapters) and `frontend/` (React + Vite UI) are independent npm workspaces sharing one root `package.json`.

## Tech stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Backend | Node.js + TypeScript + Express | I/O-bound workload (parse JSONL, query SQLite) — no need for Go's compute performance. Keeps one language across the whole stack (shared types with the frontend), matching every other hand-built tool in this `tools/` directory. |
| Search index | SQLite + FTS5 (`better-sqlite3`) | Zero extra services, embedded, trivially fast for this data size, ships with real full-text ranking/snippets out of the box. |
| Frontend | React + TypeScript + Vite | Pairs naturally with a TS backend (shared types), minimal build config, fast dev server. |
| Deployment | Docker Compose | Already the established "always-on service" pattern on this kind of setup (see a sibling `services/docker-compose.yml` running mysql/redis/minio with `restart: always`) — no new process manager to install or maintain. Also pins a modern Node version inside the image regardless of the host's default. |

Go was seriously considered (it's a fine fit for a single static binary), but was set aside here because: (a) a frontend is still required either way, so Go doesn't remove the two-language reality — TypeScript end-to-end does; (b) this is a low-throughput personal/team utility, not a high-QPS service, so Go's performance ceiling isn't the bottleneck; (c) it would be the only Go-authored tool in an otherwise all-TypeScript tools directory. pm2 was set aside purely because it isn't installed anywhere on the reference machine, whereas Docker Compose already is and is already the pattern used for always-on local services.

## Adding a new agent

Implement `AgentAdapter` (see `backend/src/adapters/types.ts`) in a new file under `backend/src/adapters/`, then register it in `backend/src/adapters/registry.ts`. An adapter only needs to know:

1. Where that agent stores session files (from its own `.env` variable).
2. How to enumerate session files and extract `{ sessionId, cwd, startedAt, endedAt, filePath }`.
3. How to stream normalized messages `{ role, text, timestamp }` out of one session file.
4. How to build the shell command that resumes that session.

Nothing else in the codebase needs to change. The UI shows a neutral icon for an agent it has no logo for; to give yours one, add an SVG under `frontend/src/assets/icons/` (and list it in the `NOTICE.md` there) and one line in `frontend/src/agentIcons.ts`.

## Setup

```bash
cp .env.example .env    # edit paths/ports for your machine
npm install              # installs both workspaces
npm run build
npm start                 # backend serves the built frontend + API
```

or with Docker:

```bash
cp .env.example .env
docker compose up -d --build
```

The container runs as a non-root user matching your host UID/GID (defaults to 1000:1000, a typical single-user Linux desktop's first account), so the SQLite index it writes into the bind-mounted `./data` folder comes out owned by you, not root. If your user has a different UID/GID, set `APP_UID`/`APP_GID` (e.g. in a `.env` file in this directory, picked up automatically by `docker compose`) before building.

Open the URL printed on startup (default `http://localhost:4173`).

## Resume commands and extra flags

Each result shows the command to re-enter that session, built from the agent's `*_RESUME_COMMAND` template. To add your own flags (for example `--dangerously-skip-permissions --teammate-mode in-process` for Claude Code), either:

- set a server-wide default per agent in `.env`: `CLAUDE_CODE_RESUME_ARGS=...`, `CODEX_RESUME_ARGS=...`; or
- open **Settings** in the UI and type flags per agent. This is saved in that browser and overrides the `.env` default. **Reset** returns to the default.

The flags go wherever the template has `{args}`, or at the end when it has none.

## Missing sessions and rebuilding

Every result shows whether its transcript file still exists. If an agent's file is gone (deleted, cleaned up, lost in a move), resuming fails with `No conversation found with session ID`. The index still holds the session's text, so the result is flagged **Transcript missing**.

For Claude Code, **Rebuild conversation…** writes a new transcript to the original path from the indexed text, so `claude --resume <id>` works again. It first runs a dry-run check and shows why a session can't be rebuilt if it can't. The requirements are:

- the original file is missing (the tool never overwrites; files are created exclusively);
- the target path is inside the configured sessions directory, and that directory is writable (in Docker, set `CLAUDE_CODE_SESSIONS_MOUNT_MODE=rw`);
- the session's working directory is known;
- the index holds at least one user prompt and one assistant reply.

The result is **lossy**: the index keeps flattened text only, so the rebuilt session is a plain-text conversation. Real prompts stay user turns. Replies, tool calls and truncated tool output are folded into assistant turns. Thinking and file checkpoints are gone.

Before writing, the indexed messages are copied to a `messages_archive` table, and every rebuilt line is marked `"rebuiltFromIndex": true`. When you resume and continue the session, the indexer skips the marked lines and puts the archived original text back ahead of the new turns. The index never degrades to the lossy copy, and a later rebuild includes everything. The same is available over the API: `GET /api/sessions/:agent/:id/rebuild` (dry run) and `POST` (perform). The POST refuses cross-origin browser requests.

## Reindexing

The indexer does an initial full scan on startup, then re-scans on an interval (`REINDEX_INTERVAL_SECONDS` in `.env`). You can also trigger it manually:

```bash
curl -X POST http://localhost:4173/api/reindex
```
