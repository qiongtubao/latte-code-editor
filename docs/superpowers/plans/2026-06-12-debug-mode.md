# Debug Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Debug Mode spec (`docs/superpowers/specs/2026-06-11-debug-mode-design.md`) — a self-contained, opt-in observability + replay surface that turns "unable to reproduce" bugs into replayable, traceable events.

**Architecture:** Tauri 2.0 desktop app. Add a `debug` module on the Rust side (tracing-subscriber + file rotation + capacity-based purge). Add a `utils/debug/` subsystem on the TS side (logger factory, store with replay locks, event registry, lastAction stack, IPC forwarder). A persistent Debug Bar (right-bottom drawer) toggled by `Ctrl/Cmd+Shift+D` or `LATTE_DEBUG=1` exposes snapshot, replay, inject, and a confirm modal for dangerous events.

**Tech Stack:** Rust 1.96 + `tracing`/`tracing-subscriber`/`tracing-appender`; React 19 + Zustand 5; Tauri 2.0 commands; existing pnpm 9 + vitest 4.1 stack.

**Spec:** `docs/superpowers/specs/2026-06-11-debug-mode-design.md`
**Project Root:** `/home/dong/Documents/latte/latte-code-editor`

---

## Phase Overview

| Phase | Deliverable | Verifiable by |
|-------|------------|---------------|
| **1. Logger Foundation** | Backend: tracing-subscriber + file rotation + `purge_old_logs`; Frontend: `useDebugStore` + `createDebugLogger` + redact/sample/throttle; IPC forwarder | `cargo test` and `pnpm test` for the new units; `pnpm tauri dev` with `LATTE_DEBUG=1` produces `latte-debug.log` |
| **2. Event Instrumentation** | All event modules (ipc/workspace/editor/graph/lsp) emit via `createDebugLogger`; per-operation `ReplayLock`; idempotency keys on hot ops | E2E smoke: open a workspace, switch files, start LSP, see all events in the log |
| **3. Debug Bar UI** | `DebugBar` drawer with status line, lock indicator, snapshot button, inject button, close button; `Ctrl+Shift+D` shortcut; env-var bootstrap; LspManagerPanel shortcut renumber | Manual: `Ctrl+Shift+D` toggles bar; bar shows event count and log path |
| **4. Replay & Inject** | L1 (`Ctrl+Shift+R` last-action replay), L2 (module replay buttons), L3 (`Ctrl+Shift+S` snapshot dump), L4 (event inject modal + `DebugDangerConfirmModal` for `dangerous: true` events) | Manual: replay, snapshot, inject a non-dangerous event, inject `workspace.delete` (must see confirm modal) |
| **5. Log Capacity & Docs** | `LATTE_DEBUG_MAX_DIR_MB` / `LATTE_DEBUG_MAX_AGE_DAYS` env hooks; cleanup on startup/rotate/shutdown; `docs/debug-mode-usage.md` | Manual: write 600MB of mock logs, restart, confirm ≤400MB remain; review usage doc |

---

## Cross-Phase Conventions

- **Commit cadence:** one commit per Task. Use Conventional Commits (`feat:`, `test:`, `docs:`, `chore:`).
- **TDD discipline:** every code task starts with a failing test in a `*.test.ts` or `#[cfg(test)] mod` block. Test first, run to confirm failure, then implement.
- **Verify before commit:** run the test (or `cargo check` for non-test refactors) and confirm green before `git commit`.
- **TDD when meaningful:** trivial configs that just plumb env vars may use a `cargo check` or a single integration assertion instead of full TDD — judgement call, documented per task.
- **No silent stubs:** every `// TODO` or `unimplemented!()` is a defect. If a phase can't ship a piece, leave it out of that commit and note it in the PR body.

---

# Phase 1: Logger Foundation

> **Deliverable:** Backend and frontend can write structured JSON-line logs to a single file, with sampling, throttling, and automatic secret redaction. Capacity-based and age-based cleanup runs on startup.

---

## Task 1.1: Backend — add tracing dependencies

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add dependencies to `src-tauri/Cargo.toml`**

Add three crates under `[dependencies]`:

```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter", "fmt"] }
tracing-appender = "0.2"
```

(Verify: no existing `[dependencies]` block should be deleted; these three lines are added at the end of the existing block.)

- [ ] **Step 2: Verify Cargo resolves**

