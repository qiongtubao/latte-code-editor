import { useCallback, useRef } from "react";

interface Props {
  size: number;
  onResize: (newSize: number) => void;
  minSize?: number;
  maxSize?: number;
  direction?: "horizontal" | "vertical";
  /** 右侧面板用：拖拽方向与尺寸增减取反（向左拖变宽）。 */
  invert?: boolean;
}

export function ResizeDivider({ size, onResize, minSize = 50, maxSize = 800, direction = "horizontal", invert = false }: Props) {
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startSize = useRef(0);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const delta = (direction === "horizontal" ? e.clientX : e.clientY) - startPos.current;
    onResize(Math.max(minSize, Math.min(maxSize, startSize.current + (invert ? -delta : delta))));
  }, [onResize, minSize, maxSize, direction, invert]);

  const handleMouseUp = useCallback(() => {
    if (dragging.current) {
      dragging.current = false;
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    }
  }, [handleMouseMove]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startPos.current = direction === "horizontal" ? e.clientX : e.clientY;
    startSize.current = size;
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }, [size, direction, handleMouseMove, handleMouseUp]);

  return (
    <div
      onMouseDown={handleMouseDown}
      className={`flex-shrink-0 z-10 transition-colors bg-edge hover:bg-accent ${direction === "horizontal" ? "w-[3px] cursor-col-resize" : "h-[3px] cursor-row-resize"}`}
    />
  );
}
