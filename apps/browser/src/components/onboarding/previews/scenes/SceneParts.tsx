import { useMemo, type ReactNode } from "react";
import { Animated, View } from "react-native";
import { atRect, CARD, chipX, CHIP, CHIP_STEP, type Geo, hairline, fill, type Rect, restCard, restChipCount, restRowCount, ROW, rowY, TOOLBAR_H } from "../geometry";
import { type Article, NEW_TAB, type Suggestion, tab, type Tab } from "../content";
import { type Look, pick } from "../look";
import { crumbSwap, type Stop, type Tracker } from "../timeline";
import { Backdrop, Card, Crumb, Highlight, Label, type Lit, Lights, Selection, TabRow, Toolbar, WindowFrame, type Styles } from "../Kit";
import { Page } from "../MockPages";
import { Keycap, SuggestionRow } from "../Floating";
import { mockInk } from "../tokens";
import { font, space } from "../../../ui/tokens";
import { SUGGESTION } from "../../../omnibox/tokens";
import type { SceneOpts } from "../scene";
import { SelectedChip, type SiteTint, type WindowSlots, WindowState } from "../WindowState";

export function Rest({ g, look, opts, site, ...slots }: { g: Geo; look: Look; opts: SceneOpts; site?: SiteTint } & WindowSlots) {
  const values = useMemo(
    () => ({ lay: new Animated.Value(opts.top ? 1 : 0), addr: new Animated.Value(opts.addressInSidebar ? 1 : 0), site: new Animated.Value(opts.siteColor ? 1 : 0) }),
    [opts.top, opts.addressInSidebar, opts.siteColor],
  );
  const tint = typeof site === "number" ? new Animated.Value(site) : site;
  return <WindowState g={g} look={look} accent={opts.accent} custom={opts.custom} lay={values.lay} addr={values.addr} site={tint ?? values.site} frame={opts.frame} slots={slots} />;
}

export const cardOf = (g: Geo, opts: SceneOpts) => restCard(g, opts.top, opts.frame);
export const tabCount = (g: Geo, opts: SceneOpts) => (opts.top ? restChipCount(g) : restRowCount(g));
export const pitchOf = (opts: SceneOpts) => (opts.top ? CHIP_STEP : ROW.pitch);
export const along = (opts: SceneOpts, value: Animated.AnimatedInterpolation<number>) => (opts.top ? [{ translateX: value }] : [{ translateY: value }]);
export const tabsSlot = (opts: SceneOpts, node: ReactNode): WindowSlots => (opts.top ? { chips: node } : { rows: node });

export function ListItem({ g, look, opts, t, i, lit, selected, style }: { g: Geo; look: Look; opts: SceneOpts; t: Tab; i: number; lit?: Lit; selected?: boolean; style?: Styles }) {
  if (opts.top) return <TabRow g={g} look={look} t={t} x={chipX(i)} y={CHIP.top - 1} w={CHIP.w} style={style} />;
  return <TabRow g={g} look={look} t={t} y={rowY(i)} lit={lit} selected={selected} style={style} />;
}

export function Selected({ g, look, opts, i = 0, site, style }: { g: Geo; look: Look; opts: SceneOpts; i?: number; site?: SiteTint; style?: Styles }) {
  if (opts.top) return <SelectedChip g={g} look={look} x={chipX(i)} site={site ?? (opts.siteColor ? 1 : 0)} style={style} />;
  return <Highlight g={g} look={look} y={rowY(i)} style={style} />;
}

export function NewTabRow({ g, look, opts, i, style }: { g: Geo; look: Look; opts: SceneOpts; i: number; style?: Styles }) {
  if (opts.top) return null;
  return <TabRow g={g} look={look} t={NEW_TAB} y={rowY(i)} style={style} />;
}

