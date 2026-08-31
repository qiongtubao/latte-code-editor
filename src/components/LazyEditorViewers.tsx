import type { FileResult } from "../api/commands";
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

const loadMarkdownPreview = createRetryableLoader<MarkdownPreviewProps>(async () =>
  import("./DocViewer").then((module) => module.DocViewer),
);
const loadLargeFileMode = createRetryableLoader<LargeFileModeProps>(async () =>
  import("./LargeFileViewer").then((module) => module.LargeFileViewer),
);

export const preloadMarkdownPreview = () => loadMarkdownPreview();

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
