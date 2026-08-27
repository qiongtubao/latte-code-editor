/**
 * 批量替换确认闸门的回归测试。
 *
 * 修复前 "Replace All" 直接调用 onReplace，全项目范围写盘、无确认无撤销
 * （对比之下删单个文件反而有 window.confirm）。核心不变量：
 * **用户没点「确认替换」，onReplace 一次都不能被调用。**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { WorkspaceSearch } from "./WorkspaceSearch";
import type { SearchMatch } from "../api/commands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const match = (file: string, line: number): SearchMatch => ({
  file_path: file,
  line_number: line,
  line_content: `hit at ${line}`,
});

/** 3 处匹配散落在 2 个文件里 */
const matches: SearchMatch[] = [
  match("/proj/a.ts", 1),
  match("/proj/a.ts", 9),
  match("/proj/b.ts", 4),
];

/** 展开 replace 区、填入检索词与替换词 */
function setup(
  onReplace = vi.fn().mockResolvedValue({ replaced: [], failed: [] }),
) {
  const onSearch = vi.fn().mockResolvedValue(matches);
  render(<WorkspaceSearch onSearch={onSearch} onReplace={onReplace} />);
  fireEvent.click(screen.getByTitle("Toggle replace"));
  fireEvent.change(screen.getByPlaceholderText("Search"), {
    target: { value: "needle" },
  });
  fireEvent.change(screen.getByPlaceholderText("Replace"), {
    target: { value: "thread" },
  });
  return { onSearch, onReplace };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("批量替换确认闸门", () => {
  it("点 Replace All 只做 dry-run 预览，不写盘", async () => {
    const { onSearch, onReplace } = setup();
    fireEvent.click(screen.getByTestId("replace-all"));

    await waitFor(() => expect(screen.getByTestId("replace-confirm")).toBeTruthy());
    // dry-run 走的是搜索，替换一次都没发生
    expect(onSearch).toHaveBeenCalledWith("needle", undefined, undefined);
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("确认面板展示准确的影响范围（3 处匹配 / 2 个文件）", async () => {
    setup();
    fireEvent.click(screen.getByTestId("replace-all"));

    const panel = await waitFor(() => screen.getByTestId("replace-confirm"));
    expect(panel.textContent).toContain("2");
    expect(panel.textContent).toContain("3");
    expect(panel.textContent).toContain("无法撤销");
  });

  it("确认后才真正调用 onReplace", async () => {
    const { onReplace } = setup();
    fireEvent.click(screen.getByTestId("replace-all"));
    await waitFor(() => screen.getByTestId("replace-confirm"));

    fireEvent.click(screen.getByTestId("replace-confirm-ok"));
    await waitFor(() =>
      expect(onReplace).toHaveBeenCalledWith("needle", "thread", undefined, undefined),
    );
    expect(onReplace).toHaveBeenCalledTimes(1);
  });

  it("取消则不写盘，且确认面板消失", async () => {
    const { onReplace } = setup();
    fireEvent.click(screen.getByTestId("replace-all"));
    await waitFor(() => screen.getByTestId("replace-confirm"));

    fireEvent.click(screen.getByTestId("replace-confirm-cancel"));
    await waitFor(() => expect(screen.queryByTestId("replace-confirm")).toBeNull());
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("改动检索词会撤回待确认状态，避免对着过期范围确认", async () => {
    const { onReplace } = setup();
    fireEvent.click(screen.getByTestId("replace-all"));
    await waitFor(() => screen.getByTestId("replace-confirm"));

    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "other" },
    });
    await waitFor(() => expect(screen.queryByTestId("replace-confirm")).toBeNull());
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("改动替换词同样撤回待确认状态", async () => {
    const { onReplace } = setup();
    fireEvent.click(screen.getByTestId("replace-all"));
    await waitFor(() => screen.getByTestId("replace-confirm"));

    fireEvent.change(screen.getByPlaceholderText("Replace"), {
      target: { value: "changed" },
    });
    await waitFor(() => expect(screen.queryByTestId("replace-confirm")).toBeNull());
    expect(onReplace).not.toHaveBeenCalled();
  });

  it("空替换词提示会删除匹配内容", async () => {
    const onSearch = vi.fn().mockResolvedValue(matches);
    render(<WorkspaceSearch onSearch={onSearch} onReplace={vi.fn()} />);
    fireEvent.click(screen.getByTitle("Toggle replace"));
    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "needle" },
    });
    // 替换词留空
    fireEvent.click(screen.getByTestId("replace-all"));

    const panel = await waitFor(() => screen.getByTestId("replace-confirm"));
    expect(panel.textContent).toContain("将删除匹配内容");
  });

  it("无匹配时不弹确认面板", async () => {
    const onSearch = vi.fn().mockResolvedValue([]);
    const onReplace = vi.fn();
    render(<WorkspaceSearch onSearch={onSearch} onReplace={onReplace} />);
    fireEvent.click(screen.getByTitle("Toggle replace"));
    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "nothing" },
    });
    fireEvent.click(screen.getByTestId("replace-all"));

    await waitFor(() => expect(onSearch).toHaveBeenCalled());
    expect(screen.queryByTestId("replace-confirm")).toBeNull();
    expect(onReplace).not.toHaveBeenCalled();
  });
});

