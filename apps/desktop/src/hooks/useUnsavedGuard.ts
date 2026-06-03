import { invoke } from "@tauri-apps/api/core";

/**
 * Shared "discard unsaved changes?" prompt. Used by both `useSave`
 * (for FileTree / workspace-changed / go-to-def file swaps) and
 * `useSymbolNavigation` (for Drawer row jumps). Centralising here
 * means the prompt wording and `buttons` shape are guaranteed
 * consistent across the editor.
 *
 * We deliberately do not await the dialog — this function returns
 * synchronously and the thunk runs on the dialog's `.then`. The
 * caller does not need to await; both `useSave.requestFileSwitch`
 * and `useSymbolNavigation.onJump` are already fire-and-forget at
 * the call site.
 *
 * Wire form of the dialog result is `MessageDialogResult`:
 *   - `OkCancelCustom("Discard","Cancel")` → user clicks Discard
 *     returns `"Discard"` (via rfd's `Custom(label)` + serde untagged)
 *   - ESC / window close → always `"Cancel"`
 * So we test `result !== "Cancel"`. See `tasks/lessons.md` for the
 * full wire-form table.
 */
export function requestFileSwitch(dirty: boolean, swap: () => void): void {
  if (!dirty) {
    swap();
    return;
  }
  void invoke<string>("plugin:dialog|message", {
    title: "Unsaved changes",
    message: "Discard unsaved changes?",
    kind: "warning",
    buttons: { OkCancelCustom: ["Discard", "Cancel"] },
  }).then((result) => {
    if (result !== "Cancel") swap();
  });
}
