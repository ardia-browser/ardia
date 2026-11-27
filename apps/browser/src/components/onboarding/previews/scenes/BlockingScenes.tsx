import type { ReactNode } from "react";
import { Animated, View } from "react-native";
import { at, type Geo, hairline, TOOLBAR_H } from "../geometry";
import { type Look, pick } from "../look";
import { tracker } from "../timeline";
import { Glyph, Label, MockSurface } from "../Kit";
import { Page } from "../MockPages";
import { mockInk, mockShadow, sceneMs } from "../tokens";
import { font, radius, space } from "../../../ui/tokens";
import type { Scene } from "../scene";
import { cardOf, Rest } from "./SceneParts";

function AdBox({ g, look, style, h, children }: { g: Geo; look: Look; style?: object; h: number; children?: ReactNode }) {
  return (
    <Animated.View style={[{ height: h * g.s, borderRadius: radius.tile * g.s, backgroundColor: pick(look, [mockInk.ad.fill.light, mockInk.ad.fill.dark]), borderWidth: hairline, borderColor: pick(look, [mockInk.ad.border.light, mockInk.ad.border.dark]), alignItems: "center", justifyContent: "center" }, style]}>
      <Label g={g} size={font.tiny.fontSize} color={pick(look, [mockInk.ad.label.light, mockInk.ad.label.dark])} weight="600">
        AD
      </Label>
      {children}
    </Animated.View>
  );
}

export function block(on: boolean): Scene {
  return ({ g, look, p, opts }) => {
    const t = tracker(p, sceneMs.block);
    const c = cardOf(g, opts);
    const back = 2500;
    const ad = (ms: number, gone: number) => ({
      opacity: on ? t([[ms, 0], [ms + 200, 1], [gone, 1], [gone + 220, 0]]) : t.pulse(ms, back, 200, 240),
      transform: [{ scale: on ? t([[ms, 0.94], [ms + 260, 1], [gone, 1], [gone + 260, 0.86]]) : t.trip(0.94, 1, ms, back, 260, 240) }],
    });
    const top = opts.addressInSidebar ? 0 : TOOLBAR_H;
    return (
      <Rest
        g={g}
        look={look}
        opts={opts}
        page={
          <>
            <Page g={g} look={look} top={TOOLBAR_H}>
              <AdBox g={g} look={look} h={64} style={ad(300, 1000)} />
            </Page>
            <AdBox g={g} look={look} h={150} style={[at(g, c.w - 150, TOOLBAR_H + 80, 130, 150), ad(220, 920)]} />
          </>
        }
        card={
          <>
            <Animated.View
              style={[
                { position: "absolute", left: 20 * g.s, right: 20 * g.s, bottom: 18 * g.s },
                {
                  opacity: on ? t([[380, 0], [520, 1], [1080, 1], [1320, 0]]) : t.pulse(380, back, 160, 240),
                  transform: [{ translateY: on ? t([[380, 40 * g.s], [680, 0], [1080, 0], [1320, 40 * g.s]]) : t.trip(40 * g.s, 0, 380, back, 300, 240) }],
                },
              ]}
            >
              <MockSurface g={g} look={look} radius={radius.panel} shadow={mockShadow.banner} style={{ height: 52 * g.s, flexDirection: "row", alignItems: "center", paddingHorizontal: space.xl * g.s, gap: space.l * g.s }}>
                <View style={{ flex: 1 }}>
                  <Label g={g} size={font.small.fontSize} color={look.t.textPrimary}>
                    We use cookies to personalise ads and measure traffic.
                  </Label>
                </View>
                <View style={{ height: 28 * g.s, paddingHorizontal: space.l * g.s, borderRadius: radius.tile * g.s, backgroundColor: look.t.goButton, justifyContent: "center" }}>
                  <Label g={g} size={font.small.fontSize} color={look.t.onPrimary} weight="600">
                    Accept all
                  </Label>
                </View>
              </MockSurface>
            </Animated.View>
            {on ? (
              <Animated.View style={[at(g, c.w - 64, top + 8, 52, 26), { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.xs * g.s, opacity: t.pulse(800, back, 200, 240), transform: [{ scale: t.trip(0.6, 1, 800, back, 260, 240) }] }]}>
                <Glyph g={g} name="checkmark.shield.fill" size={14} color={look.t.accent} weight="medium" box={18} />
                <Label g={g} size={font.caption.fontSize} color={look.t.textSecondary} weight="600">
                  3
                </Label>
              </Animated.View>
            ) : null}
          </>
        }
      />
    );
  };
}
