# Windows / macOS Release Validation Checklist

This checklist separates automated cross-platform evidence from GUI scenarios that require a real machine. Do not mark a Windows WebView2 item complete from a macOS browser result or a compile-only CI run.

## Release Record

Fill this section for every candidate build:

| Field | macOS | Windows |
| --- | --- | --- |
| App version / commit |  |  |
| OS version |  |  |
| Architecture |  |  |
| WebView runtime | WebKit | WebView2 version: |
| External CLIs | Codex / Claude / neither | Codex / Claude / neither |
| Tester and date |  |  |

## Automated Gates

The `Cross-platform quality` GitHub Actions workflow runs the same gates on `macos-latest` and `windows-latest`:

- `npm ci` from `package-lock.json`;
- LF-only tracked text validation;
- all Vitest tests, TypeScript checking, and the production Vite build;
- Rust formatting, locked tests, and locked `cargo check`;
- unsigned Tauri application compilation with `--debug --no-bundle --ci`;
- final `git diff --exit-code` to catch lockfile or generated-source drift.

Release tag/manual builds repeat the frontend and Rust gates before creating installers. External Codex or Claude CLIs are optional and must not be installed by CI or required for the packaged app to launch.

Local equivalent:

```bash
npm ci
npm run check:line-endings
npm test -- --run
npx tsc --noEmit
npm run build
cd src-tauri
cargo fmt --all -- --check
cargo test --locked
cargo check --locked
cd ..
npx tauri build --debug --no-bundle --ci
git diff --exit-code
```

## Files, Paths, And Process Safety

Run these checks on both platforms:

- [ ] Create/open/save a project whose name contains spaces, Chinese characters, emoji, and punctuation.
- [ ] Import an image and project bundle from a directory with spaces and non-ASCII characters.
- [ ] Export/reopen the bundle and confirm image, video, audio, panorama, Director Studio, history, and viewport references survive.
- [ ] Confirm temporary Agent attachment/workspace directories disappear after success, cancellation, and failure.
- [ ] Confirm an absent Codex/Claude CLI shows an unavailable runtime without blocking startup or the built-in Agent.
- [ ] If a CLI is installed, verify executable discovery does not invoke a shell string. On Windows cover direct `.exe`, trusted npm `.cmd` shims, and explicit rejection of arbitrary `.bat`; on macOS cover direct executable paths and app paths containing spaces.
- [ ] Cancel an external Agent turn and confirm its process exits, pending approvals expire, and a new built-in turn can start.
- [ ] Feed BOM/CRLF, split JSONL, malformed JSON, an oversized line, and a forbidden command/file event through the fake/runtime fixture; confirm typed terminal errors and no hanging child process.

## Loopback And Network

- [ ] Confirm the Canvas broker binds only `127.0.0.1` with an ephemeral port.
- [ ] Wrong token, expired token, wrong session id, and reused/revoked token all fail without executing a canvas command.
- [ ] Start with a preferred port already occupied; startup must choose another local port or report a bounded actionable error, never bind externally.
- [ ] Inspect process arguments and logs: capability tokens must not appear in URLs, command lines, diagnostics, or event payloads.
- [ ] Test system proxy and direct routes. Classify DNS, TLS/certificate, proxy tunnel, timeout, HTTP 429, response parse, and download failures consistently.
- [ ] Put the machine to sleep during a recoverable poll, wake it, and confirm polling resumes without replaying the paid POST.
- [ ] Change proxy settings after submission and confirm the persisted generation job keeps its original route.

## Canvas And Agent GUI

- [ ] Open/close the Agent drawer repeatedly; confirm focus return, Escape, backdrop, and transitions do not resize or flash the canvas.
- [ ] Switch Built-in / Codex / Claude and verify unavailable, login-required, ready, running, approval, canceled, crashed, and restored states.
- [ ] Trigger read, create/update/delete, configuration, and generation tools. Every operation must show an application approval card before execution.
- [ ] Reject a tool and confirm canvas revision/history are unchanged. Approve one and confirm receipt, rollback, and “locate on canvas” work.
- [ ] Attach an uploaded image and a canvas image; confirm supported models see them and missing assets produce an actionable error.
- [ ] Exercise tags/groups, bulk import, drag, zoom, multi-selection, undo/redo, Director Studio playback/recording, panorama, and settings transitions.
- [ ] Verify Chinese and English text, IME composition, shortcuts outside inputs, reduced motion, light/dark theme, and minimum supported window size.
- [ ] Inspect the WebKit/WebView2 console for uncaught errors during the happy path and runtime failure path.

## Packaging And Offline Startup

- [ ] Install the unsigned/internal candidate in a clean user account without Codex or Claude.
- [ ] Launch offline and with an unreachable proxy. Project management, canvas editing, settings, and the built-in Agent must still open.
- [ ] Confirm alternate `--external-agent-mcp` mode is present in the same packaged executable and normal launch does not enter MCP mode.
- [ ] Confirm Tauri command registration/capabilities allow the intended frontend commands and no broad shell capability was added.
- [ ] Uninstall/reinstall without deleting user projects; confirm the SQLite database remains readable.

## Current Evidence And Known Limits

As of 2026-08-12 on the development Mac:

- Frontend: 63 test files / 426 tests, TypeScript, and production build passed.
- Rust: 62 tests, formatting, and locked `cargo check` passed.
- Desktop compile: `npx tauri build --debug --no-bundle --ci` produced the macOS debug application successfully.
- Browser smoke: project creation, Agent open/close transition, runtime switching, browser-mode degradation, and console/page-error checks passed.
- Real local Codex and Claude initialization probes confirmed the bounded Canvas MCP configuration during implementation.

Not yet proven by the development Mac alone:

- A real Windows installer launch, WebView2 rendering, Windows IME/file dialogs, firewall prompts, and process-tree behavior.
- GitHub-hosted matrix results for the candidate commit before it is pushed.
- Signed/notarized production artifacts; the CI quality gate intentionally compiles unsigned applications.

Record these as `UNRUN`, not `PASS`, until the corresponding Windows machine or release pipeline produces evidence.
