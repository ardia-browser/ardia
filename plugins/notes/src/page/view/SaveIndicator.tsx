import { useEffect, useRef, useState } from "react";
import type { NotesClient } from "../client/types";
import { Icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { decideSave, markRefusalsSeen, refusalsSeen, type SaveShown, type SaveStateLike } from "./saveDecision";

type Shown = SaveShown;

const LABEL: Record<Exclude<Shown, "none">, string> = { saving: "Saving…", saved: "Saved", unsaved: "Couldn’t save — retrying", blocked: "Can’t save — copy your changes" };

const TITLE: Record<Exclude<Shown, "none">, string | undefined> = {
  saving: "Your latest edits are kept on this Mac until Notes has saved them.",
  saved: undefined,
  unsaved: "Some edits aren’t saved yet and couldn’t be kept on this Mac either. Notes keeps trying to save them; keep this page open until it says Saved.",
  blocked: "Notes can’t save or keep any more edits right now. Copy what you just wrote somewhere safe; Notes keeps trying.",
};

export function SaveIndicator({ client }: { client: NotesClient }) {
  const [shown, setShown] = useState<Shown>("none");
  const [label, setLabel] = useState<Exclude<Shown, "none">>("saved");
  const slow = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visible = useRef<Shown>("none");

  useEffect(() => {
    if (!client.saveState || !client.onSaveState) return;
    const show = (next: Shown) => {
      visible.current = next;
      setShown(next);
      if (next !== "none") setLabel(next);
    };
    const clear = () => {
      if (slow.current) clearTimeout(slow.current);
      if (fade.current) clearTimeout(fade.current);
      slow.current = null;
      fade.current = null;
    };
    const apply = (state: SaveStateLike) => {
      const step = decideSave(visible.current, !!slow.current, refusalsSeen(client), state);
      if (step.toastRefused) toast("Some changes couldn’t be saved because the page was deleted");
      markRefusalsSeen(client, state.refused);
      if (step.show === "keep") return;
      if (step.show === "saving-later") {
        if (fade.current) {
          clearTimeout(fade.current);
          fade.current = null;
          show("none");
        }
        slow.current = setTimeout(() => {
          slow.current = null;
          show("saving");
        }, 1000);
        return;
      }
      clear();
      show(step.show);
      if (step.fadeAfterSaved) {
        fade.current = setTimeout(() => {
          fade.current = null;
          show("none");
        }, 1400);
      }
    };
    apply(client.saveState());
    const off = client.onSaveState(apply);
    return () => {
      off();
      clear();
    };
  }, [client]);

  return (
    <span
      className={`n-save is-${label}${shown === "none" ? "" : " is-on"}`}
      data-testid="save-indicator"
      data-state={shown}
      role="status"
      aria-live="polite"
      title={TITLE[label]}
    >
      {label === "unsaved" || label === "blocked" ? <Icon name="restore" size={12} /> : null}
      {LABEL[label]}
    </span>
  );
}
