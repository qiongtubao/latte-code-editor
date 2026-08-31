import type { FileResult } from "../api/commands";
import type { CodeMirrorProps } from "./CodeMirrorEditor";
import {
  createRetryableLoader,
  LazyFeatureBoundary,
  type ComponentLoader,
} from "./LazyFeatureBoundary";

export interface MarkdownPreviewProps {
  content: string;
  filePath?: string;
}

export interface LargeFileModeProps {
  file: FileResult;
}

const loadCodeEditor = createRetryableLoader<CodeMirrorProps>(async () =>
  import("./CodeMirrorEditor").then((module) => module.CodeMirrorEditor),
);
const loadMarkdownPreview = createRetryableLoader<MarkdownPreviewProps>(async () =>
  import("./DocViewer").then((module) => module.DocViewer),
);
const loadLargeFileMode = createRetryableLoader<LargeFileModeProps>(async () =>
  import("./LargeFileViewer").then((module) => module.LargeFileViewer),
);

export const preloadCodeEditor = () => loadCodeEditor();
export const preloadMarkdownPreview = () => loadMarkdownPreview();

const CODE_EXTENSIONS = new Set([
  "c", "cc", "cjs", "cpp", "cts", "cxx",
  "h", "hh", "hpp", "hxx",
  "js", "jsx", "mjs", "mts",
  "py", "rs", "tcl", "ts", "tsx", "json",
]);

/** Avoid downloading 416KB for logs/Markdown/binaries; warm only known code. */
export function shouldPreloadCodeEditor(path: string): boolean {
  const fileName = path.split(/[\\/]/).pop() ?? "";
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return false;
  return CODE_EXTENSIONS.has(fileName.slice(dot + 1).toLowerCase());
}

export function LazyCodeEditor({
  loader = loadCodeEditor,
  ...props
}: CodeMirrorProps & { loader?: ComponentLoader<CodeMirrorProps> }) {
  return (
    <LazyFeatureBoundary
      loader={loader}
      componentProps={props}
      label="code editor"
    />
  );
}

export function LazyMarkdownPreview({
  loader = loadMarkdownPreview,
  ...props
}: MarkdownPreviewProps & { loader?: ComponentLoader<MarkdownPreviewProps> }) {
  return (
    <LazyFeatureBoundary
      loader={loader}
      componentProps={props}
      label="Markdown preview"
    />
  );
}

export function LazyLargeFileMode({
  loader = loadLargeFileMode,
  ...props
}: LargeFileModeProps & { loader?: ComponentLoader<LargeFileModeProps> }) {
  return (
    <LazyFeatureBoundary
      loader={loader}
      componentProps={props}
      label="large-file viewer"
    />
  );
}
