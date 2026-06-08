// useQuickOpenStore 单测
import { describe, it, expect, beforeEach } from "vitest";
import { useQuickOpenStore } from "./useQuickOpenStore";
import type { FileMatch } from "../api/workspace";

const sample = (path: string, score: number): FileMatch => ({ path, score });

describe("useQuickOpenStore", () => {
  beforeEach(() => {
    useQuickOpenStore.getState().reset();
  });

  it("reset puts store back to initial closed state", () => {
    useQuickOpenStore.setState({ open: true, query: "x", selectedIndex: 3 });
    useQuickOpenStore.getState().reset();
    const s = useQuickOpenStore.getState();
    expect(s.open).toBe(false);
    expect(s.query).toBe("");
    expect(s.results).toEqual([]);
    expect(s.selectedIndex).toBe(0);
  });

  it("openModal sets open=true and resets state", () => {
    useQuickOpenStore.setState({ query: "leftover", results: [sample("a", 1)] });
    useQuickOpenStore.getState().openModal();
    const s = useQuickOpenStore.getState();
    expect(s.open).toBe(true);
    expect(s.query).toBe("");
    expect(s.results).toEqual([]);
  });

  it("closeModal resets everything including query and results", () => {
    useQuickOpenStore.setState({
      open: true,
      query: "foo",
      results: [sample("foo.ts", 30)],
      selectedIndex: 1,
    });
    useQuickOpenStore.getState().closeModal();
    const s = useQuickOpenStore.getState();
    expect(s.open).toBe(false);
    expect(s.query).toBe("");
    expect(s.results).toEqual([]);
  });

  it("setQuery updates query and clears results + selectedIndex", () => {
    useQuickOpenStore.setState({
      query: "a",
      results: [sample("a.ts", 5)],
      selectedIndex: 0,
    });
    useQuickOpenStore.getState().setQuery("ab");
    const s = useQuickOpenStore.getState();
    expect(s.query).toBe("ab");
    expect(s.results).toEqual([]);
  });

  it("setResults replaces results and resets selectedIndex to 0", () => {
    useQuickOpenStore.setState({ selectedIndex: 5 });
    useQuickOpenStore.getState().setResults([
      sample("a.ts", 10),
      sample("b.ts", 5),
    ]);
    const s = useQuickOpenStore.getState();
    expect(s.results).toHaveLength(2);
    expect(s.selectedIndex).toBe(0);
    expect(s.loading).toBe(false);
  });

  it("selectNext advances index, clamped to last item", () => {
    useQuickOpenStore.setState({
      results: [sample("a", 1), sample("b", 2), sample("c", 3)],
      selectedIndex: 0,
    });
    useQuickOpenStore.getState().selectNext();
    expect(useQuickOpenStore.getState().selectedIndex).toBe(1);
    useQuickOpenStore.getState().selectNext();
    useQuickOpenStore.getState().selectNext();
    // 已到末尾
    expect(useQuickOpenStore.getState().selectedIndex).toBe(2);
    useQuickOpenStore.getState().selectNext();
    // 仍然在末尾
    expect(useQuickOpenStore.getState().selectedIndex).toBe(2);
  });

  it("selectPrev moves backward, clamped to 0", () => {
    useQuickOpenStore.setState({
      results: [sample("a", 1), sample("b", 2)],
      selectedIndex: 1,
    });
    useQuickOpenStore.getState().selectPrev();
    expect(useQuickOpenStore.getState().selectedIndex).toBe(0);
    useQuickOpenStore.getState().selectPrev();
    expect(useQuickOpenStore.getState().selectedIndex).toBe(0);
  });

  it("selectNext on empty results stays at 0", () => {
    useQuickOpenStore.setState({ results: [], selectedIndex: 0 });
    useQuickOpenStore.getState().selectNext();
    expect(useQuickOpenStore.getState().selectedIndex).toBe(0);
  });

  it("setLoading toggles loading flag", () => {
    useQuickOpenStore.getState().setLoading(true);
    expect(useQuickOpenStore.getState().loading).toBe(true);
    useQuickOpenStore.getState().setLoading(false);
    expect(useQuickOpenStore.getState().loading).toBe(false);
  });
});
