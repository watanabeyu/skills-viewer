# skills-viewer

Browse, search and manage your [Claude Code](https://code.claude.com) skills, commands, agents, hooks and auto memory in the browser.

Scans every project registered in `~/.claude.json` (plus user scope, plugins and built-ins), and serves a local web UI to explore them — with usage stats, AI-generated summaries, full SKILL.md rendering, same-name diffs, and copy/delete management.

```bash
npx skills-viewer
```

> Zero runtime dependencies. The published package ships a prebuilt UI; `npx` installs in seconds.

<!-- 相対パス参照: private リポジトリでも GitHub 上で表示でき、npmjs.com は repository フィールドを元に raw URL へ書き換えるため public 化後は npm でも表示される -->

![Skills Viewer — grid view with per-scope grouping, usage stats and AI summaries](docs/screenshot.png)

## Features

- **All scopes in one view** — user (`~/.claude/skills`), every project's `.claude/skills` / `.claude/commands`, installed plugins, and Claude Code built-ins, grouped by source
- **Purpose grouping (AI)** — one haiku call classifies everything installed by _when you use it_ into 4–8 groups generated for your environment (planning / building / review / release / … as a role-agnostic guide — a designer's or PM's skills get their own groups). Switch the list between by-source, by-purpose and flat views; a frontmatter `category:` pins an item to a manual group that takes precedence
- **Search / sort** — incremental search over name + description + usage; sort by name, usage count, last used, updated date, or token cost
- **Diagnostics** — a _no recent use_ badge (no recorded use within the transcript retention window) with an all / recent use / no recent use filter, plus static description lint: missing / too-short / too-long descriptions, missing trigger conditions ("use when …") that make auto-invocation unlikely, and name-echo descriptions
- **Token cost** — since every name + description is injected into each session, the estimated token overhead is shown per item, per scope, and as a per-session total for the current project
- **AI trigger diagnosis** — one click asks the model whether the description is likely to trigger auto-invocation, lists concrete issues, and proposes an improved description you can apply with one click (cached by content hash)
- **AI flow diagram** — extract the processing flow of orchestration-style skills (steps, branches, delegations, human gates) from the definition body and render it as a step diagram; delegated skills are clickable
- **AI model choice** — pick the model behind all AI features (haiku default / sonnet / opus) in settings; aliases are resolved by your claude CLI
- **Memory triage** — a _Memory_ view lists Claude Code's auto memory (`~/.claude/projects/<project>/memory/`) per project with its context cost split into the always-on part (the `MEMORY.md` index line injected into every session) and the pay-per-use part (the body, read on demand), plus Read / Write counts from transcripts, `[[link]]` resolution and backlinks. **AI triage** reads every memory of a project with the claude CLI (one call, split into a few for very large projects) and proposes a destination per memory — keep / shrink / move to CLAUDE.md / move to docs / move to a skill / delete / wrong project — with the reasoning and a paste-ready instruction for Claude Code (it is asked to always cover removing the `MEMORY.md` index line and re-pointing `[[link]]`s). Each memory is first judged for freshness (current / outdated / historical / obsolete) from mechanical signals — dates in the body, missing paths, merged or deleted branches, references to another project — and a _rewrite the body_ verdict covers memories whose gist still holds; the triage also flags when the `MEMORY.md` index line disagrees with the body. For feedback memories the instruction is built from a fixed template, so it reads the same on every model. The viewer never writes to memory: you paste the instruction into Claude Code, which inspects, asks when unsure, and executes after your approval
- **Edit in the browser** — inline editor for SKILL.md / commands / agents (project & user scopes) with mtime conflict detection and a one-generation backup in `~/.cache/skills-viewer/backups/`
- **What's changed** — a banner shows items added / updated / removed since your last launch (baseline advances only when you dismiss it); the CLI prints a one-line summary at startup too
- **Usage sparkline** — the detail pane charts the last 30 days of per-day usage
- **Usage stats** — invocation counts and last-used dates aggregated from Claude Code session transcripts (`~/.claude/projects/`), covering both user-typed `/skill` calls and model-invoked Skill tool calls
- **AI summaries** — one-click summarization of each SKILL.md via `claude -p --model haiku`, cached by content hash in `~/.cache/skills-viewer/` so unchanged skills are never re-summarized
- **Detail pane** — master/detail layout with an Overview tab (description, usage, bundled files) and a rendered SKILL.md tab
- **Agents & hooks too** — `.claude/agents/*.md` and `hooks` entries from `settings.json` / `settings.local.json` are listed alongside skills with kind badges (hooks are read-only)
- **Manage** — copy a skill/command/agent to another project or to user scope (`-copy` suffix on name conflicts), or delete it — deletions go to the OS trash, not `rm`. Plugin and built-in entries are read-only
- **Same-name diff** — when the same skill name exists in multiple scopes, the detail page lists the other definitions and shows a line diff between them
- **Open in editor** — via URL scheme (VS Code / Cursor / Zed / Windsurf / custom, configurable in the ⚙ settings modal), or the OS default opener
- **English / 日本語** — UI language auto-detected from the browser and switchable in settings; AI summaries are generated in the selected language (CLI messages follow `LANG`)
- **URL routing** — `/skills/:id?tab=md`, `/memory/:id`, `/memory/triage/:project`, search/sort/grouping in query params; links are shareable across reloads

## Usage

```bash
npx skills-viewer              # scan + open browser (default port 4763)
npx skills-viewer --port 5000  # custom port
npx skills-viewer --no-open    # don't open the browser
```

Run it from a project directory to have that project marked as “current” and listed first. Reloading the page rescans the filesystem.

## Security

- Binds to `127.0.0.1` only
- Mutating APIs require a per-run token that other origins cannot read (same-origin policy), and requests with a non-localhost `Origin` are rejected
- Copy/delete are restricted to `.claude/skills/` / `.claude/commands/` / `.claude/agents/` paths; plugin directories are never written to; deletions go to the OS trash

## Development

```bash
pnpm install
pnpm dev        # tsx watch API server (4763) + Vite dev server (5173, /api proxied)
pnpm build      # web UI → dist/, server TS → build/
pnpm typecheck  # web + server
pnpm start      # serve dist/ + API (what npx users get)
```

Layout:

```
src/
├─ cli.ts         # bin entry
├─ server/        # zero-dep Node API (scan / usage / summary / manage) — TypeScript
└─ shared/        # types shared between server and web (single source)
web/              # React + TypeScript + Vite (devDependencies only — bundled into dist/)
build/            # compiled server JS shipped in the npm package (generated by prepack)
dist/             # prebuilt UI shipped in the npm package (generated by prepack)
```

## Notes

- Usage stats only cover the transcript retention window of Claude Code (`cleanupPeriodDays`, default 30 days) — the _no recent use_ badge and memory Read counts have the same limitation (projects without transcripts show no usage columns at all)
- Token costs are heuristic estimates (≈4 chars/token for ASCII, ≈1.5 for CJK), not exact tokenizer counts
- Usage is attributed per calling project (worktrees roll up to their parent project by encoded-path prefix). When scopes share a name, the resolution order project > user > plugin > built-in is assumed
- The built-in skill list is hardcoded in `server/scan.js` (they live inside the Claude Code binary); check `/skills` inside Claude Code for the authoritative list
- AI summaries require a logged-in `claude` CLI
- Memory triage sends each memory's body to the claude CLI, together with the project's `MEMORY.md` index, the **headings** of `CLAUDE.md` / `.claude/CLAUDE.md` / `~/.claude/CLAUDE.md` and the names + descriptions of the skills available to that project (never their bodies) so it can spot duplicates and promotion targets. Branch status for the freshness signals comes from local `git` (no network). Results are cached per memory by content hash (plus the index line); memory files themselves are never modified

## License

MIT

---

This is an unofficial community tool, not affiliated with Anthropic.
