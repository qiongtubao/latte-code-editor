// Quick Open 全局模态状态
//
// 设计：
// - 任何组件可以调 open()/close() 控制可见性
// - query / results / selectedIndex 都存在 zustand 里，方便异步加载期间 UI 仍响应
// - 不持有网络请求句柄：findFiles 由调用方触发，结果存进 store
import { create } from "zustand";
import type { FileMatch } from "../api/workspace";

interface QuickOpenStore {
  open: boolean;
  query: string;
  results: FileMatch[];
  loading: boolean;
  /** 键盘高亮的索引（Enter 跳到这一项） */
  selectedIndex: number;

  openModal: () => void;
  closeModal: () => void;
  setQuery: (q: string) => void;
  setResults: (results: FileMatch[]) => void;
  setLoading: (loading: boolean) => void;
  selectNext: () => void;
  selectPrev: () => void;
  reset: () => void;
}

const initial = {
  open: false,
  query: "",
  results: [] as FileMatch[],
  loading: false,
  selectedIndex: 0,
};

export const useQuickOpenStore = create<QuickOpenStore>((set) => ({
  ...initial,
  openModal: () => set({ ...initial, open: true }),
  closeModal: () => set({ ...initial, open: false }),
  setQuery: (q) => set({ query: q, selectedIndex: 0, results: [] }),
  setResults: (results) =>
    set({ results, selectedIndex: 0, loading: false }),
  setLoading: (loading) => set({ loading }),
  selectNext: () =>
    set((s) => ({
      selectedIndex: Math.min(s.selectedIndex + 1, Math.max(0, s.results.length - 1)),
    })),
  selectPrev: () => set((s) => ({ selectedIndex: Math.max(0, s.selectedIndex - 1) })),
  reset: () => set({ ...initial }),
}));