describe("批量替换结果回报", () => {
  /** 走完 dry-run + 确认两步 */
  async function runReplace(onReplace: Parameters<typeof setup>[0]) {
    setup(onReplace);
    fireEvent.click(screen.getByTestId("replace-all"));
    await waitFor(() => screen.getByTestId("replace-confirm"));
    fireEvent.click(screen.getByTestId("replace-confirm-ok"));
  }

  it("全部成功时报告替换的文件数与处数", async () => {
    await runReplace(
      vi.fn().mockResolvedValue({
        replaced: [
          { file_path: "a.ts", count: 2 },
          { file_path: "b.ts", count: 1 },
        ],
        failed: [],
      }),
    );
    const report = await waitFor(() => screen.getByTestId("replace-report"));
    expect(report.getAttribute("data-kind")).toBe("ok");
    expect(report.textContent).toContain("2 个文件");
    expect(report.textContent).toContain("3 处");
  });

  it("部分文件写入失败时列出文件与原因", async () => {
    // 后端此前会把失败文件静默丢弃，用户以为全部成功、工作区实际半改
    await runReplace(
      vi.fn().mockResolvedValue({
        replaced: [{ file_path: "ok.ts", count: 1 }],
        failed: [{ file_path: "readonly.ts", error: "Permission denied" }],
      }),
    );
    const report = await waitFor(() => screen.getByTestId("replace-report"));
    expect(report.getAttribute("data-kind")).toBe("partial");
    expect(report.textContent).toContain("readonly.ts");
    expect(report.textContent).toContain("Permission denied");
  });

  it("整体失败时不再静默吞掉错误", async () => {
    // 修复前是 catch { /* ignore */ }：面板一关、loading 一停，
    // 用户会以为替换成功了
    await runReplace(vi.fn().mockRejectedValue(new Error("workspace not found")));
    const report = await waitFor(() => screen.getByTestId("replace-report"));
    expect(report.getAttribute("data-kind")).toBe("error");
    expect(report.textContent).toContain("workspace not found");
  });

  it("改动检索条件会清掉上一次的结果回报", async () => {
    await runReplace(
      vi.fn().mockResolvedValue({
        replaced: [{ file_path: "a.ts", count: 1 }],
        failed: [],
      }),
    );
    await waitFor(() => screen.getByTestId("replace-report"));
    fireEvent.change(screen.getByPlaceholderText("Search"), {
      target: { value: "changed" },
    });
    await waitFor(() => expect(screen.queryByTestId("replace-report")).toBeNull());
  });
});
