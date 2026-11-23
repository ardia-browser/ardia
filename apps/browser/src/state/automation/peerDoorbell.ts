import { answerControlPeer, onControlPeerAsk, onControlPeerAskEnded, type ControlPeerAnswer, type ControlPeerAsk, type ControlPeerOutcome } from "../../platform/automation";
import { choose, dismissShownOnlyDialogs, type ChooseOptions } from "../../platform/dialogs";
import { noteDoorbellOutcome, noteDoorbellShown, type DoorbellOutcome } from "../telemetry/cliCounts";
import { refreshControlApprovals } from "./controlApprovals";
import { shownWindowId } from "./socketAsk";

export const DOORBELL_CHOICES: Record<"remember" | "once", readonly (readonly [string, ControlPeerAnswer])[]> = {
  remember: [
    ["Allow Once", "once"],
    ["Allow for 30 Minutes", "halfHour"],
    ["Always Allow", "always"],
    ["Don't Allow", "deny"],
  ],
  once: [
    ["Allow Once", "once"],
    ["Don't Allow", "deny"],
  ],
};

const choicesFor = (ask: ControlPeerAsk) => DOORBELL_CHOICES[ask.remember ? "remember" : "once"];

const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

export function plainText(text: string, limit: number): string {
  const kept = [...text.replace(CONTROLS, "")];
  return kept.length > limit ? `${kept.slice(0, limit - 1).join("")}…` : kept.join("");
}

export function doorbellOptions(ask: ControlPeerAsk): Omit<ChooseOptions, "windowId" | "dismissKey"> {
  const choices = choicesFor(ask);
  const who = [`“${plainText(ask.name, 64)}”: ${plainText(ask.signedBy, 120)}`, plainText(ask.path, 300)].filter(Boolean).join("\n");
  const lines = [who, "It could open, read and change your tabs and pages, with your logins, as the ardia command can."];
  if (!ask.remember) lines.push("Ardia can't recognize this program next time, so it can only be allowed once.");
  return {
    title: "A program wants to control Ardia",
    message: lines.join("\n\n"),
    choices: choices.map(([title]) => title),
    cancelChoice: choices.length - 1,
    noDefault: true,
    onlyIfShown: true,
  };
}

export function answerFor(ask: ControlPeerAsk, result: { choice: number; unshown?: boolean }): ControlPeerAnswer | null {
  if (result.unshown) return "unshown";
  return choicesFor(ask)[result.choice]?.[1] ?? null;
}

const OUTCOME_FIELDS: Partial<Record<ControlPeerOutcome, DoorbellOutcome>> = {
  once: "once",
  halfHour: "half_hour",
  always: "always",
  deny: "deny",
  unshown: "unshown",
  timeout: "timeout",
  left: "left",
  stopped: "stopped",
  unsaved: "unsaved",
};

type DoorbellDeps = {
  choose: (options: ChooseOptions) => Promise<{ choice: number; unshown?: boolean }>;
  answer: (ask: number, outcome: ControlPeerAnswer) => Promise<boolean>;
  dismiss: (key: string) => Promise<void>;
  windowId: () => string | undefined;
  now: () => number;
  shown: () => void;
  ended: (outcome: ControlPeerOutcome) => void;
};

export function createDoorbell(deps: DoorbellDeps) {
  const queued: ControlPeerAsk[] = [];
  let showing: { ask: ControlPeerAsk; key: string } | null = null;
  const ended = new Set<number>();

  const pump = () => {
    while (!showing && queued.length) {
      const ask = queued.shift()!;
      if (ask.deadline <= deps.now()) continue;
      const current = { ask, key: `peer-doorbell-${ask.ask}` };
      showing = current;
      void deps
        .choose({ ...doorbellOptions(ask), windowId: deps.windowId(), dismissKey: current.key })
        .catch(() => ({ choice: -1 }))
        .then(async (result) => {
          if (!("unshown" in result && result.unshown)) deps.shown();
          const outcome = ended.has(ask.ask) ? null : answerFor(ask, result);
          if (outcome) await deps.answer(ask.ask, outcome).catch(() => false);
        })
        .finally(() => {
          ended.delete(ask.ask);
          if (showing === current) showing = null;
          pump();
        });
    }
  };

  return {
    asked(ask: ControlPeerAsk) {
      queued.push(ask);
      pump();
    },
    ended(ask: number, outcome: ControlPeerOutcome) {
      deps.ended(outcome);
      const waiting = queued.findIndex((q) => q.ask === ask);
      if (waiting >= 0) return void queued.splice(waiting, 1);
      if (showing?.ask.ask === ask) {
        ended.add(ask);
        void deps.dismiss(showing.key).catch(() => {});
      }
    },
    get showing() {
      return showing?.ask.ask ?? null;
    },
    get queued() {
      return queued.map((q) => q.ask);
    },
  };
}

let started = false;

export function startPeerDoorbell() {
  if (started) return;
  started = true;
  const doorbell = createDoorbell({
    choose,
    answer: answerControlPeer,
    dismiss: (key) => dismissShownOnlyDialogs(key),
    windowId: shownWindowId,
    now: Date.now,
    shown: () => noteDoorbellShown(),
    ended: (outcome) => {
      const field = OUTCOME_FIELDS[outcome];
      if (field) noteDoorbellOutcome(field);
      if (outcome === "halfHour" || outcome === "always") void refreshControlApprovals();
    },
  });
  onControlPeerAsk((ask) => doorbell.asked(ask));
  onControlPeerAskEnded(({ ask, outcome }) => doorbell.ended(ask, outcome));
}
