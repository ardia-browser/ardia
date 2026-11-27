import { CRUMB_X, FIELD, type Geo, type Rect, STRIP_H } from "../geometry";
import type { Look } from "../look";
import { tracker } from "../timeline";
import { Caret, Label } from "../Kit";
import { InputRow, Panel } from "../Floating";
import { sceneMs } from "../tokens";
import { radius, space } from "../../../ui/tokens";
import { BAR_TYPE, SUGGESTION } from "../../../omnibox/tokens";
import type { Scene, SceneOpts } from "../scene";
import { cardOf, centredFrame, CURRENT, Divider, dropTrip, FRESH, growTrip, KeyPress, PANEL_H, Rest, SelectedUrl, SuggestionList, tabCount, tabsSlot } from "./SceneParts";
import { FadingCrumb, InsertedList, NewTabArrives } from "./ListMotion";
import { keyText } from "../../../../state/commands/keyText";

const OPEN = 380;
const CLOSE = 1900;

function fieldPanel(g: Geo, opts: SceneOpts): { from: Rect; to: Rect } {
  if (opts.addressInSidebar) return { from: FIELD, to: { x: FIELD.x, y: FIELD.y, w: FIELD.w + 137, h: 40 + 3 * SUGGESTION.height + 14 } };
  const c = cardOf(g, opts);
  const crumbX = opts.top ? 118 : CRUMB_X;
  const top = opts.top ? STRIP_H : c.y;
  return {
    from: { x: c.x + crumbX - 8, y: top + 6, w: 300, h: 30 },
    to: { x: c.x + crumbX - 40, y: top + 0.5, w: Math.min(480, c.w - crumbX + 28), h: PANEL_H },
  };
}

export const CmdlField: Scene = ({ g, look, p, opts }) => {
  const t = tracker(p, sceneMs.commandBar);
  const { from, to } = fieldPanel(g, opts);
  const field = opts.addressInSidebar;
  return (
    <Rest
      g={g}
      look={look}
      opts={opts}
      over={
        <>
          <Panel g={g} look={look} rect={to} radius={field ? radius.panel : undefined} style={growTrip(t, g, from, to, OPEN, CLOSE)}>
            <InputRow g={g} look={look} height={field ? 40 : undefined}>
              <SelectedUrl g={g} look={look} />
            </InputRow>
            <Divider g={g} look={look} />
            <SuggestionList g={g} look={look} t={t} rows={CURRENT} ms={OPEN + 160} />
          </Panel>
          <KeyPress g={g} t={t} label={keyText("⌘L")} ms={OPEN - 240} back={CLOSE} />
        </>
      }
    />
  );
};

export const CmdlCentred: Scene = ({ g, look, p, opts }) => {
  const t = tracker(p, sceneMs.commandBar);
  return (
    <Rest
      g={g}
      look={look}
      opts={opts}
      over={
        <>
          <Panel g={g} look={look} rect={centredFrame(g, opts)} style={dropTrip(t, g, OPEN, CLOSE)}>
            <InputRow g={g} look={look}>
              <SelectedUrl g={g} look={look} />
            </InputRow>
            <Divider g={g} look={look} />
            <SuggestionList g={g} look={look} t={t} rows={CURRENT} ms={OPEN + 160} />
          </Panel>
          <KeyPress g={g} t={t} label={keyText("⌘L")} ms={OPEN - 240} back={CLOSE} />
        </>
      }
    />
  );
};

export const NewTabOpensPage: Scene = ({ g, look, p, opts }) => {
  const t = tracker(p, sceneMs.newTab);
  return (
    <Rest
      g={g}
      look={look}
      opts={opts}
      {...tabsSlot(opts, <InsertedList g={g} look={look} opts={opts} t={t} at={endSlot(g, opts)} ms={OPEN} back={CLOSE} />)}
      crumb={<FadingCrumb g={g} look={look} t={t} ms={OPEN + 100} back={CLOSE} />}
      page={<NewTabArrives g={g} look={look} opts={opts} t={t} ms={OPEN + 160} back={CLOSE} />}
      over={<KeyPress g={g} t={t} label={keyText("⌘T")} ms={OPEN - 240} back={CLOSE} />}
    />
  );
};

export const NewTabOpensBar: Scene = ({ g, look, p, opts }) => {
  const t = tracker(p, sceneMs.newTab);
  return (
    <Rest
      g={g}
      look={look}
      opts={opts}
      over={
        <>
          <Panel g={g} look={look} rect={centredFrame(g, opts)} style={dropTrip(t, g, OPEN, CLOSE)}>
            <InputRow g={g} look={look}>
              <Caret g={g} look={look} style={{ marginRight: space.xxs * g.s }} />
              <Label g={g} size={BAR_TYPE.floatingField.fontSize} color={look.t.placeholder}>
                Search or enter address
              </Label>
            </InputRow>
            <Divider g={g} look={look} />
            <SuggestionList g={g} look={look} t={t} rows={FRESH} ms={OPEN + 160} />
          </Panel>
          <KeyPress g={g} t={t} label={keyText("⌘T")} ms={OPEN - 240} back={CLOSE} />
        </>
      }
    />
  );
};

const endSlot = (g: Geo, opts: SceneOpts) => (opts.top ? tabCount(g, opts) - 1 : tabCount(g, opts));

export function newTabAt(at: "top" | "bottom" | "next"): Scene {
  return ({ g, look, p, opts }) => {
    const t = tracker(p, sceneMs.newTabPosition);
    const slot = at === "top" ? 0 : at === "next" ? 1 : endSlot(g, opts);
    return (
      <Rest
        g={g}
        look={look}
        opts={opts}
        {...tabsSlot(opts, <InsertedList g={g} look={look} opts={opts} t={t} at={slot} ms={OPEN} back={CLOSE - 300} />)}
        crumb={<FadingCrumb g={g} look={look} t={t} ms={OPEN + 100} back={CLOSE - 300} />}
        over={<KeyPress g={g} t={t} label={keyText("⌘T")} ms={OPEN - 240} back={CLOSE - 300} />}
      />
    );
  };
}
