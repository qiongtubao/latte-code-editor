/**
 * Renders a markdown document with inline flow-diagram SVGs.
 * Flow nodes that carry a `codeRef` are clickable — they dispatch a
 * custom "doc-navigate" event that App.tsx handles to open the file.
 */
import { useMemo, useCallback, useState } from "react";
import { parseFlowDiagrams, renderFlowSvg } from "../utils/flowParser";
import type { FlowDiagram } from "../utils/flowParser";
import { markdownToHtml } from "../utils/markdown";
import { aiReview } from "../api/ai";
interface Props {
  content: string;
  filePath?: string;
}

export function DocViewer({ content, filePath }: Props) {
  const diagrams = useMemo(() => parseFlowDiagrams(content), [content]);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const handleSvgClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest("a.flow-node-link");
      if (!anchor) return;
      e.preventDefault();
      const file = anchor.getAttribute("data-file");
      const line = anchor.getAttribute("data-line");
      if (file) {
        window.dispatchEvent(
          new CustomEvent("doc-navigate", {
            detail: { file, line: line ? parseInt(line, 10) : 1 },
          }),
        );
      }
    },
    [],
  );

  // Split content: code fences (flow:<id>) → replaced with inline SVG
  const parts = useMemo(() => splitContent(content, diagrams), [content, diagrams]);

  return (
    <div className="flex-1 overflow-y-auto p-4 text-sm" onClick={handleSvgClick}>
      {filePath && (
        <div className="text-xs text-fg-3 mb-2 font-mono truncate flex items-center justify-between">
          <span>{filePath.split("/").pop()}</span>
          <button
            onClick={async () => {
              setAiLoading(true);
              setAiResult(null);
              const r = await aiReview(content.slice(0, 4000));
              setAiResult(r.message);
              setAiLoading(false);
            }}
            disabled={aiLoading}
            className="px-2 py-0.5 bg-accent text-white rounded text-[10px] hover:bg-accent disabled:opacity-50"
          >{aiLoading ? "..." : "AI Review"}</button>
        </div>
      )}
      {aiResult && (
        <div className="mb-3 p-2 bg-ok-bg border border-ok rounded text-xs text-fg whitespace-pre-wrap">
          {aiResult}
        </div>
      )}
      {parts.map((part, i) => (
        <div key={i} className="mb-4">
          {part}
        </div>
      ))}
    </div>
  );
}

function splitContent(
  raw: string,
  diagrams: FlowDiagram[],
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const fenceRe = /^```flow:\S+\s*\n[\s\S]*?^```$/gm;
  let lastIdx = 0;
  let di = 0;
  let m: RegExpExecArray | null;

  while ((m = fenceRe.exec(raw)) !== null) {
    // Text before this fence
    const before = raw.slice(lastIdx, m.index);
    if (before.trim()) {
      parts.push(<div key={`t${lastIdx}`} dangerouslySetInnerHTML={{ __html: markdownToHtml(before) }} />);
    }
    // Replace fence with SVG
    if (di < diagrams.length) {
      const svg = renderFlowSvg(diagrams[di]);
      parts.push(
        <div key={`svg${di}`} className="my-3 border border-edge rounded p-2 bg-surface">
          <div className="text-xs text-fg-3 mb-1 font-medium">{diagrams[di].title}</div>
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        </div>,
      );
      di++;
    } else {
      // Fallback: show raw text
      parts.push(
        <pre key={`raw${di}`} className="text-xs text-fg-2 bg-surface p-2 rounded overflow-x-auto">
          {m[0]}
        </pre>,
      );
    }
    lastIdx = (m.index ?? 0) + m[0].length;
  }

  // Trailing text
  const trailing = raw.slice(lastIdx);
  if (trailing.trim()) {
    parts.push(<div key={`t${lastIdx}`} dangerouslySetInnerHTML={{ __html: markdownToHtml(trailing) }} />);
  }

  if (parts.length === 0 && !raw.trim()) {
    parts.push(<div key="empty" className="text-fg-3 text-center italic mt-8">(empty document)</div>);
  }
  return parts;
}

