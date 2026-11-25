import { tab, NOTES, TRIP } from "../content";
import { tracker } from "../timeline";
import { sceneMs } from "../tokens";
import type { Scene } from "../scene";
import { along, CrumbSwap, ListItem, NewTabRow, PageSwap, pitchOf, Rest, Selected, tabCount, tabsSlot } from "./SceneParts";

const GO = 420;
const BACK = 1760;
const TO = 2;

export const TabSwitch: Scene = ({ g, look, p, opts }) => {
  const t = tracker(p, sceneMs.tabs);
  const n = tabCount(g, opts);
  const move = t.trip(0, TO * pitchOf(opts) * g.s, GO, BACK, 300, 320);
  const lit = (i: number) => (i === 0 ? t.trip(1, 0, GO, BACK, 300, 320) : i === TO ? t.pulse(GO, BACK, 300, 320) : undefined);
  const list = (
    <>
      <Selected g={g} look={look} opts={opts} style={{ transform: along(opts, move) }} />
      {Array.from({ length: n }, (_, i) => (
        <ListItem key={i} g={g} look={look} opts={opts} t={tab(i)} i={i} lit={lit(i)} />
      ))}
      <NewTabRow g={g} look={look} opts={opts} i={n} />
    </>
  );
  return (
    <Rest
      g={g}
      look={look}
      opts={opts}
      {...tabsSlot(opts, list)}
      crumb={<CrumbSwap g={g} look={look} t={t} a={tab(0)} b={tab(TO)} ms={GO + 40} back={BACK} />}
      page={<PageSwap g={g} look={look} t={t} ms={GO + 80} back={BACK} a={NOTES} b={TRIP} />}
    />
  );
};