export function RestList({ g, look, opts, lit, from = 0 }: { g: Geo; look: Look; opts: SceneOpts; lit?: (i: number) => Lit | undefined; from?: number }) {
  const n = tabCount(g, opts);
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <ListItem key={i} g={g} look={look} opts={opts} t={tab(from + i)} i={i} lit={lit?.(i)} />
      ))}
      <NewTabRow g={g} look={look} opts={opts} i={n} />
    </>
  );
}

export function KeyPress({ g, t, label, ms, back }: { g: Geo; t: Tracker; label: string; ms: number; back: number }) {
  return <Keycap g={g} x={g.W - 22} y={g.H - 50} label={label} style={{ opacity: t.pulse(ms, back, 160, 200), transform: [{ scale: t([[ms, 0.82], [ms + 260, 1], [back, 1], [back + 200, 0.92]]) }] }} />;
}

export function CrumbSwap({ g, look, t, a, b, ms, back }: { g: Geo; look: Look; t: Tracker; a: Tab; b: Tab; ms: number; back: number }) {
  const { first, second } = crumbSwap(ms, back);
  const shift = (stops: readonly Stop[]) => stops.map(([when, dx]) => [when, dx * g.s] as const);
  return (
    <>
      <Crumb g={g} look={look} t={a} style={[fill, { opacity: t(first.opacity), transform: [{ translateX: t(shift(first.x)) }] }]} />
      <Crumb g={g} look={look} t={b} style={[fill, { opacity: t(second.opacity), transform: [{ translateX: t(shift(second.x)) }] }]} />
    </>
  );
}

export function PageSwap({ g, look, t, ms, back, a, b }: { g: Geo; look: Look; t: Tracker; ms: number; back: number; a: Article; b: Article }) {
  return (
    <>
      <Page g={g} look={look} a={a} top={TOOLBAR_H} />
      <Animated.View style={[fill, { opacity: t.pulse(ms, back, 280) }]}>
        <Page g={g} look={look} a={b} top={TOOLBAR_H} />
      </Animated.View>
    </>
  );
}

export const CURRENT: Suggestion[] = [
  { fav: tab(0), title: "A slow morning on the coast trail", detail: "fieldnotes.blog" },
  { fav: tab(2), title: "Weekend in Lisbon", hint: "Switch to Tab" },
  { icon: "magnifyingglass", title: "coast trail walks" },
];

export const FRESH: Suggestion[] = [
  { fav: tab(1), title: "Inbox", hint: "Switch to Tab" },
  { fav: tab(3), title: "Q4 roadmap", detail: "docs.new" },
  { icon: "clock", title: "coast trail walks" },
];

export function SuggestionList({ g, look, t, rows, ms }: { g: Geo; look: Look; t: Tracker; rows: Suggestion[]; ms: number }) {
  return (
    <View style={{ paddingHorizontal: SUGGESTION.listX * g.s, paddingTop: space.xs * g.s }}>
      {rows.map((s, i) => (
        <SuggestionRow key={i} g={g} look={look} s={s} selected={i === 0} style={{ opacity: t.in(ms + i * 50, 200), transform: [{ translateY: t([[ms + i * 50, -3 * g.s], [ms + i * 50 + 220, 0]]) }] }} />
      ))}
    </View>
  );
}

export function SelectedUrl({ g, look }: { g: Geo; look: Look }) {
  return (
    <View style={{ flexShrink: 1, flexDirection: "row" }}>
      <Selection g={g} look={look} style={{ flexShrink: 1 }}>
        <Label g={g} size={font.title.fontSize} color={look.t.textPrimary}>
          fieldnotes.blog/coast-trail
        </Label>
      </Selection>
    </View>
  );
}

export function Divider({ g, look }: { g: Geo; look: Look }) {
  return <View style={{ height: hairline, marginHorizontal: space.xl * g.s, backgroundColor: look.t.divider }} />;
}

export const PANEL_H = 52 + 3 * SUGGESTION.height + 14;

