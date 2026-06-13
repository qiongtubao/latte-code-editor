/**
 * Renders a markdown document with inline flow-diagram SVGs.
 * Flow nodes that carry a `codeRef` are clickable — they dispatch a
 * custom "doc-navigate" event that App.tsx handles to open the file.
 */
import { useMemo, useCallback } from "react";
import { parseFlowDiagrams, renderFlowSvg, FlowDiagram } from "../utils/flowParser";

interface Props {
  content: string;
  filePath?: string;
}

export function DocViewer({ content, filePath }: Props) {
  const diagrams = useMemo(() => parseFlowDiagrams(content), [content]);

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
        <div className="text-xs text-gray-500 mb-2 font-mono truncate">
          {filePath.split("/").pop()}
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
      parts.push(<div key={`t${lastIdx}`} dangerouslySetInnerHTML={{ __html: mdToHtml(before) }} />);
    }
    // Replace fence with SVG
    if (di < diagrams.length) {
      const svg = renderFlowSvg(diagrams[di]);
      parts.push(
        <div key={`svg${di}`} className="my-3 border border-gray-700 rounded p-2 bg-[#1a1a1a]">
          <div className="text-xs text-gray-500 mb-1 font-medium">{diagrams[di].title}</div>
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        </div>,
      );
      di++;
    } else {
      // Fallback: show raw text
      parts.push(
        <pre key={`raw${di}`} className="text-xs text-gray-400 bg-[#111] p-2 rounded overflow-x-auto">
          {m[0]}
        </pre>,
      );
    }
    lastIdx = (m.index ?? 0) + m[0].length;
  }

  // Trailing text
  const trailing = raw.slice(lastIdx);
  if (trailing.trim()) {
    parts.push(<div key={`t${lastIdx}`} dangerouslySetInnerHTML={{ __html: mdToHtml(trailing) }} />);
  }

  if (parts.length === 0 && !raw.trim()) {
    parts.push(<div key="empty" className="text-gray-500 text-center italic mt-8">(empty document)</div>);
  }
  return parts;
}

/** Minimal markdown → HTML converter (headings, bold, italic, code, links, paragraphs). */
function mdToHtml(md: string): string {
  let html = md;
  // Headings
  html = html.replace(/^#### (.+)$/gm, "<h4 class='text-sm font-semibold mt-3 mb-1 text-gray-200'>$1</h4>");
  html = html.replace(/^### (.+)$/gm, "<h3 class='text-base font-semibold mt-3 mb-1 text-gray-200'>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2 class='text-lg font-semibold mt-4 mb-2 text-gray-100 border-b border-gray-700 pb-1'>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1 class='text-xl font-bold mt-4 mb-2 text-white'>$1</h1>");
  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code class='bg-[#333] px-1 rounded text-xs text-gray-300 font-mono'>$1</code>");
  // Wikilinks → plain text (no sidebar navigation yet)
  html = html.replace(/\[\[([^\]]+)\]\]/g, "<span class='text-blue-400 underline cursor-default'>$1</span>");
  // Paragraphs (double newline)
  html = html.replace(/\n\s*\n/g, "</p><p class='mb-2 leading-relaxed text-gray-300'>");
  html = "<p class='mb-2 leading-relaxed text-gray-300'>" + html + "</p>";
  return html;
}
