import { SKINS } from "../skins";
import { useSettingsStore, type EditorTheme, type GraphRendererKind, type SkinId } from "../hooks/useSettingsStore";

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
  const { skin, theme, fontSize, tabSize, lineNumbers, wordWrap, autoSave, graphRenderer, docsInputDir, docsOutputDir, setSkin, setTheme, setFontSize, setTabSize, setLineNumbers, setWordWrap, setAutoSave, setGraphRenderer, setDocsInputDir, setDocsOutputDir } = useSettingsStore();

  return (
    <div className="h-full flex flex-col text-xs bg-surface-2">
      <div className="flex items-center justify-between px-3 py-2 border-b border-edge bg-surface-3">
        <span className="text-fg font-medium">Settings</span>
        <button onClick={onClose} className="px-2 py-0.5 bg-control hover:bg-control-hover text-fg-2 rounded cursor-pointer">×</button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
        <Section title="Appearance">
          <Field label="Skin">
            <select value={skin} onChange={(e) => setSkin(e.target.value as SkinId)}
              className="w-full px-2 py-1 bg-control text-fg border border-edge rounded outline-none focus:border-accent">
              {(Object.keys(SKINS) as SkinId[]).map((k) => (
                <option key={k} value={k}>{SKINS[k].label}</option>
              ))}
            </select>
          </Field>
          <div className="text-[10px] text-fg-3 leading-relaxed">
            换肤会联动切换代码主题为皮肤搭配的主题（仍可单独再改），嵌入的 chat 面板同步跟随。
          </div>
        </Section>

        <Section title="Editor">
          <Field label="Theme">
            <select value={theme} onChange={(e) => setTheme(e.target.value as EditorTheme)}
              className="w-full px-2 py-1 bg-control text-fg border border-edge rounded outline-none focus:border-accent">
              {(Object.keys(themeLabels) as EditorTheme[]).map((k) => (
                <option key={k} value={k}>{themeLabels[k]}</option>
              ))}
            </select>
          </Field>

          <Field label="Font Size">
            <input type="number" min={10} max={30} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))}
              className="w-20 px-2 py-1 bg-control text-fg border border-edge rounded outline-none focus:border-accent" />
          </Field>

          <Field label="Tab Size">
            <select value={tabSize} onChange={(e) => setTabSize(Number(e.target.value))}
              className="px-2 py-1 bg-control text-fg border border-edge rounded outline-none focus:border-accent">
              {[2, 4, 8].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>

          <Field label="Line Numbers">
            <input type="checkbox" checked={lineNumbers} onChange={(e) => setLineNumbers(e.target.checked)}
              className="accent-accent" />
          </Field>

          <Field label="Word Wrap">
            <input type="checkbox" checked={wordWrap} onChange={(e) => setWordWrap(e.target.checked)}
              className="accent-accent" />
          </Field>

          <Field label="Auto Save">
            <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)}
              className="accent-accent" />
          </Field>
        </Section>

        <Section title="Graph">
          <Field label="Renderer">
            <select value={graphRenderer} onChange={(e) => setGraphRenderer(e.target.value as GraphRendererKind)}
              className="px-2 py-1 bg-control text-fg border border-edge rounded outline-none focus:border-accent">
              {(Object.keys(rendererLabels) as GraphRendererKind[]).map((k) => (
                <option key={k} value={k}>{rendererLabels[k]}</option>
              ))}
            </select>
          </Field>
          <div className="text-[10px] text-fg-3 leading-relaxed">
            WebGPU 在 Chrome/Edge 113+ 和 Safari 17+ 可用，能在大项目（5000+ 节点）保持 60fps。
            不支持时自动降级到 Canvas 2D。
          </div>
        </Section>

        <Section title="Docs">
          <Field label="Input Dir">
            <input type="text" value={docsInputDir} onChange={(e) => setDocsInputDir(e.target.value)}
              className="w-full px-2 py-1 bg-control text-fg border border-edge rounded outline-none focus:border-accent font-mono" />
          </Field>
          <Field label="Output Dir">
            <input type="text" value={docsOutputDir} onChange={(e) => setDocsOutputDir(e.target.value)}
              className="w-full px-2 py-1 bg-control text-fg border border-edge rounded outline-none focus:border-accent font-mono" />
          </Field>
          <div className="text-[10px] text-fg-3 leading-relaxed">
            Document .md files are read from Input Dir and analysis output goes to Output Dir.
            Paths are relative to the project root.
          </div>
        </Section>

        <Section title="Preview">
          <div className="p-2 rounded font-mono text-xs leading-5 bg-surface">
            <span className="text-accent-2">import</span> <span className="text-warn">React</span> <span className="text-accent-2">from</span> <span className="text-ok">"react"</span><br />
            <span className="text-accent-2">function</span> <span className="text-accent-2">App</span>() {"{"}<br />
            &nbsp;&nbsp;<span className="text-accent-2">const</span> [count, setCount] = useState(0)<br />
            &nbsp;&nbsp;<span className="text-accent-2">return</span> &lt;div&gt;{"{count}"}&lt;/div&gt;<br />
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
      <div className="text-[10px] uppercase text-fg-3 font-semibold mb-1 tracking-wider">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-fg-2 shrink-0">{label}</span>
      {children}
    </div>
  );
}
