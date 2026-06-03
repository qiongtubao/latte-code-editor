import { useCallback, useState } from "react";
import type { RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CallNode } from "@latte/editor";
import { languageFromPath } from "../components/languageFromPath.js";

/**
 * `CallNode` is imported from `@latte/editor`; source of truth is
 * `Drawer.tsx`. The hook types its `onJump` argument with the same
 * shape so the editor package and the desktop host stay structurally
 * aligned.
 */
export type { CallNode };

export interface NavigationFile {
  path: string;
}

export interface UseSymbolNavigationArgs {
  /** Currently-open file in the editor (or `null`). */
  file: NavigationFile | null;
  /** Setter for the file state in the parent. */
  setFile: (updater: { path: string; name: string; content: string; savedContent: string; language: string; isReadOnly?: boolean } | null) => void;
  /** Imperative handle to the Monaco editor (for `revealLine`). */
  monacoRef: RefObject<{ revealLine: (line: number) => void } | null>;
  /** Current workspace root, or `null` if no workspace is open. */
  workspace: string | null;
  /**
   * Guard from the parent's "unsaved changes" prompt. Called before any
   * file swap. Implementations should run `swap()` if it's OK to discard
   * (or save) the current buffer. The same guard is used by `useSave`'s
   * file-switch prompt — both should funnel through the same function so
   * the user sees a single, consistent confirm.
   */
  requestFileSwitch: (swap: () => void) => void;
  /** Banner setter, used to surface read failures from `onJump`. */
  setEditorBanner: (msg: string | null) => void;
}

export interface UseSymbolNavigationReturn {
  /** The symbol whose call hierarchy the Drawer is showing (`null` ⇒ closed). */
  drawerSymbol: string | null;
  /** Called from the editor's `onSymbolClick` — sets `drawerSymbol` only. */
  onSymbolClick: (symbol: string) => void;
  /** Called from a Drawer row click — guarded load + `revealLine`. */
  onJump: (node: CallNode) => void;
  /** Closes the Drawer. */
  closeDrawer: () => void;
}

export function useSymbolNavigation({
  file,
  setFile,
  monacoRef,
  workspace,
  requestFileSwitch,
  setEditorBanner,
}: UseSymbolNavigationArgs): UseSymbolNavigationReturn {
  const [drawerSymbol, setDrawerSymbol] = useState<string | null>(null);

  const onSymbolClick = useCallback((symbol: string) => {
    setDrawerSymbol(symbol);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerSymbol(null);
  }, []);

  const onJump = useCallback((node: CallNode) => {
    const jump = () => {
      // If we're already on the target file, just scroll.
      if (file?.path === node.file) {
        monacoRef.current?.revealLine(node.line);
        return;
      }
      void invoke<string>("cmd_read_file", { path: node.file })
        .then((content) => {
          setFile({
            path: node.file,
            name: node.file.split("/").pop() ?? node.file,
            content,
            language: languageFromPath(node.file),
            savedContent: content,
          });
          monacoRef.current?.revealLine(node.line);
        })
        .catch((err: unknown) => {
          setEditorBanner(`open failed: ${node.file} — ${String(err)}`);
        });
    };
    requestFileSwitch(jump);
  }, [file, monacoRef, workspace, requestFileSwitch, setEditorBanner, setFile]);

  return { drawerSymbol, onSymbolClick, onJump, closeDrawer };
}
