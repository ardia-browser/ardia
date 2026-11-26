import { Animated } from "react-native";
import { fill, type Rect, ROW, rowY, TOOLBAR_H } from "../geometry";
import { BLANK, tab, TRIP } from "../content";
import { linear, tracker } from "../timeline";
import { Backdrop, Glyph, Highlight, Label } from "../Kit";
import { NewTabPage, Page } from "../MockPages";
import { Cursor, Pill } from "../Floating";
import { sceneMs } from "../tokens";
import { font } from "../../../ui/tokens";
import type { Scene } from "../scene";
import { along, AwayToDesktop, cardOf, KeyPress, ListItem, MINI_SIDE, MiniArdia, NewTabRow, pitchOf, Rest, Selected, tabCount, tabsSlot } from "./SceneParts";
import { keyText } from "../../../../state/commands/keyText";

const STALE = new Set([1, 3, 4]);

export function tidy(auto: boolean): Scene {
  return ({ g, look, p, opts }) => {
    const t = tracker(p, sceneMs.tidy);
    const c = cardOf(g, opts);
    const n = tabCount(g, opts);
    const pitch = pitchOf(opts) * g.s;
    const back = 2500;
    const stale = (i: number) => STALE.has(i) && i < n;
    const above = (i: number) => [...STALE].filter((o) => o < i && o < n).length;
    const gone = auto ? { opacity: t([[850, 1], [1000, 0.4], [1060, 0.4], [1300, 0], [back, 0], [back + 400, 1]]), transform: [{ scale: t([[1060, 1], [1300, 0.92], [back, 0.92], [back + 400, 1]]) }] } : null;
    const rise = (k: number) => (auto && k ? { transform: along(opts, t([[1140, 0], [1460, -k * pitch], [back, -k * pitch], [back + 400, 0]])) } : null);
    const list = (
      <>
        {opts.top ? <Selected g={g} look={look} opts={opts} /> : null}
        {Array.from({ length: n }, (_, i) => (
          <ListItem key={i} g={g} look={look} opts={opts} t={tab(i)} i={i} selected={i === 0} style={stale(i) ? gone : rise(above(i))} />
        ))}
        <NewTabRow g={g} look={look} opts={opts} i={n} style={rise(above(n))} />
      </>
    );
    return (
      <Rest
        g={g}
        look={look}
        opts={opts}
        {...tabsSlot(opts, list)}
        over={
          <Pill g={g} look={look} place={{ right: (g.W - c.x - c.w + 16) * g.s, top: (c.y + 54) * g.s }} style={{ opacity: t.pulse(120, back + 200, 220, 260), transform: [{ translateY: t.trip(-6 * g.s, 0, 120, back + 200, 280, 260) }] }}>
            <Animated.View style={{ transform: [{ rotate: t.deg([[200, 0], [900, 360]]) }] }}>
              <Glyph g={g} name="clock" size={13} color={look.t.textPrimary} weight="medium" box={16} />
            </Animated.View>
            <Label g={g} size={font.body.fontSize} color={look.t.textPrimary} weight="500">
              12 hours later
            </Label>
          </Pill>
        }
      />
    );
  };
}

