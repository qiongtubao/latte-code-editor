# Lessons

Lows and highs from real bugs. Each entry is anchored to a concrete
incident and is meant to prevent the same mistake from happening twice.

---

## 2026-06-03 — "点开文件夹卡死了" — `cmd_pick_folder` 死锁 → 84 秒后 NSOpenPanel NULL → abort

### Symptom

Selecting "Open Folder" in latte-desktop made the app freeze with no UI
feedback, then ~84 seconds later the process aborted with:

```
*** Assertion failure in -[NSOpenPanel _initBridgeAndStuff], NSSavePanel.m:432
unexpected NULL returned from +[NSOpenPanel openPanel]
panic in a function that cannot unwind
aborting.
```

In an earlier capture, Instruments showed 22 threads (main + 15+ tokio
workers) all stuck in `semaphore_wait_trap` / `psynch_cvwait`. Two
different failure modes (deadlock vs. abort), same root cause.

### Root cause (verified by reading the source)

The bug lives at the intersection of three layers:

1. **WKWebView URL-scheme handler** — wry's
   `wkwebview/class/url_scheme_handler.rs::start_task` is an `extern "C"`
   Objective-C method dispatched by WebKit on the **main thread**. Tauri
   uses this to serve `invoke()` calls from the renderer. The function
   synchronously calls a user-registered `function` closure (the Tauri
   invoke handler) before returning.
2. **Tauri command dispatch model** — Tauri 2 treats `#[tauri::command]`
   `fn` (sync) and `async fn` very differently:
   - `fn`: invoked on Tauri's IPC worker pool via `spawn_blocking`, but
     the **caller** (the wry url-scheme handler) still synchronously
     `block_on`s the result, so the main thread is held inside
     `start_task` until the command returns.
   - `async fn`: Tauri's runtime `spawn`s the future and immediately
     returns a pending response to the url-scheme handler. The main
     thread is freed to pump the NSApp event loop on the next tick.
3. **rfd 0.16's `run_on_main`** (`backend/macos/utils.rs:20`) is honest
   about what it does: if it's already on the main thread, it just runs
   the closure synchronously. There is no "are we inside an AppKit
   callback?" check.

When `cmd_pick_folder` was a sync `fn` that called
`app.dialog().file().blocking_pick_folder()`:

- The Tauri IPC worker (a tokio blocking-pool thread) ran the command
  body.
- That body called `tauri_plugin_dialog::pick_folder`, which posts a
  closure to the main thread via `run_on_main_thread` (tao).
- The closure creates an `rfd::AsyncFileDialog`, calls `.pick_folder()`,
  and `block_on`s its future on a freshly `std::thread::spawn`'d
  thread.
- rfd's `run_on_main` saw it was **not** on the main thread and used
  `dispatch2::run_on_main` to enqueue the actual `NSOpenPanel` creation
  on the main thread's dispatch queue.
- **The main thread was still inside `start_task`**, which was still
  blocking on the Tauri IPC worker, which was still blocking on
  `rx.recv()`. The NSApp event loop was not pumping. The
  `dispatch2`-enqueued closure never ran.
- After ~84 seconds, WKWebView's internal timeout (or AppKit's modal
  recovery) made `+[NSOpenPanel openPanel]` get called anyway in a
  corrupted context. It returned `NULL`. `objc2-app-kit` 0.3.2's typed
  binding (`generated/NSOpenPanel.rs:127`) hits an
  `expect_nonwind`-style panic on the NULL, the panic crosses an FFI
  boundary, and `panic_cannot_unwind` → `abort()`.

### The fix

`cmd_pick_folder` was changed from a sync `fn` to `async fn`, with the
blocking call wrapped in `tauri::async_runtime::spawn_blocking`:

```rust
#[tauri::command]
pub async fn cmd_pick_folder(app: tauri::AppHandle) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog().file().blocking_pick_folder()
    })
    .await
    .ok()
    .flatten()
    .map(|p| p.to_string())
}
```

Now the url-scheme handler returns immediately after the async future
is spawned. The blocking pool worker threads the rfd call off to the
main thread via `dispatch2`, and by the time the main thread processes
that dispatch item, the url-scheme callback has already returned and
the NSApp run loop is free.

### Lessons

1. **Tauri 2 `fn` vs `async fn` is not a style choice — it changes who
   holds the main thread.** Default new commands to `async fn` unless
   they are genuinely fire-and-forget. A sync Tauri command holds the
   WKWebView url-scheme handler's main-thread stack frame for the
   entire duration of the command, including any time it spends
   waiting for the main thread to do something.

2. **Never call `blocking_pick_*` / `blocking_save_file` /
   `blocking_show*` from a sync `#[tauri::command]`.** The plugin's own
   docs say "do not use on the main thread", but a sync command *is*
   effectively on the main thread for url-scheme handler purposes, and
   the docs do not make that clear. If you must call a blocking dialog
   from Rust, make the command `async` and wrap the blocking call in
   `spawn_blocking`.

3. **macOS modal sessions cannot be presented while the main thread is
   inside a WKWebView url-scheme callback.** The crash is not unique to
   Tauri — any native macOS code that tries to start an `NSOpenPanel`
   (or other modal session) from a `WKURLSchemeHandler` callback will
   either deadlock or, after timeout, return `NULL` from
   `+[NSOpenPanel openPanel]`. Always defer the dialog creation to the
   *next* event-loop tick (e.g. via `dispatch2::run_on_main` or
   `tauri::async_runtime::spawn_blocking` from an async command).

4. **Diagnostic order matters.** When the symptom is "main thread
   stuck, N other threads stuck on it", do not start by trying to read
   every thread's stack. First, identify the topmost main-thread frame
   in the *unblocked* scenario (here: the url-scheme handler), then
   reason about what it is waiting on. In this case, the Instruments
   "21 threads in semaphore_wait_trap" output was a distraction — the
   real question was "what is the main thread doing?", and the answer
   was "sitting in `start_task` waiting for a sync Tauri command to
   return".

5. **Wry issue #1716 is *not* this bug.** That PR fixes a different
   `+[NSOpenPanel openPanel]` site — `WryWebViewUIDelegate::
   run_file_upload_panel` in `wry_web_view_ui_delegate.rs`, which
   serves `<input type="file">`. Our code does not go through there;
   it goes through `cmd_pick_folder` → `tauri-plugin-dialog` → rfd.
   Searching for "NSOpenPanel NULL" against the wry and
   plugins-workspace repos returned hits that *looked* relevant and
   nearly sent me down a path of `[patch.crates-io]` against the wrong
   file. Always trace the actual call stack to a file you can read
   before applying a fix from someone else's bug.

6. **Don't trust your first two analyses.** I told the user twice that
   "async won't help, JS-side plugin-dialog won't help, both paths are
   the same deadlock". Both were wrong. The reason: I had not read
   Tauri's command-dispatch source and was reasoning from the
   "plumbing looks identical" assumption. Per `CLAUDE.md`: don't
   change code without understanding the root cause, and don't
   recommend a fix without first reading the code path you're
   recommending against. Reading
   `wry-0.55.1/src/wkwebview/class/url_scheme_handler.rs` (no
   `NSOpenPanel`), `tauri-plugin-dialog-2.7.1/src/desktop.rs` and
   `/commands.rs`, and
   `rfd-0.16.0/src/backend/macos/{utils,file_dialog,file_dialog/
   panel_ffi}.rs` end-to-end was the only thing that produced a
   correct fix.
