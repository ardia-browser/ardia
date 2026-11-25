import { Animated, View } from "react-native";
import { fill, TOOLBAR_H } from "../geometry";
import { lookFor } from "../look";
import { tracker } from "../timeline";
import { Glyph, Label } from "../Kit";
import { Page } from "../MockPages";
import { Pill } from "../Floating";
import { mockInk, sceneMs } from "../tokens";
import { font } from "../../../ui/tokens";
import type { Scene } from "../scene";
import { Rest } from "./SceneParts";
import { PLATFORM_TERMS } from "../../../../lib/platformTerms";

export function appearance(mode: "light" | "dark" | "auto"): Scene {
  return ({ g, look, p, opts }) => {
    const t = tracker(p, sceneMs.appearance);
    const dark = look.dark;
    const flip = lookFor(!dark, opts.accent, opts.palette);
    const turn = 700;
    const back = 2000;
    const shown = (isDark: boolean) => (mode === "auto" ? `Auto · ${isDark ? "Dark" : "Light"} like your ${PLATFORM_TERMS.computer}` : isDark ? "Dark" : "Light");
    const pill = (l: typeof look, opacity: Animated.AnimatedInterpolation<number>) => (
      <Pill g={g} look={l} style={{ opacity, transform: [{ translateY: t.trip(6 * g.s, 0, 300, back + 300, 280, 240) }] }}>
        <Animated.View style={{ transform: [{ rotate: t.deg([[340, -90], [780, 0]]) }] }}>
          <Glyph g={g} name={l.dark ? "moon.fill" : "sun.max.fill"} size={14} color={l.dark ? mockInk.moon : mockInk.sun} weight="medium" box={18} />
        </Animated.View>
        <Label g={g} size={font.body.fontSize} color={l.t.textPrimary} weight="500">
          {shown(l.dark)}
        </Label>
      </Pill>
    );
    if (mode !== "auto") return <Rest g={g} look={look} opts={opts} over={pill(look, t.pulse(300, back + 300, 220, 240))} />;
    return (
      <>
        <Rest g={g} look={look} opts={opts} />
        <Animated.View style={[fill, { opacity: t.pulse(turn, back, 420, 420) }]}>
          <Rest g={g} look={flip} opts={opts} />
        </Animated.View>
        {pill(look, t([[300, 0], [520, 1], [turn, 1], [turn + 200, 0], [back + 200, 0], [back + 420, 1], [back + 600, 1], [back + 800, 0]]))}
        {pill(flip, t([[turn + 200, 0], [turn + 420, 1], [back, 1], [back + 200, 0]]))}
      </>
    );
  };
}

export function siteColor(on: boolean): Scene {
  return ({ g, look, p, opts }) => {
    const t = tracker(p, sceneMs.siteColor);
    const load = 500;
    const loaded = 1100;
    const tint = on ? t([[load, 1], [load + 200, 0], [loaded + 120, 0], [loaded + 520, 1]]) : 0;
    return (
      <Rest
        g={g}
        look={look}
        opts={{ ...opts, siteColor: on }}
        site={tint}
        page={
          <>
            <View style={[fill, { top: TOOLBAR_H * g.s, backgroundColor: look.page }]} />
            <Animated.View style={[fill, { opacity: t([[load, 1], [load + 200, 0], [loaded, 0], [loaded + 320, 1]]), transform: [{ translateY: t([[load + 200, 0], [loaded, 6 * g.s], [loaded + 340, 0]]) }] }]}>
              <Page g={g} look={look} top={TOOLBAR_H} />
            </Animated.View>
          </>
        }
      />
    );
  };
}
