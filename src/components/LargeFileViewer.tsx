import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { FileResult } from "../api/commands";
import { readFileRange, statTextFile } from "../api/commands";

interface LargeFileViewerProps {
  /**
   * The object identity changes after refresh even when the path and line count
   * stay the same. Keeping it as the source lets the viewer invalidate pages
   * for same-size external edits as well as ordinary tab switches.
   */
  file: FileResult;
}

export const LARGE_FILE_PAGE_SIZE = 256;
export const LARGE_FILE_LINE_HEIGHT = 22;
const OVERSCAN_LINES = 30;
const MAX_CACHED_PAGES = 24;
// Chromium has a finite useful layout/scroll range. Compress very tall files
// into this track and map its scroll ratio back to a logical line number.
const MAX_SCROLL_HEIGHT = 16_000_000;

interface ViewWindow {
  firstVisible: number;
  start: number;
  end: number;
  scrollHeight: number;
}

export function calculateViewWindow(
  scrollTop: number,
  containerHeight: number,
  totalLines: number,
): ViewWindow {
  const viewportLines = Math.max(1, Math.ceil(containerHeight / LARGE_FILE_LINE_HEIGHT));
  const logicalHeight = totalLines * LARGE_FILE_LINE_HEIGHT;
  const scrollHeight = Math.min(logicalHeight, MAX_SCROLL_HEIGHT);
  const maxStart = Math.max(0, totalLines - viewportLines);
  const maxScrollTop = Math.max(0, scrollHeight - containerHeight);

  const firstVisible = logicalHeight <= MAX_SCROLL_HEIGHT
    ? Math.min(maxStart, Math.max(0, Math.floor(scrollTop / LARGE_FILE_LINE_HEIGHT)))
    : Math.min(
        maxStart,
        Math.max(0, Math.round((scrollTop / Math.max(1, maxScrollTop)) * maxStart)),
      );
  const start = Math.max(0, firstVisible - OVERSCAN_LINES);
  const end = Math.min(totalLines, firstVisible + viewportLines + OVERSCAN_LINES);
  return { firstVisible, start, end, scrollHeight };
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function LargeFileViewer({ file }: LargeFileViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef(file);
  sourceRef.current = file;
  const generationRef = useRef(0);
  const pageCacheRef = useRef(new Map<number, string[]>());
  const inFlightRef = useRef(new Map<number, Promise<void>>());
  const desiredPagesRef = useRef(new Set<number>());
  const scrollFrameRef = useRef<number | null>(null);

  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  const [totalLines, setTotalLines] = useState(0);
  const [byteSize, setByteSize] = useState(0);
  const [pages, setPages] = useState<Map<number, string[]>>(() => new Map());
  const [loadingStat, setLoadingStat] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(
    (source: FileResult, pageStart: number, generation: number) => {
      if (pageCacheRef.current.has(pageStart) || inFlightRef.current.has(pageStart)) return;

      const request = readFileRange(source.path, pageStart, LARGE_FILE_PAGE_SIZE)
        .then((range) => {
          if (generationRef.current !== generation || sourceRef.current !== source) return;
          // The echoed start line prevents a malformed/stale response from being
          // inserted under the wrong cache key.
          if (range.start_line !== pageStart) {
            throw new Error(`Range response started at ${range.start_line}, expected ${pageStart}`);
          }
          const desiredPages = desiredPagesRef.current;
          // During a fast scrollbar drag many old requests can finish after the
          // current page. Never let one of those evict content under the viewport.
          if (!desiredPages.has(pageStart) && pageCacheRef.current.size >= MAX_CACHED_PAGES) {
            return;
          }
          const next = new Map(pageCacheRef.current);
          next.delete(pageStart);
          next.set(pageStart, range.lines);
          while (next.size > MAX_CACHED_PAGES) {
            const disposable = [...next.keys()].find((key) => !desiredPages.has(key));
            const oldest = disposable ?? (next.keys().next().value as number | undefined);
            if (oldest === undefined) break;
            next.delete(oldest);
          }
          pageCacheRef.current = next;
          setPages(next);
          setError(null);
        })
        .catch((reason: unknown) => {
          if (generationRef.current === generation && sourceRef.current === source) {
            setError(`Cannot read this part of the file: ${errorMessage(reason)}`);
          }
        })
        .finally(() => {
          // An old request may finish after a new generation has started a
          // request for the same page. Only remove our own promise.
          if (inFlightRef.current.get(pageStart) === request) {
            inFlightRef.current.delete(pageStart);
          }
        });
      inFlightRef.current.set(pageStart, request);
    },
    [],
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    pageCacheRef.current = new Map();
    inFlightRef.current = new Map();
    desiredPagesRef.current = new Set();
    setPages(new Map());
    setTotalLines(0);
    setByteSize(0);
    setScrollTop(0);
    setLoadingStat(true);
    setError(null);
    if (containerRef.current) containerRef.current.scrollTop = 0;

    void statTextFile(file.path)
      .then((stat) => {
        if (generationRef.current !== generation || sourceRef.current !== file) return;
        setTotalLines(stat.total_lines);
        setByteSize(stat.byte_size);
        setLoadingStat(false);
      })
      .catch((reason: unknown) => {
        if (generationRef.current !== generation || sourceRef.current !== file) return;
        setLoadingStat(false);
        setError(`Cannot inspect file: ${errorMessage(reason)}`);
      });

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [file]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const height = entries.at(-1)?.contentRect.height;
      if (height !== undefined && height > 0) setContainerHeight(height);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    },
    [],
  );

  const view = useMemo(
    () => calculateViewWindow(scrollTop, containerHeight, totalLines),
    [scrollTop, containerHeight, totalLines],
  );

  useEffect(() => {
    if (totalLines === 0 || view.end <= view.start) return;
    const generation = generationRef.current;
    const firstPage = Math.floor(view.start / LARGE_FILE_PAGE_SIZE) * LARGE_FILE_PAGE_SIZE;
    const lastPage = Math.floor((view.end - 1) / LARGE_FILE_PAGE_SIZE) * LARGE_FILE_PAGE_SIZE;
    const desired = new Set<number>();
    for (let pageStart = firstPage; pageStart <= lastPage; pageStart += LARGE_FILE_PAGE_SIZE) {
      desired.add(pageStart);
    }
    desiredPagesRef.current = desired;
    for (const pageStart of desired) {
      loadPage(file, pageStart, generation);
    }
  }, [file, loadPage, totalLines, view.start, view.end]);

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      setScrollTop(containerRef.current?.scrollTop ?? 0);
    });
  }, []);

  const rows = useMemo(() => {
    const result: Array<{ lineNumber: number; text: string | undefined }> = [];
    for (let lineNumber = view.start; lineNumber < view.end; lineNumber += 1) {
      const pageStart = Math.floor(lineNumber / LARGE_FILE_PAGE_SIZE) * LARGE_FILE_PAGE_SIZE;
      result.push({
        lineNumber,
        text: pages.get(pageStart)?.[lineNumber - pageStart],
      });
    }
    return result;
  }, [pages, view.start, view.end]);

  const renderedHeight = rows.length * LARGE_FILE_LINE_HEIGHT;
  // Anchor the actual 22px rows around the current viewport. This works both
  // for ordinary 1:1 scrolling and for the compressed track used by files so
  // tall that their logical CSS height exceeds Chromium's practical limit.
  const rowsTop = Math.min(
    Math.max(0, view.scrollHeight - renderedHeight),
    Math.max(0, scrollTop - (view.firstVisible - view.start) * LARGE_FILE_LINE_HEIGHT),
  );
  const rowStyle: CSSProperties = { height: LARGE_FILE_LINE_HEIGHT, whiteSpace: "pre" };

  return (
    <div className="flex flex-col h-full" style={{ background: "var(--surface)" }}>
      <div className="px-4 py-2 text-xs text-fg-2 border-b border-edge bg-surface-2 flex items-center gap-4">
        <span className="text-warn font-medium">⚠ Large File Mode</span>
        <span>{file.path}</span>
        <span className="text-fg-3">
          {loadingStat ? "Inspecting…" : `${totalLines.toLocaleString()} lines · ${formatByteSize(byteSize)}`}
        </span>
        <span className="text-fg-3">Read-only | Paged | No syntax highlighting</span>
      </div>
      {error && (
        <div role="alert" className="px-4 py-2 text-xs text-danger border-b border-edge bg-surface-2">
          {error}
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        data-testid="large-file-scroll"
        className="flex-1 overflow-auto"
        style={{
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: "13px",
          lineHeight: `${LARGE_FILE_LINE_HEIGHT}px`,
        }}
      >
        <div style={{ height: view.scrollHeight, position: "relative", minWidth: "max-content" }}>
          <div
            style={{
              position: "absolute",
              top: rowsTop,
              left: 0,
              padding: "0 16px",
              margin: 0,
            }}
          >
            {rows.map(({ lineNumber, text }) => (
              <div key={lineNumber} data-line={lineNumber} style={rowStyle}>
                {text === undefined ? " " : text || " "}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
