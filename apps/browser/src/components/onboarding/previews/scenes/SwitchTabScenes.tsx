import type { ReactNode } from "react";
import { View } from "react-native";
import { fill, type Geo, hairline, type Rect } from "../geometry";
import { NOTES, tab, type Tab, TRIP } from "../content";
import type { Look } from "../look";
import { type Stop, tracker, type Tracker } from "../timeline";
import { Crumb, Favicon, Label, type Lit, type Styles } from "../Kit";
import { Keycap, Panel } from "../Floating";
import { mockSwitcher, sceneMs } from "../tokens";
import { font, ink, radius, space } from "../../../ui/tokens";
import type { Scene, SceneOpts } from "../scene";
import { along, CrumbSwap, ListItem, NewTabRow, PageSwap, pitchOf, Rest, Selected, tabCount, tabsSlot } from "./SceneParts";
import { PLATFORM_TERMS } from "../../../../lib/platformTerms";

const KEY = PLATFORM_TERMS.switchTabsKey;
const FROM = tab(0);
const TO = tab(2);
const RECENT: readonly Tab[] = [FROM, TO, tab(1), tab(3)];
const BACK = 2100;

function SwitchingWindow({ g, look, opts, t, stops, lit, crumb, pageAt }: { g: Geo; look: Look; opts: SceneOpts; t: Tracker; stops: readonly Stop[]; lit: (i: number) => Lit | undefined; crumb: ReactNode; pageAt: number }) {
  const n = tabCount(g, opts);
  const pitch = pitchOf(opts) * g.s;
  const list = (
    <>
      <Selected g={g} look={look} opts={opts} style={{ transform: along(opts, t(stops.map(([ms, i]) => [ms, i * pitch] as const))) }} />
      {Array.from({ length: n }, (_, i) => (
        <ListItem key={i} g={g} look={look} opts={opts} t={tab(i)} i={i} lit={lit(i)} />
      ))}
      <NewTabRow g={g} look={look} opts={opts} i={n} />
    </>
  );
  return <Rest g={g} look={look} opts={opts} {...tabsSlot(opts, list)} crumb={crumb} page={<PageSwap g={g} look={look} t={t} ms={pageAt} back={BACK} a={NOTES} b={TRIP} />} />;
}

export const CtrlTabStep: Scene = ({ g, look, p, opts }) => {
  const t = tracker(p, sceneMs.ctrlTab);
  const first = 420;
  const second = 860;
  const lit = (i: number) => (i === 0 ? t.trip(1, 0, first, BACK, 180, 320) : i === 1 ? t([[first, 0], [first + 180, 1], [second, 1], [second + 180, 0]]) : i === 2 ? t.pulse(second, BACK, 180, 320) : undefined);
  const crumbAt = (stops: readonly Stop[]) => ({ opacity: t(stops) });
  return (
    <>
      <SwitchingWindow
        g={g}
        look={look}
        opts={opts}
        t={t}
        stops={[[first, 0], [first + 180, 1], [second, 1], [second + 180, 2], [BACK, 2], [BACK + 320, 0]]}
        lit={lit}
        pageAt={second + 40}
        crumb={
          <>
            <Crumb g={g} look={look} t={FROM} style={[fill, crumbAt([[first, 1], [first + 120, 0], [BACK + 120, 0], [BACK + 320, 1]])]} />
            <Crumb g={g} look={look} t={tab(1)} style={[fill, crumbAt([[first + 120, 0], [first + 300, 1], [second, 1], [second + 120, 0]])]} />
            <Crumb g={g} look={look} t={TO} style={[fill, crumbAt([[second + 120, 0], [second + 300, 1], [BACK, 1], [BACK + 120, 0]])]} />
          </>
        }
      />
      <Keycap g={g} x={g.W - 22} y={g.H - 50} label={KEY} style={{ opacity: t.pulse(first - 200, second + 400, 160, 200), transform: [{ scale: t([[first - 200, 0.82], [first, 1], [second - 80, 1], [second - 20, 0.92], [second + 80, 1]]) }] }} />
    </>
  );
};

export const CtrlTabSwitcher: Scene = ({ g, look, p, opts }) => {
  const t = tracker(p, sceneMs.ctrlTab);
  const shown = 320;
  const released = 1080;
  const lit = (i: number) => (i === 0 ? t.trip(1, 0, released, BACK, 1, 320) : i === 2 ? t.pulse(released, BACK, 1, 320) : undefined);
  return (
    <>
      <SwitchingWindow
        g={g}
        look={look}
        opts={opts}
        t={t}
        stops={[[released, 0], [released + 1, 2], [BACK, 2], [BACK + 320, 0]]}
        lit={lit}
        pageAt={released}
        crumb={<CrumbSwap g={g} look={look} t={t} a={FROM} b={TO} ms={released} back={BACK} />}
      />
      <Switcher g={g} look={look} accent={opts.accent} style={{ opacity: t([[shown, 0], [shown + 120, 1], [released, 1], [released + 120, 0]]) }} />
      <Keycap g={g} x={g.W - 22} y={g.H - 50} label={KEY} style={{ opacity: t.pulse(shown - 200, released, 160, 160) }} />
    </>
  );
};

function Switcher({ g, look, accent, style }: { g: Geo; look: Look; accent: string; style?: Styles }) {
  const { card, shot, label } = mockSwitcher;
  const w = 2 * space.m + RECENT.length * card + (RECENT.length - 1) * space.xs;
  const h = 2 * space.m + 2 * space.xs + shot + label;
  const rect: Rect = { x: (g.W - w) / 2, y: (g.H - h) / 2, w, h };
  return (
    <Panel g={g} look={look} rect={rect} radius={radius.sheet} style={style}>
      <View style={{ flexDirection: "row", padding: space.m * g.s, gap: space.xs * g.s }}>
        {RECENT.map((tb, i) => (
          <SwitcherCard key={i} g={g} look={look} t={tb} focused={i === 1} accent={accent} />
        ))}
      </View>
    </Panel>
  );
}

function SwitcherCard({ g, look, t: tb, focused, accent }: { g: Geo; look: Look; t: Tab; focused: boolean; accent: string }) {
  const { card, shot, label, favicon, labelFavicon, ring } = mockSwitcher;
  return (
    <View style={{ width: card * g.s, padding: space.xs * g.s, borderRadius: radius.panel * g.s, backgroundColor: focused ? look.t.commandBarSelected : ink.clear }}>
      <View
        style={{
          height: shot * g.s,
          borderRadius: radius.tile * g.s,
          backgroundColor: look.page,
          borderWidth: focused ? ring.focused * g.s : Math.max(hairline, ring.rest * g.s),
          borderColor: focused ? accent : look.t.divider,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Favicon g={g} t={tb} size={favicon} />
      </View>
      <View style={{ height: label * g.s, flexDirection: "row", alignItems: "center", gap: space.s * g.s, paddingHorizontal: space.xxs * g.s }}>
        <Favicon g={g} t={tb} size={labelFavicon} />
        <View style={{ flex: 1 }}>
          <Label g={g} size={font.small.fontSize} color={look.t.textPrimary} weight="600">
            {tb.title}
          </Label>
        </View>
      </View>
    </View>
  );
}