export function centredFrame(g: Geo, opts: SceneOpts): Rect {
  const c = cardOf(g, opts);
  const content = c.w < 708 ? (c.w <= 636 ? c.w - 20 : 616) : 652;
  const w = Math.min(content, c.w - 28, 560);
  return { x: c.x + (c.w - w) / 2, y: c.y + Math.max(12, Math.round(c.h * 0.22)), w, h: PANEL_H };
}

export function growTrip(t: Tracker, g: Geo, from: Rect, to: Rect, ms: number, back: number, dur = 260) {
  const sx = from.w / to.w;
  const sy = from.h / to.h;
  const dx = (from.x - to.x - (to.w * (1 - sx)) / 2) * g.s;
  const dy = (from.y - to.y - (to.h * (1 - sy)) / 2) * g.s;
  return {
    opacity: t([[ms, 0], [ms + 90, 1], [back + dur - 90, 1], [back + dur, 0]]),
    transform: [{ translateX: t.trip(dx, 0, ms, back, dur) }, { translateY: t.trip(dy, 0, ms, back, dur) }, { scaleX: t.trip(sx, 1, ms, back, dur) }, { scaleY: t.trip(sy, 1, ms, back, dur) }],
  };
}

export const dropTrip = (t: Tracker, g: Geo, ms: number, back: number) => ({
  opacity: t.pulse(ms, back, 200, 220),
  transform: [{ translateY: t.trip(-10 * g.s, 0, ms, back, 300, 220) }, { scale: t.trip(0.97, 1, ms, back, 300, 220) }],
});

export function Desktop({ look }: { look: Look }) {
  const [a, b] = look.dark ? mockInk.desktop.dark : mockInk.desktop.light;
  return <Backdrop look={{ ...look, tint: [a, b] }} />;
}

export function AwayToDesktop({ g, look, opts, t, out, back, children }: { g: Geo; look: Look; opts: SceneOpts; t: Tracker; out: number; back: number; children: ReactNode }) {
  return (
    <>
      <Desktop look={look} />
      <Animated.View style={[fill, { opacity: t.trip(1, 0, out, back + 260, 240, 300), transform: [{ scale: t.trip(1, 0.96, out, back + 260, 240, 300) }] }]}>
        <Rest g={g} look={look} opts={opts} />
      </Animated.View>
      <Animated.View style={[fill, { opacity: t.pulse(out + 200, back, 300, 240) }]}>{children}</Animated.View>
    </>
  );
}

export function Window({ g, look, rect, children }: { g: Geo; look: Look; rect: Rect; children: ReactNode }) {
  return (
    <WindowFrame g={g} look={look} edge={pick(look, [mockInk.appWindowEdge.light, mockInk.appWindowEdge.dark])} style={atRect(g, rect)}>
      {children}
    </WindowFrame>
  );
}

export const MINI_SIDE = 150;

export function MiniArdia({ g, look, rect, tabs, sel, dim, rowStyle, extra, cardContent }: { g: Geo; look: Look; rect: Rect; tabs: Tab[]; sel?: number; dim?: (i: number) => object | null; rowStyle?: (i: number) => object | null; extra?: ReactNode; cardContent?: ReactNode }) {
  const card: Rect = { x: MINI_SIDE + CARD - ROW.x, y: CARD, w: rect.w - MINI_SIDE - 2 * CARD + ROW.x, h: rect.h - 2 * CARD };
  return (
    <Window g={g} look={look} rect={rect}>
      <Backdrop look={look} />
      <Lights g={g} />
      {extra}
      {tabs.map((tb, i) => (
        <TabRow key={i} g={g} look={look} t={tb} y={rowY(i)} w={MINI_SIDE - 12} selected={i === sel} style={[dim?.(i), rowStyle?.(i)]} />
      ))}
      <Card g={g} look={look} rect={card}>
        <Toolbar g={g} look={look} w={card.w} t={tabs[sel ?? 0] ?? tab(0)} icons={[21, 56]} crumbX={84} />
        {cardContent ?? <Page g={g} look={look} top={TOOLBAR_H} />}
      </Card>
    </Window>
  );
}
