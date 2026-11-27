import { Animated } from "react-native";
import { BLANK, tab } from "../content";
import type { Geo } from "../geometry";
import type { Look } from "../look";
import type { Tracker } from "../timeline";
import { Crumb } from "../Kit";
import { NewTabPage, Page } from "../MockPages";
import type { SceneOpts } from "../scene";
import { along, cardOf, ListItem, NewTabRow, pitchOf, Selected, tabCount } from "./SceneParts";
import { fill, TOOLBAR_H } from "../geometry";

export function InsertedList({ g, look, opts, t, at, ms, back }: { g: Geo; look: Look; opts: SceneOpts; t: Tracker; at: number; ms: number; back: number }) {
  const n = tabCount(g, opts);
  const step = pitchOf(opts) * g.s;
  const push = t.trip(0, step, ms, back + 80, 300, 300);
  const arrive = t.pulse(ms + 100, back, 240, 200);
  const enter = opts.top ? [{ translateY: t.trip(-8 * g.s, 0, ms + 100, back, 300, 200) }] : [{ translateX: t.trip(-12 * g.s, 0, ms + 100, back, 300, 200) }];
  const oldSelected = t.trip(1, 0, ms + 100, back, 220, 220);
  const pushedOut = (i: number) => (opts.top && i + 1 >= n ? { opacity: t.trip(1, 0, ms, back + 80, 300, 300) } : null);
  return (
    <>
      <Selected g={g} look={look} opts={opts} style={{ opacity: oldSelected, transform: along(opts, at === 0 ? push : t.trip(0, 0, ms, back)) }} />
      <Selected g={g} look={look} opts={opts} i={at} style={{ opacity: arrive, transform: enter }} />
      {Array.from({ length: n }, (_, i) => (
        <ListItem key={i} g={g} look={look} opts={opts} t={tab(i)} i={i} lit={i === 0 ? oldSelected : undefined} style={[i >= at ? { transform: along(opts, push) } : null, pushedOut(i)]} />
      ))}
      <ListItem g={g} look={look} opts={opts} t={BLANK} i={at} lit={arrive} style={{ opacity: arrive, transform: enter }} />
      <NewTabRow g={g} look={look} opts={opts} i={n} style={{ transform: along(opts, push) }} />
    </>
  );
}

export function NewTabArrives({ g, look, opts, t, ms, back }: { g: Geo; look: Look; opts: SceneOpts; t: Tracker; ms: number; back: number }) {
  return (
    <>
      <Page g={g} look={look} top={TOOLBAR_H} />
      <Animated.View style={[fill, { opacity: t.pulse(ms, back, 300, 240) }]}>
        <NewTabPage g={g} look={look} width={cardOf(g, opts).w} top={TOOLBAR_H} />
      </Animated.View>
    </>
  );
}

export function FadingCrumb({ g, look, t, ms, back }: { g: Geo; look: Look; t: Tracker; ms: number; back: number }) {
  return <Crumb g={g} look={look} t={tab(0)} style={[fill, { opacity: t.trip(1, 0, ms, back, 160, 240) }]} />;
}
