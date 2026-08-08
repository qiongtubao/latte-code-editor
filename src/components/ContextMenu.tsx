import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Delay to avoid the same right-click closing immediately
    setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  // Constrain to viewport
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 32 - 10),
    zIndex: 2000,
    minWidth: "160px",
    background: "var(--surface-3)",
    border: "1px solid #454545",
    borderRadius: "6px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    padding: "4px 0",
    fontSize: "12px",
  };

  return (
    <div ref={ref} style={style}>
      {items.map((item, i) => {
        if (item.separator) {
          return (
            <div key={i} className="border-t border-edge my-1" />
          );
        }
        return (
          <div
            key={i}
            onClick={() => {
              if (!item.disabled) {
                item.onClick();
                onClose();
              }
            }}
            className={`flex items-center justify-between px-3 py-1.5 cursor-pointer select-none ${
              item.disabled
                ? "text-fg-3 cursor-default"
                : "text-fg hover:bg-info"
            }`}
          >
            <span>{item.label}</span>
            {item.shortcut && (
              <span className="text-fg-3 text-2xs ml-4">{item.shortcut}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
