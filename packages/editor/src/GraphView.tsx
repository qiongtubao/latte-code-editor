// TEMPORARY STUB: This will be replaced entirely by Task 15 (GraphView).
// RightPanel (T14) imports this component to wire the Outline/Graph tab
// switch, so a placeholder is provided here to keep T14's tests green.
// T15 owns the real design (force layout, IPC, node rendering, etc.).

export function GraphView({ center }: { center: string }) {
  return <div data-testid="graph-placeholder">graph (T15){center ? ` — ${center}` : ""}</div>;
}
