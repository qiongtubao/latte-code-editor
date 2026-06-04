import { useRef, useEffect, useState, useCallback, useMemo } from "react";

interface LargeFileViewerProps {
  content: string;
  fileName: string;
}

const VISIBLE_LINES = 100;
const LINE_HEIGHT = 22;

export function LargeFileViewer({ content, fileName }: LargeFileViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);

  const lines = useMemo(() => content.split("\n"), [content]);
  const totalLines = lines.length;

  // Calculate visible range
  const startLine = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - 20);
  const endLine = Math.min(totalLines, startLine + VISIBLE_LINES + 40);
  const visibleLines = lines.slice(startLine, endLine);

  const totalHeight = totalLines * LINE_HEIGHT;

  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const fileSize = useMemo(() => {
    if (totalLines > 100000) {
      return ">100K lines";
    }
    return `${totalLines} lines`;
  }, [totalLines]);

  return (
    <div className="flex flex-col h-full" style={{ background: "#1e1e1e" }}>
      <div className="px-4 py-2 text-xs text-gray-400 border-b border-gray-700 bg-[#252526] flex items-center gap-4">
        <span className="text-yellow-400 font-medium">⚠ Large File Mode</span>
        <span>{fileName}</span>
        <span className="text-gray-500">{fileSize}</span>
        <span className="text-gray-500">Read-only | No syntax highlighting</span>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto"
        style={{
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: "13px",
          lineHeight: `${LINE_HEIGHT}px`,
        }}
      >
        <div style={{ height: totalHeight, position: "relative" }}>
          <pre
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              padding: "8px 16px",
              margin: 0,
            }}
          >
            {visibleLines.map((line, i) => (
              <div key={startLine + i} style={{ height: LINE_HEIGHT, whiteSpace: "pre" }}>
                {line || " "}
              </div>
            ))}
          </pre>
        </div>
      </div>
    </div>
  );
}