export function quit(fresh: boolean): Scene {
  return ({ g, look, p, opts }) => {
    const t = tracker(p, sceneMs.quit);
    const c = cardOf(g, opts);
    const leave = 360;
    const arrive = 900;
    const leaveAgain = 2100;
    const returnAt = 2600;
    const window = fresh
      ? { opacity: t([[leave, 1], [leave + 240, 0], [returnAt, 0], [returnAt + 320, 1]]), transform: [{ scale: t([[leave, 1], [leave + 240, 0.97], [returnAt, 0.97], [returnAt + 320, 1]]) }] }
      : { opacity: t([[leave, 1], [leave + 240, 0], [arrive, 0], [arrive + 320, 1]]), transform: [{ scale: t([[leave, 1], [leave + 240, 0.97], [arrive, 0.97], [arrive + 320, 1]]) }] };
    const blank = { opacity: t([[arrive, 0], [arrive + 320, 1], [leaveAgain, 1], [leaveAgain + 240, 0]]), transform: [{ scale: t([[arrive, 0.97], [arrive + 320, 1], [leaveAgain, 1], [leaveAgain + 240, 0.97]]) }] };
    return (
      <>
        <Backdrop look={look} />
        <Animated.View style={[fill, window]}>
          <Rest g={g} look={look} opts={opts} />
        </Animated.View>
        {fresh ? (
          <Animated.View style={[fill, blank]}>
            <Rest
              g={g}
              look={look}
              opts={opts}
              {...tabsSlot(
                opts,
                <>
                  {opts.top ? <Selected g={g} look={look} opts={opts} /> : null}
                  <ListItem g={g} look={look} opts={opts} t={BLANK} i={0} selected />
                  <NewTabRow g={g} look={look} opts={opts} i={1} />
                </>,
              )}
              crumb={null}
              page={<NewTabPage g={g} look={look} width={c.w} top={TOOLBAR_H} />}
            />
          </Animated.View>
        ) : null}
        <KeyPress g={g} t={t} label={keyText("⌘Q")} ms={leave - 260} back={leave + 300} />
      </>
    );
  };
}

export function windows(shared: boolean): Scene {
  return ({ g, look, p, opts }) => {
    const t = tracker(p, sceneMs.windows);
    const w = (g.W - 50) / 2;
    const h = g.H - 56;
    const a: Rect = { x: 18, y: 26, w, h };
    const b: Rect = { x: 32 + w, y: 30, w, h };
    const list = [tab(0), tab(1), tab(2), tab(3)];
    const other = shared ? list : [tab(4), tab(5), tab(6)];
    const cursorFrom = { x: a.x + w * 0.62, y: a.y + h * 0.78 };
    const cursorTo = { x: a.x + 70, y: a.y + rowY(2) + 14 };
    const click = 1100;
    const back = 3000;
    const dimB = (i: number) => {
      if (!shared) return null;
      if (i === 0) return { opacity: t([[click + 40, 0.4], [click + 300, 1]]) };
      if (i === 2) return { opacity: t([[click + 40, 1], [click + 300, 0.4]]) };
      return null;
    };
    return (
      <AwayToDesktop g={g} look={look} opts={opts} t={t} out={300} back={back}>
        <MiniArdia
          g={g}
          look={look}
          rect={a}
          tabs={list}
          dim={(i) => (shared && i === 1 ? { opacity: 0.4 } : null)}
          extra={<Highlight g={g} look={look} y={rowY(0)} w={MINI_SIDE - 12} style={{ transform: [{ translateY: t([[click, 0], [click + 300, 2 * ROW.pitch * g.s]]) }] }} />}
          cardContent={
            <>
              <Animated.View style={[fill, { opacity: t.out(click + 40, 200) }]}>
                <Page g={g} look={look} top={TOOLBAR_H} />
              </Animated.View>
              <Animated.View style={[fill, { opacity: t.in(click + 80, 260) }]}>
                <Page g={g} look={look} a={TRIP} top={TOOLBAR_H} />
              </Animated.View>
            </>
          }
        />
        <MiniArdia g={g} look={look} rect={b} tabs={other} sel={shared ? 1 : 0} dim={dimB} />
        <Cursor
          g={g}
          style={{
            opacity: t([[600, 0], [760, 1], [back - 400, 1], [back - 160, 0]]),
            transform: [
              { translateX: t([[600, cursorFrom.x * g.s], [click - 40, cursorTo.x * g.s]]) },
              { translateY: t([[600, cursorFrom.y * g.s], [click - 40, cursorTo.y * g.s]]) },
              { scale: t([[click - 20, 1], [click + 20, 0.85], [click + 140, 1]], linear) },
            ],
          }}
        />
      </AwayToDesktop>
    );
  };
}
