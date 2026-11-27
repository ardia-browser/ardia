import { useEffect, useMemo, useRef, useState } from "react";
import { loadFrimousseData, searchEmojis, type FrimousseEmojiData } from "@blocknote/core/emoji-data";
import { Icon } from "./icons";

let cache: Promise<FrimousseEmojiData> | null = null;
const loadData = () => (cache ??= loadFrimousseData("en"));

const RECENT_KEY = "notes:recentEmoji";

function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function remember(emoji: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...recent().filter((e) => e !== emoji)].slice(0, 24)));
  } catch {}
}

export function EmojiPicker({ onPick, onRemove, onUpload, title = "Emoji" }: { onPick: (emoji: string) => void; onRemove?: () => void; onUpload?: (file: File) => void; title?: string }) {
  const [data, setData] = useState<FrimousseEmojiData | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"emoji" | "upload">("emoji");
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void loadData().then((d) => live && setData(d));
    return () => {
      live = false;
    };
  }, []);
  const pick = (emoji: string) => {
    remember(emoji);
    onPick(emoji);
  };
  const groups = useMemo(() => {
    if (!data) return [];
    if (query.trim()) return [{ label: "Results", emojis: searchEmojis(data.emojis, query).slice(0, 240).map((e) => ({ emoji: e.emoji, label: e.label })) }];
    const out: { label: string; emojis: { emoji: string; label: string }[] }[] = [];
    const rec = recent();
    if (rec.length) out.push({ label: "Recent", emojis: rec.map((e) => ({ emoji: e, label: e })) });
    for (const category of data.categories) {
      out.push({ label: category.label, emojis: data.emojis.filter((e) => e.category === category.index && !e.countryFlag).map((e) => ({ emoji: e.emoji, label: e.label })) });
    }
    return out;
  }, [data, query]);
  const random = () => {
    if (!data) return;
    const pool = data.emojis.filter((e) => !e.countryFlag);
    const choice = pool[Math.floor(Math.random() * pool.length)];
    if (choice) pick(choice.emoji);
  };
  return (
    <div className="n-emoji-picker" data-testid="emoji-picker">
      <div className="n-emoji-tabs">
        <button type="button" className={tab === "emoji" ? "is-on" : ""} onClick={() => setTab("emoji")}>
          {title}
        </button>
        {onUpload ? (
          <button type="button" className={tab === "upload" ? "is-on" : ""} onClick={() => setTab("upload")}>
            Upload
          </button>
        ) : null}
        <span className="n-spacer" />
        {onRemove ? (
          <button type="button" className="n-emoji-remove" onClick={onRemove}>
            Remove
          </button>
        ) : null}
      </div>
      {tab === "emoji" ? (
        <>
          <div className="n-emoji-search">
            <div className="n-field">
              <Icon name="search" size={14} />
              <input autoFocus placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter emoji" />
            </div>
            <button type="button" className="n-icon-button" title="Random" aria-label="Random" onClick={random}>
              <Icon name="shuffle" />
            </button>
          </div>
          <div className="n-emoji-grid-scroll">
            {!data ? <div className="n-emoji-loading">Loading…</div> : null}
            {groups.map((group) =>
              group.emojis.length ? (
                <div key={group.label} className="n-emoji-group">
                  <div className="n-emoji-group-label">{group.label}</div>
                  <div className="n-emoji-grid">
                    {group.emojis.map((e, i) => (
                      <button key={`${e.emoji}${i}`} type="button" className="n-emoji-cell" title={e.label} onClick={() => pick(e.emoji)}>
                        {e.emoji}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null,
            )}
            {data && query && !groups[0]?.emojis.length ? <div className="n-emoji-loading">No emoji found</div> : null}
          </div>
        </>
      ) : (
        <div className="n-emoji-upload">
          <button type="button" className="n-button" onClick={() => fileRef.current?.click()}>
            Upload an image
          </button>
          <div className="n-muted">Recommended size is 280 × 280 pixels</div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload?.(file);
            }}
          />
        </div>
      )}
    </div>
  );
}

export async function randomEmoji(): Promise<string> {
  const data = await loadData();
  const pool = data.emojis.filter((e) => !e.countryFlag && e.category !== 2);
  return pool[Math.floor(Math.random() * pool.length)]?.emoji ?? "📄";
}