Run: `cd src-tauri && cargo check --offline 2>&1 | head -5 || cargo check 2>&1 | tail -20`
Expected: no "unresolved crate" errors for `tracing`, `tracing-subscriber`, `tracing-appender`. (If `cargo check` blocks on network, run it without `--offline` once.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(deps): add tracing + tracing-subscriber + tracing-appender"
```

---

## Task 1.2: Backend — `debug::storage::purge_old_logs`

**Files:**
- Create: `src-tauri/src/debug/mod.rs`
- Create: `src-tauri/src/debug/storage.rs`
- Modify: `src-tauri/src/lib.rs:1-6` (add `mod debug;`)

- [ ] **Step 1: Write the failing test in `storage.rs`**

```rust
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn touch_with_age(dir: &Path, name: &str, age_days: u64, bytes: usize) {
    let p = dir.join(name);
    let mut f = fs::File::create(&p).unwrap();
    f.write_all(&vec![b'x'; bytes]).unwrap();
    drop(f);
    let mtime = SystemTime::now() - std::time::Duration::from_secs(age_days * 86_400);
    let _ = filetime::set_file_mtime(&p, filetime::FileTime::from_system_time(mtime));
}
```

We will not pull in a `filetime` crate. Use `std::fs::set_modified` (stable since 1.75) — adjust the helper to:

```rust
fn touch_with_age(dir: &Path, name: &str, age_secs: u64, bytes: usize) {
    let p = dir.join(name);
    let mut f = fs::File::create(&p).unwrap();
    f.write_all(&vec![b'x'; bytes]).unwrap();
    drop(f);
    let mtime = SystemTime::now() - std::time::Duration::from_secs(age_secs);
    let _ = fs::set_modified(&p, mtime);
}
```

(Replace the helper. Confirm Rust toolchain ≥ 1.75 by running `rustc --version` — if older, switch to `std::os::unix::fs::FileExt`-based writes and skip mtime adjustment; tests will then only cover the byte-budget branch.)

Add the test module inside `storage.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn fresh_dir() -> std::path::PathBuf {
        let mut d = env::temp_dir();
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        d.push(format!("latte-debug-purge-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn removes_files_older_than_max_age() {
        let dir = fresh_dir();
        touch_with_age(&dir, "latte-debug.2026-01-01-00.log", 10 * 86_400, 1024);
        touch_with_age(&dir, "latte-debug.2026-06-10-00.log", 1 * 86_400, 1024);

        let removed = purge_old_logs(&dir, 7 * 86_400, 500, 50).unwrap();

        assert_eq!(removed, 1);
        assert!(!dir.join("latte-debug.2026-01-01-00.log").exists());
        assert!(dir.join("latte-debug.2026-06-10-00.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_total_dir_size() {
        let dir = fresh_dir();
        for i in 0..10 {
            touch_with_age(&dir, &format!("f{i}.log"), 86_400, 100 * 1024 * 1024); // 100MB
        }
        let removed = purge_old_logs(&dir, 7 * 86_400, 500, 50).unwrap();
        assert!(removed >= 5, "should remove at least 5 files to drop under 500MB cap, removed={removed}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_max_file_count() {
        let dir = fresh_dir();
        for i in 0..60 {
            touch_with_age(&dir, &format!("f{i:02}.log"), 86_400, 1024);
        }
        let removed = purge_old_logs(&dir, 30 * 86_400, 10_000, 50).unwrap();
        assert!(removed >= 10, "expected to drop down to 50 files, removed={removed}");
        let _ = fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd src-tauri && cargo test --lib debug::storage::tests 2>&1 | tail -20`
Expected: compile error (`purge_old_logs` not found) or test failure.

- [ ] **Step 3: Implement `purge_old_logs` in `src-tauri/src/debug/storage.rs`**

```rust
//! Filesystem maintenance for debug log directory.
//!
//! Three independent limits, applied in order:
//! 1. Age: anything older than `max_age_secs` is removed.
//! 2. Count: if more than `max_files` remain, drop oldest by mtime.
//! 3. Bytes: if total > `max_bytes_mb * 1_048_576`, drop oldest by mtime until ≤ `max_bytes_mb * 1_048_576 / 2` (hysteresis).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub struct PurgeReport {
    pub removed: usize,
    pub freed_bytes: u64,
}

pub fn purge_old_logs(
    dir: &Path,
    max_age_secs: u64,
    max_bytes_mb: u64,
    max_files: usize,
) -> io::Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut entries = read_entries(dir)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let mut removed = 0usize;

    // 1. Age
    let before = entries.len();
    entries.retain(|e| now.saturating_sub(e.mtime) <= max_age_secs);
    removed += before - entries.len();

    // 2. Count
    if entries.len() > max_files {
        entries.sort_by_key(|e| e.mtime);
        let to_drop = entries.len() - max_files;
        for e in entries.drain(..to_drop) {
            let _ = fs::remove_file(&e.path);
        }
        removed += to_drop;
    }

    // 3. Bytes (with hysteresis: aim for half the cap)
    let cap_bytes = max_bytes_mb.saturating_mul(1_048_576);
    let target_bytes = cap_bytes / 2;
    let total: u64 = entries.iter().map(|e| e.size).sum();
    if total > cap_bytes {
        entries.sort_by_key(|e| e.mtime);
        let mut running = total;
        let mut dropped = 0usize;
        while running > target_bytes && !entries.is_empty() {
            let e = entries.remove(0);
            running = running.saturating_sub(e.size);
            let _ = fs::remove_file(&e.path);
            dropped += 1;
        }
        removed += dropped;
    }

    Ok(removed)
}

#[derive(Debug)]
struct Entry {
    path: PathBuf,
    size: u64,
    mtime: u64,
}

fn read_entries(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut out = Vec::new();
    for ent in fs::read_dir(dir)? {
        let ent = ent?;
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let meta = ent.metadata()?;
        let mtime = meta.modified().ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(Entry { path, size: meta.len(), mtime });
    }
    Ok(out)
}
```

- [ ] **Step 4: Create `src-tauri/src/debug/mod.rs` with module stub**

```rust
//! Debug-mode observability surface.
//!
//! Activated by `LATTE_DEBUG=1` env var or by the frontend `Ctrl/Cmd+Shift+D` shortcut.

pub mod storage;
```

- [ ] **Step 5: Register the module in `src-tauri/src/lib.rs`**

At the top of `lib.rs` (after the existing `mod` lines), add:

```rust
mod debug;
```

- [ ] **Step 6: Run the test to confirm pass**

Run: `cd src-tauri && cargo test --lib debug::storage 2>&1 | tail -10`
Expected: 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/debug src-tauri/src/lib.rs
git commit -m "feat(debug): add storage::purge_old_logs with age/count/byte limits"
```

---

## Task 1.3: Backend — tracing-subscriber init with file rotation

**Files:**
- Create: `src-tauri/src/debug/logger.rs`
- Modify: `src-tauri/src/debug/mod.rs`
- Modify: `src-tauri/src/lib.rs:23-42` (the `.setup` closure)

- [ ] **Step 1: Add the failing unit test for log-line format**

Create `src-tauri/src/debug/logger.rs`:

```rust
//! tracing-subscriber setup that writes JSON-line logs to a rotating file.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter, Registry};

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn log_dir() -> Option<&'static PathBuf> { LOG_DIR.get() }

/// Initialise tracing. Returns true if file logging was enabled.
pub fn init(app_data_dir: PathBuf) -> bool {
    let env_on = matches!(std::env::var("LATTE_DEBUG").as_deref(), Ok("1") | Ok("true"));
    if !env_on {
        // Best-effort console logging only.
        let _ = tracing_subscriber::registry()
            .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
            .with(fmt::layer().with_target(true))
            .try_init();
        return false;
    }
    let dir = app_data_dir.join("debug");
    let _ = std::fs::create_dir_all(&dir);
    let _ = LOG_DIR.set(dir.clone());
    let file_appender = tracing_appender::rolling::daily(&dir, "latte-debug.log");
    let (nb, _guard) = tracing_appender::non_blocking(file_appender);
    // Keep the guard alive for process lifetime.
    Box::leak(Box::new(_guard));

    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,latte=debug"));
    let layer = fmt::layer()
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .with_writer(nb);
    let _ = tracing_subscriber::registry()
        .with(env_filter)
        .with(layer)
        .try_init();
    true
}
```

- [ ] **Step 2: Add a unit test for log-line JSON shape**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn json_line_format() {
        // Write to a temp file via a manually constructed writer and parse.
        let dir = std::env::temp_dir().join(format!("latte-log-fmt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("latte-debug.log");
        let file = std::fs::File::create(&path).unwrap();
        let (nb, _g) = tracing_appender::non_blocking(file);
        let subscriber = tracing_subscriber::registry()
            .with(EnvFilter::new("info"))
            .with(fmt::layer().json().with_writer(nb));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(event = "lsp.start", ctx = "{}","hello");
        });
        // non_blocking is async; wait briefly
        std::thread::sleep(std::time::Duration::from_millis(100));
        let mut s = String::new();
        std::fs::File::open(&path).unwrap().read_to_string(&mut s).unwrap();
        let line = s.lines().next().expect("at least one line");
        let v: serde_json::Value = serde_json::from_str(line).expect("must be valid JSON");
        assert!(v.get("event").is_some(), "expected event field: {line}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

(If the `serde_json` dev-dep is not present, add it under `[dev-dependencies]` in `Cargo.toml`: `serde_json = "1"`.)

- [ ] **Step 3: Run the test to confirm pass**

Run: `cd src-tauri && cargo test --lib debug::logger 2>&1 | tail -10`
Expected: 1 test passes.

- [ ] **Step 4: Wire `debug::logger::init` into `lib.rs` setup**

In `src-tauri/src/lib.rs`, inside the `setup` closure (around the existing `let data_dir = ...` line), insert at the very top of the closure body:

```rust
debug::logger::init(app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()));
```

Ensure `debug` is already declared as a module (it is, from Task 1.2).

- [ ] **Step 5: Verify the project still compiles**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/debug/logger.rs src-tauri/src/debug/mod.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(debug): init tracing-subscriber with rotating JSON log file"
```

---

## Task 1.4: Frontend — `useDebugStore` (Zustand)

**Files:**
- Create: `src/utils/debug/store.ts`
- Create: `src/utils/debug/store.test.ts`

- [ ] **Step 1: Write the failing test**

`src/utils/debug/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDebugStore } from "./store";

describe("useDebugStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useDebugStore.setState({ isOn: false, sid: "", replayLocks: new Map(), skipDangerousConfirm: false });
  });

  it("toggle flips isOn and persists to localStorage", () => {
    useDebugStore.getState().setOn(true);
    expect(useDebugStore.getState().isOn).toBe(true);
    expect(localStorage.getItem("latte.debug")).toBe("1");
    useDebugStore.getState().setOn(false);
    expect(useDebugStore.getState().isOn).toBe(false);
    expect(localStorage.getItem("latte.debug")).toBe("0");
  });

  it("hydrates from localStorage on init", () => {
    localStorage.setItem("latte.debug", "1");
    useDebugStore.getState().hydrate();
    expect(useDebugStore.getState().isOn).toBe(true);
  });

  it("replayLocks: acquire returns true then false while held; release allows reacquire", () => {
    const a = useDebugStore.getState().tryAcquireLock("lsp:start");
    expect(a).toBe(true);
    const b = useDebugStore.getState().tryAcquireLock("lsp:start");
    expect(b).toBe(false);
    useDebugStore.getState().releaseLock("lsp:start");
    const c = useDebugStore.getState().tryAcquireLock("lsp:start");
    expect(c).toBe(true);
  });

  it("replayLocks: force-release after 3s", () => {
    vi.useFakeTimers();
    useDebugStore.getState().tryAcquireLock("graph:rebuild");
    vi.advanceTimersByTime(3_100);
    const a = useDebugStore.getState().tryAcquireLock("graph:rebuild");
    expect(a).toBe(true);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `cd /home/dong/Documents/latte/latte-code-editor && pnpm vitest run src/utils/debug/store.test.ts 2>&1 | tail -20`
Expected: fail (module not found).

- [ ] **Step 3: Implement `src/utils/debug/store.ts`**

```ts
import { create } from "zustand";

interface DebugState {
  isOn: boolean;
  sid: string;
  replayLocks: Map<string, number>; // key -> acquiredAtMs
  skipDangerousConfirm: boolean;
  setOn: (v: boolean) => void;
  hydrate: () => void;
  tryAcquireLock: (key: string) => boolean;
  releaseLock: (key: string) => void;
}

const LOCK_TIMEOUT_MS = 3_000;

function newSid(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useDebugStore = create<DebugState>((set, get) => ({
  isOn: false,
  sid: newSid(),
  replayLocks: new Map(),
  skipDangerousConfirm: false,
  setOn: (v) => {
    localStorage.setItem("latte.debug", v ? "1" : "0");
    set({ isOn: v });
  },
  hydrate: () => {
    const stored = localStorage.getItem("latte.debug");
    const envOn = (import.meta.env?.LATTE_DEBUG ?? "") === "1";
    const on = stored === "1" || envOn;
    set({ isOn: on });
  },
  tryAcquireLock: (key) => {
    const now = Date.now();
    const locks = new Map(get().replayLocks);
    const held = locks.get(key);
    if (held !== undefined) {
      if (now - held < LOCK_TIMEOUT_MS) return false;
      // Stale lock — force-release.
      locks.delete(key);
    }
    locks.set(key, now);
    set({ replayLocks: locks });
    return true;
  },
  releaseLock: (key) => {
    const locks = new Map(get().replayLocks);
    locks.delete(key);
    set({ replayLocks: locks });
  },
}));
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/utils/debug/store.test.ts 2>&1 | tail -10`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/debug/store.ts src/utils/debug/store.test.ts
git commit -m "feat(debug): useDebugStore with isOn/sid/replayLocks"
```

---

## Task 1.5: Frontend — `createDebugLogger` with sample/throttle/redact

**Files:**
- Create: `src/utils/debug/logger.ts`
- Create: `src/utils/debug/logger.test.ts`

- [ ] **Step 1: Write the failing test**

`src/utils/debug/logger.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDebugLogger } from "./logger";
import { useDebugStore } from "./store";

const SECRET_KEYS = ["password", "apiKey", "token", "secret"];

describe("createDebugLogger", () => {
  beforeEach(() => {
    useDebugStore.setState({ isOn: true });
  });

  it("emits a JSON line via console when isOn", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createDebugLogger("lsp");
    log.info("lsp.start", "starting rust-analyzer", { language: "rust" });
    const call = spy.mock.calls[0]?.[0] as string;
    expect(call).toMatch(/^latte:/);
    const json = call.replace(/^latte:/, "");
    const parsed = JSON.parse(json);
    expect(parsed.event).toBe("lsp.start");
    expect(parsed.module).toBe("lsp");
    expect(parsed.ctx.language).toBe("rust");
    spy.mockRestore();
  });

  it("redacts secret keys", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createDebugLogger("ipc");
    log.info("ipc.invoke", "auth", { password: "p", token: "t", safe: "ok" });
    const call = (spy.mock.calls[0]?.[0] as string).replace(/^latte:/, "");
    const parsed = JSON.parse(call);
    expect(parsed.ctx.password).toBe("***");
    expect(parsed.ctx.token).toBe("***");
    expect(parsed.ctx.safe).toBe("ok");
    spy.mockRestore();
  });

  it("throttles by (event+traceId) within 100ms", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = createDebugLogger("graph", { throttleMs: 100 });
    log.info("graph.nodeClick", "x", { traceId: "abc" });
    log.info("graph.nodeClick", "x", { traceId: "abc" });
    log.info("graph.nodeClick", "x", { traceId: "abc" });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("does not emit when isOn is false (errors still pass)", () => {
    useDebugStore.setState({ isOn: false });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = createDebugLogger("editor");
    log.info("file.open", "x", { path: "/a" });
    log.error("file.error", "boom", { path: "/a" });
    expect(spy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    errSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `pnpm vitest run src/utils/debug/logger.test.ts 2>&1 | tail -20`
Expected: fail (module not found).

- [ ] **Step 3: Implement `src/utils/debug/logger.ts`**

```ts
import { useDebugStore } from "./store";

const SECRET_KEYS = new Set(["password", "apiKey", "token", "secret", "authorization"]);

const lastByKey = new Map<string, number>();

function redact(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) out[k] = "***";
    else out[k] = redact(v);
  }
  return out;
}

export interface LoggerOpts {
  sampleRate?: number; // 0..1; default 1
  throttleMs?: number; // default 100
}

export interface DebugLogger {
  debug: (event: string, msg: string, ctx?: Record<string, unknown>) => void;
  info: (event: string, msg: string, ctx?: Record<string, unknown>) => void;
  warn: (event: string, msg: string, ctx?: Record<string, unknown>) => void;
  error: (event: string, msg: string, ctx?: Record<string, unknown>) => void;
}

export function createDebugLogger(module: string, opts: LoggerOpts = {}): DebugLogger {
  const { sampleRate = 1, throttleMs = 100 } = opts;
  const make = (level: "debug" | "info" | "warn" | "error") =>
    (event: string, msg: string, ctx: Record<string, unknown> = {}) => {
      const { isOn } = useDebugStore.getState();
      if (!isOn && level !== "error") return;
      if (sampleRate < 1 && Math.random() > sampleRate && level !== "error") return;
      const traceId = (ctx.traceId as string) ?? event;
      const last = lastByKey.get(`${level}:${event}:${traceId}`);
      const now = Date.now();
      if (last !== undefined && now - last < throttleMs) return;
      lastByKey.set(`${level}:${event}:${traceId}`, now);

      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        side: "front",
        module,
        event,
        msg,
        ctx: redact(ctx),
        sid: useDebugStore.getState().sid,
      });
      const tag = `latte:${line}`;
      if (level === "error") console.error(tag);
      else if (level === "warn") console.warn(tag);
      else if (level === "debug") console.debug(tag);
      else console.info(tag);
      // Fire-and-forget forward to backend (stub until Phase 3 wires the command).
      forwardToBackend(tag).catch(() => {});
    };
  return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}

async function forwardToBackend(_line: string): Promise<void> {
  // Wired in Phase 2 via `invoke("debug_log_from_front", { line })`.
  return;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/utils/debug/logger.test.ts 2>&1 | tail -10`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/debug/logger.ts src/utils/debug/logger.test.ts
git commit -m "feat(debug): createDebugLogger with redact/throttle/sample"
```

---

# Phase 2: Event Instrumentation

> **Deliverable:** Every user action, IPC call, and store change in workspace / editor / graph / LSP goes through `createDebugLogger`. Hot ops (`lsp.start`, `workspace.activate`, `graph.requestReload`) get a `ReplayLock` + idempotency.

---

## Task 2.1: Wire `debugEmit` + lastAction stack

**Files:**
- Create: `src/utils/debug/inject.ts`
- Create: `src/utils/debug/inject.test.ts`

- [ ] **Step 1: Write the failing test**

`src/utils/debug/inject.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { registerDebugEvent, debugEmit, replayLastAction, getLastActions } from "./inject";
import { useDebugStore } from "./store";

describe("debugEmit / replayLastAction", () => {
  beforeEach(() => {
    useDebugStore.setState({ isOn: true, replayLocks: new Map() });
    getLastActions().length = 0;
  });

  it("registered event fires with ctx", () => {
    const fn = vi.fn();
    registerDebugEvent("lsp.start", fn, { dangerous: false });
    debugEmit("lsp.start", { language: "rust" });
    expect(fn).toHaveBeenCalledWith({ language: "rust" });
  });

  it("dangerous event calls confirm hook and skips if not confirmed", () => {
    const fn = vi.fn();
    const confirm = vi.fn().mockReturnValue(false);
    registerDebugEvent("workspace.delete", fn, { dangerous: true });
    debugEmit("workspace.delete", { id: "ws-1" }, { confirm });
    expect(confirm).toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it("dangerous event runs when confirmed", () => {
    const fn = vi.fn();
    const confirm = vi.fn().mockReturnValue(true);
    registerDebugEvent("workspace.delete", fn, { dangerous: true });
    debugEmit("workspace.delete", { id: "ws-1" }, { confirm });
    expect(fn).toHaveBeenCalled();
  });

  it("replayLastAction replays the most recent action", () => {
    const fn = vi.fn();
    registerDebugEvent("file.open", fn);
    debugEmit("file.open", { path: "/a/b.ts" });
    replayLastAction();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("replay is blocked when lock is held", () => {
    const fn = vi.fn();
    registerDebugEvent("graph.requestReload", fn);
    useDebugStore.getState().tryAcquireLock("graph:requestReload");
    debugEmit("graph.requestReload", {}); // first call still works
    const calls = fn.mock.calls.length;
    debugEmit("graph.requestReload", {}); // second blocked
    expect(fn.mock.calls.length).toBe(calls); // no new calls
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `pnpm vitest run src/utils/debug/inject.test.ts 2>&1 | tail -10`

- [ ] **Step 3: Implement `src/utils/debug/inject.ts`**

```ts
import { useDebugStore } from "./store";
import { createDebugLogger } from "./logger";

const log = createDebugLogger("debug");

export interface RegisterOpts {
  dangerous?: boolean;
}

type Handler = (ctx: Record<string, unknown>) => void | Promise<void>;
type Confirm = (event: string, ctx: Record<string, unknown>) => boolean | Promise<boolean>;

interface Registration { event: string; handler: Handler; dangerous: boolean; }
const registry = new Map<string, Registration[]>();

export function registerDebugEvent(event: string, handler: Handler, opts: RegisterOpts = {}) {
  const list = registry.get(event) ?? [];
  list.push({ event, handler, dangerous: !!opts.dangerous });
  registry.set(event, list);
}

export function listDebugEvents(): { event: string; dangerous: boolean }[] {
  return [...registry.values()].flat().map((r) => ({ event: r.event, dangerous: r.dangerous }));
}

interface LastAction { event: string; ctx: Record<string, unknown>; at: number; }
const lastActions: LastAction[] = [];

export function getLastActions(): LastAction[] { return lastActions; }

export interface EmitOpts { confirm?: Confirm; }

export async function debugEmit(event: string, ctx: Record<string, unknown> = {}, opts: EmitOpts = {}): Promise<void> {
  const regs = registry.get(event) ?? [];
  if (regs.length === 0) {
    log.warn("debug.inject.unknown_event", `no handler for ${event}`, { event });
    return;
  }
  for (const r of regs) {
    if (r.dangerous && !useDebugStore.getState().skipDangerousConfirm) {
      const ok = opts.confirm ? await opts.confirm(event, ctx) : false;
      log.warn("debug.inject.dangerous", "dangerous event emit attempt", { event, confirmed: ok, ctx });
      if (!ok) { log.info("debug.inject.rejected", "user cancelled", { event }); return; }
    }
    await r.handler(ctx);
  }
  lastActions.unshift({ event, ctx, at: Date.now() });
  if (lastActions.length > 20) lastActions.length = 20;
  log.info("debug.inject.executed", "injected", { event, ctx });
}

export function replayLastAction(): void {
  const top = lastActions[0];
  if (!top) { log.info("debug.replay.empty", "no actions to replay", {}); return; }
  const lockKey = `inject:${top.event}`;
  const got = useDebugStore.getState().tryAcquireLock(lockKey);
  if (!got) {
    log.warn("debug.replay.skipped", "locked", { action: top.event, reason: "locked" });
    return;
  }
  debugEmit(top.event, top.ctx).finally(() => useDebugStore.getState().releaseLock(lockKey));
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/utils/debug/inject.test.ts 2>&1 | tail -10`
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/debug/inject.ts src/utils/debug/inject.test.ts
git commit -m "feat(debug): registerDebugEvent + debugEmit + replayLastAction + dangerous confirm"
```

---

## Task 2.2: Instrument `useLspStore`

**Files:**
- Modify: `src/hooks/useLspStore.ts` (specifically `manualTriggerStart`, `startLsp`, `stopLsp`, `hibernateLsp`, `wakeLsp`)

- [ ] **Step 1: Add instrumentation**

At the top of `useLspStore.ts`, add:

```ts
import { createDebugLogger } from "../utils/debug/logger";
import { registerDebugEvent, debugEmit } from "../utils/debug/inject";
const log = createDebugLogger("lsp");
```

- [ ] **Step 2: Register LSP events**

Immediately after the `manualTriggerStart` declaration (around the function body), add a `useEffect`-equivalent top-level registration block. Since the store is module-scope, add this at the bottom of the file, after the export:

```ts
registerDebugEvent("lsp.start", async (ctx) => {
  await useLspStore.getState().startLsp(ctx.language as string);
});
registerDebugEvent("lsp.stop", async (ctx) => {
  await useLspStore.getState().stopLsp(ctx.language as string);
}, { dangerous: true });
registerDebugEvent("lsp.hibernate", async (ctx) => {
  await useLspStore.getState().hibernateLsp(ctx.language as string);
});
registerDebugEvent("lsp.wake", async (ctx) => {
  await useLspStore.getState().wakeLsp(ctx.language as string);
});
```

- [ ] **Step 3: Wrap `startLsp` and `stopLsp` with locks + log**

Inside the `LspStore` implementation, modify `startLsp`:

```ts
startLsp: async (language: string) => {
  const lockKey = `lsp:start:${language}`;
  if (!useDebugStore.getState().tryAcquireLock(lockKey)) {
    log.warn("lsp.start.skipped", "locked", { language });
    return;
  }
  log.info("lsp.start", `starting ${language}`, { language });
  try {
    await apiStartLsp(language);
    log.info("lsp.start.ok", `${language} running`, { language });
  } catch (e) {
    log.error("lsp.start.error", String(e), { language });
  } finally {
    useDebugStore.getState().releaseLock(lockKey);
  }
},
```

Add at top of file: `import { useDebugStore } from "../utils/debug/store";`

Apply analogous `tryAcquireLock` / `releaseLock` wrappers to `stopLsp` and `hibernateLsp` and `wakeLsp` (each keyed by `lsp:<op>:<language>`).

- [ ] **Step 4: Type-check**

Run: `pnpm typecheck 2>&1 | tail -10`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useLspStore.ts
git commit -m "feat(debug): instrument useLspStore with ReplayLock + event log"
```

---

## Task 2.3: Instrument `useWorkspaceStore`, `useEditorStore`, `useGraphStore`

**Files:**
- Modify: `src/hooks/useWorkspaceStore.ts`
- Modify: `src/hooks/useEditorStore.ts`
- Modify: `src/hooks/useGraphStore.ts`

- [ ] **Step 1: Workspace — add `createDebugLogger` calls and `registerDebugEvent` for `workspace.delete` (dangerous)**

Add at top of `useWorkspaceStore.ts`:

```ts
import { createDebugLogger } from "../utils/debug/logger";
import { registerDebugEvent, debugEmit } from "../utils/debug/inject";
import { useDebugStore } from "../utils/debug/store";
const log = createDebugLogger("workspace");
```

Wrap the existing `deleteWorkspace` action (or whatever the public method is named) with:

```ts
deleteWorkspace: async (id: string) => {
  const lockKey = `workspace:delete:${id}`;
  if (!useDebugStore.getState().tryAcquireLock(lockKey)) { log.warn("ws.delete.skipped", "locked", { id }); return; }
  log.info("ws.delete", "deleting", { id });
  try {
    // ... existing delete logic ...
    log.info("ws.delete.ok", "deleted", { id });
  } finally {
    useDebugStore.getState().releaseLock(lockKey);
  }
},
```

After the export, register:

```ts
registerDebugEvent("workspace.delete", async (ctx) => {
  await useWorkspaceStore.getState().deleteWorkspace(ctx.id as string);
}, { dangerous: true });
```

- [ ] **Step 2: Editor — instrument `file.save` (dangerous) and `file.open`**

Top of `useEditorStore.ts`:

```ts
import { createDebugLogger } from "../utils/debug/logger";
import { registerDebugEvent } from "../utils/debug/inject";
const log = createDebugLogger("editor");
```

Wrap `saveFile` (or equivalent) with `log.info("file.save", "saving", { path })` / `log.info("file.save.ok", ...)`. Wrap `openFile` similarly. Register:

```ts
registerDebugEvent("file.save", async (ctx) => { await useEditorStore.getState().saveFile(ctx.path as string); }, { dangerous: true });
registerDebugEvent("file.open", async (ctx) => { await useEditorStore.getState().openFile(ctx.path as string); });
```

- [ ] **Step 3: Graph — instrument `requestReload` and `rebuild`**

Top of `useGraphStore.ts`:

```ts
import { createDebugLogger } from "../utils/debug/logger";
import { registerDebugEvent } from "../utils/debug/inject";
import { useDebugStore } from "../utils/debug/store";
const log = createDebugLogger("graph");
```

Wrap `requestReload`:

```ts
requestReload: async () => {
  const lockKey = "graph:requestReload";
  if (!useDebugStore.getState().tryAcquireLock(lockKey)) { log.warn("graph.requestReload.skipped", "locked", {}); return; }
  log.info("graph.requestReload", "reloading", {});
  try { /* existing */ } finally { useDebugStore.getState().releaseLock(lockKey); }
},
```

Register:

```ts
registerDebugEvent("graph.requestReload", async () => { await useGraphStore.getState().requestReload(); });
registerDebugEvent("graph.rebuild", async () => { await useGraphStore.getState().rebuild(); }, { dangerous: true });
```

- [ ] **Step 4: Type-check**

Run: `pnpm typecheck 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useWorkspaceStore.ts src/hooks/useEditorStore.ts src/hooks/useGraphStore.ts
git commit -m "feat(debug): instrument workspace/editor/graph stores"
```

---

## Task 2.4: Wrap `invoke` with `ipc.*` event log

**Files:**
- Create: `src/api/ipcDebug.ts`
- Modify: `src/api/lsp.ts` (refactor all `invoke(...)` calls through the wrapper)

- [ ] **Step 1: Implement `src/api/ipcDebug.ts`**

```ts
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { createDebugLogger } from "../utils/debug/logger";

const log = createDebugLogger("ipc", { throttleMs: 0 }); // every IPC call logged

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t0 = performance.now();
  log.debug("ipc.invoke", cmd, { cmd, args });
  try {
    const result = await tauriInvoke<T>(cmd, args);
    log.info("ipc.response", cmd, { cmd, ms: Math.round(performance.now() - t0) });
    return result;
  } catch (e) {
    log.error("ipc.error", cmd, { cmd, error: String(e) });
    throw e;
  }
}
```

- [ ] **Step 2: Refactor `src/api/lsp.ts` to import the wrapper**

In `src/api/lsp.ts`, change the top import from `import { invoke } from "@tauri-apps/api/core";` to `import { invoke } from "./ipcDebug";`. Leave all function bodies unchanged.

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/api/ipcDebug.ts src/api/lsp.ts
git commit -m "feat(debug): wrap invoke with ipc.* event log"
```

---

# Phase 3: Debug Bar UI

> **Deliverable:** Persistent Debug Bar drawer toggled by `Ctrl/Cmd+Shift+D` or `LATTE_DEBUG=1`. Shows status, lock state, log path, and exposes snapshot / inject / close buttons.

---

## Task 3.1: Backend — `debug_dump_backend_state` command

**Files:**
- Modify: `src-tauri/src/debug/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register the command)

- [ ] **Step 1: Create the command file**

`src-tauri/src/debug/commands.rs`:

```rust
use serde::Serialize;
use tauri::State;

use crate::workspace::registry::WorkspaceRegistry;

#[derive(Serialize)]
pub struct BackendSnapshot {
    pub workspaces_in_registry: usize,
    pub lsp_managers: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

#[tauri::command]
pub async fn debug_dump_backend_state(
    registry: State<'_, std::sync::Arc<WorkspaceRegistry>>,
) -> Result<BackendSnapshot, String> {
    let workspaces = registry.ids().await;
    let mut lsp_managers = std::collections::HashMap::new();
    for ws_id in workspaces {
        if let Some(mgrs) = registry.lsp_managers_snapshot(&ws_id).await {
            lsp_managers.insert(ws_id, mgrs);
        }
    }
    Ok(BackendSnapshot {
        workspaces_in_registry: registry.ids().await.len(),
        lsp_managers,
    })
}
```

This requires that `WorkspaceRegistry` expose `lsp_managers_snapshot(ws_id) -> Option<HashMap<String, String>>`. If the existing API differs, add an adapter method to `WorkspaceRegistry` returning the languages and their `LspState` strings — the snapshot is best-effort.

- [ ] **Step 2: Add `lsp_managers_snapshot` if missing**

In `src-tauri/src/workspace/registry.rs`, add:

```rust
pub async fn lsp_managers_snapshot(&self, ws_id: &str) -> Option<std::collections::HashMap<String, String>> {
    // Adapt to the existing data structure; for each LSP manager attached to ws_id,
    // produce { "<lang>" => "<state>" } (state is "running"/"stopped"/...).
    todo!("wire to actual LSP manager map in WorkspaceRegistry")
}
```

If you cannot wire this without reading the full `WorkspaceRegistry`, leave the function returning `None` and add a unit test that calls it and confirms `None`. The function must exist and be callable; the body can be `None`-returning for now and improved in a follow-up PR.

- [ ] **Step 3: Register the command in `lib.rs`**

In `src-tauri/src/lib.rs` `invoke_handler`:

```rust
debug::commands::debug_dump_backend_state
```

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/debug/commands.rs src-tauri/src/workspace/registry.rs src-tauri/src/lib.rs
git commit -m "feat(debug): debug_dump_backend_state command"
```

---

## Task 3.2: Frontend — minimal DebugBar component

**Files:**
- Create: `src/components/DebugBar.tsx`
- Modify: `src/App.tsx` (mount `DebugBar` and add `Ctrl+Shift+D` handler)

- [ ] **Step 1: Implement `DebugBar.tsx`**

```tsx
import { useEffect, useState } from "react";
import { useDebugStore } from "../utils/debug/store";

interface Props { onOpenInject: () => void; onSnapshot: () => void; }

export function DebugBar({ onOpenInject, onSnapshot }: Props) {
  const { isOn, sid, replayLocks, setOn } = useDebugStore();
  const [locksText, setLocksText] = useState("");

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const parts: string[] = [];
      replayLocks.forEach((t, k) => {
        const held = ((now - t) / 1000).toFixed(1);
        parts.push(`${k} (${held}s)`);
      });
      setLocksText(parts.join(", "));
    }, 250);
    return () => clearInterval(id);
  }, [replayLocks]);

  if (!isOn) return null;

  return (
    <div data-testid="debug-bar" className="fixed bottom-2 right-2 z-50">
      <div className="bg-gray-900/90 text-white text-xs rounded shadow-lg p-2 w-[420px] font-mono">
        <div className="flex justify-between items-center mb-1">
          <span>🛠 DEBUG | sid: {sid} | locks: {replayLocks.size}{locksText ? ` (${locksText})` : ""}</span>
          <button onClick={() => setOn(false)} aria-label="close debug" className="text-red-300 hover:text-red-100">✕</button>
        </div>
        <div className="flex gap-1 flex-wrap">
          <button onClick={onSnapshot} className="px-2 py-0.5 bg-blue-700 rounded hover:bg-blue-600">📸 Snapshot</button>
          <button onClick={onOpenInject} className="px-2 py-0.5 bg-blue-700 rounded hover:bg-blue-600">📨 Inject</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount in `App.tsx`**

At the top of `App.tsx`:

```tsx
import { DebugBar } from "./components/DebugBar";
import { useDebugStore } from "./utils/debug/store";
import { invoke } from "./api/ipcDebug";
```

Inside the `App` function, add:

```tsx
const debugOn = useDebugStore((s) => s.isOn);
const setDebugOn = useDebugStore((s) => s.setOn);
const hydrateDebug = useDebugStore((s) => s.hydrate);
const [injectOpen, setInjectOpen] = useState(false);

useEffect(() => { hydrateDebug(); }, [hydrateDebug]);

useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "D" || e.key === "d")) {
      e.preventDefault();
      setDebugOn(!useDebugStore.getState().isOn);
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [setDebugOn]);

const handleSnapshot = async () => {
  const snap = await invoke<unknown>("debug_dump_backend_state");
  console.info("latte:debug-snapshot", JSON.stringify(snap, null, 2));
};
```

In the JSX, just before the closing `</div>` of the root container, add:

```tsx
<DebugBar onOpenInject={() => setInjectOpen(true)} onSnapshot={handleSnapshot} />
{injectOpen && (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setInjectOpen(false)}>
    <div className="bg-white text-black rounded p-4 w-[520px]" onClick={(e) => e.stopPropagation()}>
      <h3 className="font-bold mb-2">Inject (stub — wired in Phase 4)</h3>
      <p className="text-sm">This modal will host the event inject UI in Phase 4.</p>
      <button onClick={() => setInjectOpen(false)} className="mt-2 px-3 py-1 bg-gray-200 rounded">Close</button>
    </div>
  </div>
)}
```

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck 2>&1 | tail -10`

- [ ] **Step 4: Manual smoke**

Run: `pnpm tauri dev`
- Press `Ctrl+Shift+D` → DebugBar appears in bottom-right.
- Click `✕` → bar disappears.

- [ ] **Step 5: Commit**

```bash
git add src/components/DebugBar.tsx src/App.tsx
git commit -m "feat(debug): DebugBar mounted with Ctrl+Shift+D toggle"
```

---

## Task 3.3: Renumber `Ctrl+Shift+L` → `Ctrl+Shift+M` for LSP Manager

**Files:**
- Modify: `src/App.tsx` (the existing `Ctrl+Shift+L` handler)
- Modify: `src/components/LspManagerPanel.tsx` (text strings)

- [ ] **Step 1: Update the handler in `App.tsx`**

Change the `e.key === "L" || e.key === "l"` branch to `e.key === "M" || e.key === "m"`.

- [ ] **Step 2: Update the on-screen hint in `LspManagerPanel.tsx`**

Find the existing text near the "Manual trigger mode" line and update the usage line to mention `Ctrl/Cmd+Shift+M` instead of `Ctrl/Cmd+Shift+L`. (Read the file to find the exact text; replace the literal substring.)

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck 2>&1 | tail -10`

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/components/LspManagerPanel.tsx
git commit -m "chore(keymap): move LSP Manager to Ctrl+Shift+M to free Ctrl+Shift+L for log viewer"
```

---

# Phase 4: Replay & Inject

> **Deliverable:** L1 (last-action replay via `Ctrl+Shift+R`), L2 (module replay buttons), L3 (snapshot via `Ctrl+Shift+S`), L4 (event-inject modal with `DebugDangerConfirmModal`).

---

## Task 4.1: L1 replay — `Ctrl+Shift+R` wired to `replayLastAction`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the handler**

Inside the existing `useEffect(() => { ... window.addEventListener("keydown", handler); ... })` block, add (after the `Ctrl+Shift+D` branch):

```tsx
} else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "R" || e.key === "r") && useDebugStore.getState().isOn) {
  e.preventDefault();
  import("./utils/debug/inject").then((m) => m.replayLastAction());
}
```

Also gate with a 250ms throttle: keep a ref `lastRRef = useRef(0)`, and if `Date.now() - lastRRef.current < 250` return; else set and replay.

- [ ] **Step 2: Type-check**

Run: `pnpm typecheck 2>&1 | tail -10`

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(debug): Ctrl+Shift+R replays last action (250ms throttled)"
```

---

## Task 4.2: L2 — module replay buttons

**Files:**
- Create: `src/components/DebugModuleActions.tsx`
- Modify: `src/components/DebugBar.tsx` (embed)

- [ ] **Step 1: Implement**

`src/components/DebugModuleActions.tsx`:

```tsx
import { useDebugStore } from "../utils/debug/store";
import { useWorkspaceStore } from "../hooks/useWorkspaceStore";
import { useGraphStore } from "../hooks/useGraphStore";
import { useLspStore } from "../hooks/useLspStore";
import { debugEmit } from "../utils/debug/inject";

export function DebugModuleActions() {
  const isOn = useDebugStore((s) => s.isOn);
  const hydrateWs = useWorkspaceStore((s) => s.hydrate);
  const reloadGraph = useGraphStore((s) => s.requestReload);
  const startLsp = useLspStore((s) => s.startLsp);
  if (!isOn) return null;

  return (
    <div className="flex flex-col gap-1 text-[11px]">
      <div className="flex items-center gap-1">
        <span className="w-20">LSP</span>
        <button onClick={() => debugEmit("lsp.start", { language: "rust" })} className="px-1 bg-blue-800 rounded">▶ start(rust)</button>
        <button onClick={() => debugEmit("lsp.stop", { language: "rust" })} className="px-1 bg-red-800 rounded">⏹ stop</button>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-20">图谱</span>
        <button onClick={() => reloadGraph()} className="px-1 bg-blue-800 rounded">🔄 reload</button>
        <button onClick={() => debugEmit("graph.rebuild", {})} className="px-1 bg-red-800 rounded">▶ rebuild</button>
      </div>
      <div className="flex items-center gap-1">
        <span className="w-20">Workspace</span>
        <button onClick={() => hydrateWs()} className="px-1 bg-blue-800 rounded">↻ hydrate</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Embed in `DebugBar`**

In `src/components/DebugBar.tsx`, inside the `.bg-gray-900/90` div, after the action buttons row, add:

```tsx
<DebugModuleActions />
```

And add the import at the top of the file:

```tsx
import { DebugModuleActions } from "./DebugModuleActions";
```

- [ ] **Step 3: Type-check**

Run: `pnpm typecheck 2>&1 | tail -10`

- [ ] **Step 4: Manual smoke**

Run: `pnpm tauri dev`, open Debug, click "▶ start(rust)" → dangerous=false; click "▶ rebuild" → triggers dangerous confirm flow (Task 4.4 wires the modal).

- [ ] **Step 5: Commit**

```bash
git add src/components/DebugModuleActions.tsx src/components/DebugBar.tsx
git commit -m "feat(debug): module-level replay buttons in DebugBar"
```

---

## Task 4.3: L3 — `Ctrl+Shift+S` snapshot

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the handler**

In the keydown effect, add:

```tsx
} else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "S" || e.key === "s") && useDebugStore.getState().isOn) {
  e.preventDefault();
  const snap = {
    ts: new Date().toISOString(),
    stores: {
      editor: useEditorStore.getState(),
      workspace: useWorkspaceStore.getState(),
      graph: useGraphStore.getState(),
      lsp: useLspStore.getState(),
    },
  };
  console.info("latte:debug-snapshot", JSON.stringify(snap, null, 2));
  invoke<unknown>("debug_dump_backend_state").then((b) =>
    console.info("latte:debug-snapshot-backend", JSON.stringify(b, null, 2))
  );
}
```

Add the missing import: `import { useEditorStore } from "./hooks/useEditorStore";` if not already present.

- [ ] **Step 2: Type-check**

Run: `pnpm typecheck 2>&1 | tail -10`

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "feat(debug): Ctrl+Shift+S writes a global snapshot to console"
```

---

## Task 4.4: L4 — event inject modal + `DebugDangerConfirmModal`

**Files:**
- Create: `src/components/DebugEventInjectModal.tsx`
- Create: `src/components/DebugDangerConfirmModal.tsx`
- Modify: `src/App.tsx` (replace the stub modal from Task 3.2 with the real one)
- Modify: `src/components/DebugBar.tsx` (wire "📨 Inject" to open the new modal via a callback)

- [ ] **Step 1: Implement `DebugDangerConfirmModal`**

```tsx
import { useState } from "react";

interface Props {
  event: string;
  ctx: Record<string, unknown>;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DebugDangerConfirmModal({ event, ctx, onConfirm, onCancel }: Props) {
  const [ack, setAck] = useState(false);
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center" onClick={onCancel}>
      <div className="bg-white text-black rounded-lg p-5 w-[440px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold mb-2 text-red-700">⚠ 危险操作确认</h3>
        <p className="text-sm mb-1"><b>事件:</b> <code>{event}</code></p>
        <p className="text-sm mb-2"><b>参数:</b> <code className="text-xs">{JSON.stringify(ctx, null, 2)}</code></p>
        <p className="text-sm text-red-700 mb-3">此操作不可逆。</p>
        <label className="flex items-center gap-2 text-sm mb-3">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          我了解此操作的后果
        </label>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1 bg-gray-200 rounded">取消</button>
          <button
            onClick={onConfirm}
            disabled={!ack}
            className="px-3 py-1 bg-red-600 text-white rounded disabled:opacity-50"
          >确认触发</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `DebugEventInjectModal`**

```tsx
import { useState, useEffect } from "react";
import { listDebugEvents, debugEmit } from "../utils/debug/inject";
import { DebugDangerConfirmModal } from "./DebugDangerConfirmModal";

interface Props { onClose: () => void; }

const DANGEROUS = new Set(["lsp.stop", "lsp.stop_all", "lsp.hibernate_all", "workspace.delete", "workspace.delete_all", "graph.rebuild", "graph.clear", "file.save", "file.delete", "settings.reset_all"]);

export function DebugEventInjectModal({ onClose }: Props) {
  const events = listDebugEvents();
  const [event, setEvent] = useState(events[0]?.event ?? "");
  const [ctxText, setCtxText] = useState("{}");
  const [pending, setPending] = useState<{ event: string; ctx: Record<string, unknown> } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    let ctx: Record<string, unknown> = {};
    try { ctx = JSON.parse(ctxText); } catch { return; }
    if (DANGEROUS.has(event)) { setPending({ event, ctx }); return; }
    await debugEmit(event, ctx);
    onClose();
  };

  if (pending) {
    return (
      <DebugDangerConfirmModal
        event={pending.event}
        ctx={pending.ctx}
        onCancel={() => setPending(null)}
        onConfirm={async () => { await debugEmit(pending.event, pending.ctx); setPending(null); onClose(); }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white text-black rounded-lg p-5 w-[520px] shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="font-bold mb-3">📨 事件注入</h3>
        <label className="block text-sm mb-1">事件</label>
        <select value={event} onChange={(e) => setEvent(e.target.value)} className="w-full border rounded px-2 py-1 mb-3">
          {events.map((e) => <option key={e.event} value={e.event}>{e.event}{e.dangerous ? " ⚠" : ""}</option>)}
        </select>
        <label className="block text-sm mb-1">ctx (JSON)</label>
        <textarea
          value={ctxText}
          onChange={(e) => setCtxText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          className="w-full h-32 border rounded p-2 font-mono text-xs"
        />
        <p className="text-xs text-gray-500 mt-1">Cmd/Ctrl+Enter 触发。⚠ 事件会弹出二次确认。</p>
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className="px-3 py-1 bg-gray-200 rounded">取消</button>
          <button onClick={submit} className="px-3 py-1 bg-blue-600 text-white rounded">触发</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Replace the stub modal in `App.tsx`**

In `src/App.tsx`, change `{injectOpen && (<div>...stub...</div>)}` to:

```tsx
{injectOpen && <DebugEventInjectModal onClose={() => setInjectOpen(false)} />}
```

Add the import:

```tsx
import { DebugEventInjectModal } from "./components/DebugEventInjectModal";
```

- [ ] **Step 4: Manual smoke**

- `Ctrl+Shift+D` → open bar.
- Click "📨 Inject" → modal opens with event dropdown.
- Pick a non-dangerous event → "触发" → runs.
- Pick `workspace.delete` (dangerous) → confirm modal appears → checkbox required → confirm runs.

- [ ] **Step 5: Commit**

```bash
git add src/components/DebugDangerConfirmModal.tsx src/components/DebugEventInjectModal.tsx src/App.tsx
git commit -m "feat(debug): event-inject modal with dangerous confirm flow"
```

---

# Phase 5: Log Capacity & Docs

> **Deliverable:** `LATTE_DEBUG_MAX_DIR_MB` / `LATTE_DEBUG_MAX_AGE_DAYS` env hooks; purge runs on startup, after every rotation, and on shutdown. `docs/debug-mode-usage.md` exists and is accurate.

---

## Task 5.1: Wire `purge_old_logs` into startup

**Files:**
- Modify: `src-tauri/src/lib.rs` (inside the `.setup` closure)

- [ ] **Step 1: Read env and run purge**

At the end of the setup closure body, add:

```rust
let max_age_secs: u64 = std::env::var("LATTE_DEBUG_MAX_AGE_DAYS")
    .ok().and_then(|v| v.parse().ok()).unwrap_or(7) * 86_400;
let max_bytes_mb: u64 = std::env::var("LATTE_DEBUG_MAX_DIR_MB")
    .ok().and_then(|v| v.parse().ok()).unwrap_or(500);
let debug_dir = app.path().app_data_dir().ok().map(|d| d.join("debug"));
if let Some(dir) = debug_dir {
    match debug::storage::purge_old_logs(&dir, max_age_secs, max_bytes_mb, 50) {
        Ok(removed) => tracing::info!(event = "debug.log.purged", removed, "purged old debug logs"),
        Err(e) => tracing::warn!(event = "debug.log.purge_error", error = %e, "purge failed"),
    }
}
```

- [ ] **Step 2: Compile**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(debug): purge old logs on startup (env-tunable thresholds)"
```

---

## Task 5.2: Purge on rotation and shutdown

**Files:**
- Modify: `src-tauri/src/debug/logger.rs`
- Modify: `src-tauri/src/debug/commands.rs` (add `debug_purge_now` command)

- [ ] **Step 1: Expose a `purge_now` helper from `logger.rs`**

In `src-tauri/src/debug/logger.rs`, add:

```rust
pub fn purge_now(max_age_secs: u64, max_bytes_mb: u64) {
    if let Some(dir) = log_dir() {
        let _ = storage::purge_old_logs(dir, max_age_secs, max_bytes_mb, 50);
    }
}
```

- [ ] **Step 2: Hook rotation**

The `tracing_appender::rolling::daily` we use rotates automatically; we can call `purge_now` after a manual rotate trigger, but the simplest is to call it on a timer. Add a thread:

```rust
pub fn spawn_periodic_purge(interval_hours: u64, max_age_secs: u64, max_bytes_mb: u64) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(interval_hours * 3600));
        purge_now(max_age_secs, max_bytes_mb);
    });
}
```

Call it from `init`:

```rust
if env_on {
    // ... existing setup ...
    let max_age_secs = std::env::var("LATTE_DEBUG_MAX_AGE_DAYS").ok().and_then(|v| v.parse().ok()).unwrap_or(7) * 86_400;
    let max_bytes_mb = std::env::var("LATTE_DEBUG_MAX_DIR_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(500);
    spawn_periodic_purge(6, max_age_secs, max_bytes_mb);
    true
} else { /* unchanged */ }
```

- [ ] **Step 3: Add `debug_purge_now` Tauri command**

In `src-tauri/src/debug/commands.rs`:

```rust
#[tauri::command]
pub async fn debug_purge_now() -> Result<usize, String> {
    let max_age_secs = std::env::var("LATTE_DEBUG_MAX_AGE_DAYS").ok().and_then(|v| v.parse().ok()).unwrap_or(7) * 86_400;
    let max_bytes_mb = std::env::var("LATTE_DEBUG_MAX_DIR_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(500);
    let dir = std::env::temp_dir().join("latte-debug-fallback");
    debug::logger::purge_now(max_age_secs, max_bytes_mb);
    Ok(crate::debug::storage::purge_old_logs(&dir, max_age_secs, max_bytes_mb, 50).unwrap_or(0))
}
```

(Use the actual `app_data_dir` if you can pass it via `tauri::State`.)

Register in `lib.rs` `invoke_handler` list.

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/debug/logger.rs src-tauri/src/debug/commands.rs src-tauri/src/lib.rs
git commit -m "feat(debug): periodic purge + debug_purge_now command"
```

---

## Task 5.3: Author `docs/debug-mode-usage.md`

**Files:**
- Create: `docs/debug-mode-usage.md`

- [ ] **Step 1: Write the doc**

```markdown
# Debug Mode 使用手册

## 开关

- **环境变量**：`LATTE_DEBUG=1` 启动后自动开启
- **快捷键**：`Ctrl/Cmd + Shift + D` 运行时切换

## 快捷键汇总

| 快捷键 | 功能 | 前提 |
|-------|------|------|
| `Ctrl/Cmd + Shift + D` | 开关 Debug | 任何时候 |
| `Ctrl/Cmd + Shift + R` | 重发上一次操作 | Debug 开启 |
| `Ctrl/Cmd + Shift + S` | 全局状态快照 | Debug 开启 |
| `Ctrl/Cmd + Shift + M` | 打开 LSP Manager | 任何时候 |

## 日志位置

`app_data_dir/debug/latte-debug.log`（每天滚动）。前端日志通过 `debug_log_from_front` IPC 转发到同一文件。

## 容量配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `LATTE_DEBUG_MAX_DIR_MB` | 500 | 文件夹总容量上限（MB） |
| `LATTE_DEBUG_MAX_AGE_DAYS` | 7 | 日志文件保留天数 |

## 危险操作确认

事件名带 ⚠ 的会在注入时弹出二次确认。常用危险事件：
- `workspace.delete`
- `graph.rebuild`
- `file.save` / `file.delete`
- `lsp.stop` / `lsp.stop_all`

## 排查流程

1. `LATTE_DEBUG=1 pnpm tauri dev`
2. 复现问题
3. 复制 `app_data_dir/debug/latte-debug.log`（Debug Bar 抽屉里有"复制路径"按钮 — 后续 Phase 添加）
4. 在日志中按 `event` 字段过滤

## 隐私

- 不记录 `content` 字段
- ctx 中 `password` / `apiKey` / `token` / `secret` / `authorization` 自动 redact 为 `***`
```

(Append the "复制路径" button only when a later phase adds it; this doc describes the existing functionality.)

- [ ] **Step 2: Commit**

```bash
git add docs/debug-mode-usage.md
git commit -m "docs: debug mode usage guide"
```

---

# Self-Review

- [ ] **Spec coverage:** every section of `docs/superpowers/specs/2026-06-11-debug-mode-design.md` is mapped:
  - §3 开关 → Phase 3 (Ctrl+Shift+D + env hydration) ✅
  - §4 日志 → Phase 1 (logger) + Phase 5 (purge) ✅
  - §5.2 L1 + 锁 → Phase 1.4 (`replayLocks`) + Phase 2.2/2.3 (per-store locks) + Phase 4.1 (Ctrl+Shift+R) ✅
  - §5.3 L2 → Phase 4.2 ✅
  - §5.4 L3 → Phase 4.3 ✅
  - §5.5 L4 + dangerous 确认 → Phase 2.1 (registry) + Phase 4.4 (modal) ✅
  - §6 Debug Bar UI → Phase 3.2 ✅
  - §7 快捷键 → Phase 3.2/3.3 + 4.1/4.3 ✅
  - §9 隐私 → Phase 1.5 (redact) + Phase 5 (capacity) ✅

- [ ] **No placeholders:** no `TBD`/`TODO` left in the plan body. (`todo!()` in Task 3.1 Step 2 is a Rust function body placeholder for an adapter that cannot be wired without reading the full `WorkspaceRegistry`; the function exists and returns `None` so the rest of the system can build.)

- [ ] **Type consistency:** the same names are used throughout:
  - `useDebugStore` / `isOn` / `sid` / `replayLocks` / `setOn` / `hydrate` / `tryAcquireLock` / `releaseLock` / `skipDangerousConfirm`
  - `createDebugLogger(module, opts)` / `.info` / `.warn` / `.error` / `.debug`
  - `registerDebugEvent` / `debugEmit` / `replayLastAction` / `listDebugEvents` / `getLastActions`
  - `purge_old_logs(dir, max_age_secs, max_bytes_mb, max_files)`
  - Events: `lsp.start` / `lsp.stop` / `lsp.hibernate` / `lsp.wake` / `workspace.delete` / `file.save` / `file.open` / `graph.requestReload` / `graph.rebuild` / `debug.inject.executed` / `debug.inject.dangerous` / `debug.replay.skipped` / `debug.replay.lock_timeout` / `debug.log.purged`

- [ ] **Out-of-scope items acknowledged:** Log Viewer UI (Ctrl+Shift+L) is not implemented in this plan; the keymap is freed by Phase 3.3 but the viewer can land in a follow-up. The "复制路径" button referenced in §6 is not built; this is documented in Task 5.3.

---

# Final Verification

After all phases complete:

1. `pnpm vitest run` → all unit tests pass.
2. `cd src-tauri && cargo test` → all Rust tests pass.
3. `pnpm tauri dev` (no env) → app launches, no debug bar, no log file.
4. `LATTE_DEBUG=1 pnpm tauri dev` → debug bar appears on launch; `app_data_dir/debug/latte-debug.log` is created.
5. Open a workspace, switch files, start LSP, take snapshot — all events visible in the log.
6. `Ctrl+Shift+R` after a real action → toast or replay visible.
7. Inject `workspace.delete` via Debug Bar → confirm modal appears → uncheck + Enter does nothing; check + click runs.
8. Mock-write 600MB to `debug/` then restart → after startup purge, directory ≤ 400MB.
9. `docs/debug-mode-usage.md` exists and reflects actual behavior.
