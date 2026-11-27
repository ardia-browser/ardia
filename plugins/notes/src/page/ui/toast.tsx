import { useEffect, useRef, useState } from "react";
import { exitRef, useFlip } from "./motion";

type ToastItem = { id: number; text: string; action?: { label: string; run: () => void } };
const listeners = new Set<(items: ToastItem[]) => void>();
let items: ToastItem[] = [];
let next = 1;

export function toast(text: string, action?: ToastItem["action"]) {
  const item = { id: next++, text, action };
  items = [...items.slice(-2), item];
  listeners.forEach((l) => l(items));
  setTimeout(() => {
    items = items.filter((i) => i.id !== item.id);
    listeners.forEach((l) => l(items));
  }, 3200);
}

export function Toasts() {
  const [shown, setShown] = useState(items);
  const box = useRef<HTMLDivElement>(null);
  useFlip(box, ".n-toast", "data-toast-id", [shown]);
  useEffect(() => {
    listeners.add(setShown);
    return () => {
      listeners.delete(setShown);
    };
  }, []);
  return (
    <div className="n-toasts" aria-live="polite" ref={box}>
      {shown.map((t) => (
        <div key={t.id} className="n-toast" role="status" data-toast-id={t.id} ref={exitRef<HTMLDivElement>("is-fading")}>
          <span>{t.text}</span>
          {t.action ? (
            <button
              type="button"
              onClick={() => {
                t.action?.run();
                items = items.filter((i) => i.id !== t.id);
                listeners.forEach((l) => l(items));
              }}
            >
              {t.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
