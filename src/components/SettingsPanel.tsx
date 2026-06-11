import { useSettingsStore, type EditorTheme, type GraphRendererKind } from "../hooks/useSettingsStore";

const themeLabels: Record<EditorTheme, string> = {
  monokai: "Monokai",
  dracula: "Dracula",
  oneDark: "One Dark",
  solarizedLight: "Solarized Light",
  githubLight: "GitHub Light",
};

const rendererLabels: Record<GraphRendererKind, string> = {
  auto: "Auto (WebGPU when available)",
  webgpu: "WebGPU (high performance)",
  canvas2d: "Canvas 2D (compatibility)",
};

interface Props {
  onClose: () => void;
}

export function SettingsPanel({ onClose }: Props) {
  const { theme, fontSize, tabSize, lineNumbers, wordWrap, autoSave, graphRenderer, setTheme, setFontSize, setTabSize, setLineNumbers, setWordWrap, setAutoSave, setGraphRenderer } = useSettingsStore();

  return (
    <div className="h-full flex flex-col text-xs" style={{ background: "#252526" }}>
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700 bg-[#2d2d2d]">
        <span className="text-gray-200 font-medium">Settings</span>
        <button onClick={onClose} className="px-2 py-0.5 bg-[#3a3a3a] hover:bg-[#4a4a4a] text-gray-300 rounded cursor-pointer">×</button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
        <Section title="Editor">
          <Field label="Theme">
            <select value={theme} onChange={(e) => setTheme(e.target.value as EditorTheme)}
              className="w-full px-2 py-1 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded outline-none focus:border-[#007acc]">
              {(Object.keys(themeLabels) as EditorTheme[]).map((k) => (
                <option key={k} value={k}>{themeLabels[k]}</option>
              ))}
            </select>
          </Field>

          <Field label="Font Size">
            <input type="number" min={10} max={30} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}
              className="w-20 px-2 py-1 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded outline-none focus:border-[#007acc]" />
          </Field>

          <Field label="Tab Size">
            <select value={tabSize} onChange={(e) => setTabSize(Number(e.target.value))}
              className="px-2 py-1 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded outline-none focus:border-[#007acc]">
              {[2, 4, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>

          <Field label="Line Numbers">
            <input type="checkbox" checked={lineNumbers} onChange={(e) => setLineNumbers(e.target.checked)}
              className="accent-[#007acc]" />
          </Field>

          <Field label="Word Wrap">
            <input type="checkbox" checked={wordWrap} onChange={(e) => setWordWrap(e.target.checked)}
              className="accent-[#007acc]" />
          </Field>

          <Field label="Auto Save">
            <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)}
              className="accent-[#007acc]" />
          </Field>
        </Section>

        <Section title="Graph">
          <Field label="Renderer">
            <select value={graphRenderer} onChange={(e) => setGraphRenderer(e.target.value as GraphRendererKind)}
              className="px-2 py-1 bg-[#3a3a3a] text-gray-200 border border-gray-600 rounded outline-none focus:border-[#007acc]">
              {(Object.keys(rendererLabels) as GraphRendererKind[]).map((k) => (
                <option key={k} value={k}>{rendererLabels[k]}</option>
              ))}
            </select>
          </Field>
          <div className="text-[10px] text-gray-500 leading-relaxed">
            WebGPU 在 Chrome/Edge 113+ 和 Safari 17+ 可用，能在大项目（5000+ 节点）保持 60fps。
            不支持时自动降级到 Canvas 2D。
          </div>
        </Section>

        <Section title="Preview">
          <div className="p-2 rounded font-mono text-xs leading-5" style={{ background: "#1e1e1e" }}>
            <span style={{ color: "#c678dd" }}>import</span> <span style={{ color: "#e5c07b" }}>React</span> <span style={{ color: "#c678dd" }}>from</span> <span style={{ color: "#98c379" }}>"react"</span><br />
            <span style={{ color: "#61afef" }}>function</span> <span style={{ color: "#61afef" }}>App</span>() {"{"}<br />
            &nbsp;&nbsp;<span style={{ color: "#c678dd" }}>const</span> [count, setCount] = useState(0)<br />
            &nbsp;&nbsp;<span style={{ color: "#c678dd" }}>return</span> &lt;div&gt;{"{count}"}&lt;/div&gt;<br />
            {"}"}
          </div>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-gray-500 font-semibold mb-1 tracking-wider">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-gray-400 shrink-0">{label}</span>
      {children}
    </div>
  );
}
