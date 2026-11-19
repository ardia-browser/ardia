import { profileSwitcher } from "./tokens";

type Ink = readonly [width: number, height: number, centreX: number, centreY: number];

export const SWITCHER_INK: Readonly<Record<string, Ink>> = {
  "house.fill": [14.25, 12.25, 0.5, 0.25],
  "briefcase.fill": [13, 11.5, 0, -0.5],
  "graduationcap.fill": [17, 11.75, -0.75, -0.25],
  "chevron.left.forwardslash.chevron.right": [16.25, 13, 0.5, -0.25],
  "paintpalette.fill": [14.25, 11.5, 0, 0.5],
  "hammer.fill": [14.25, 13, -0.25, 0.75],
  "book.closed.fill": [9.5, 11.75, 0.25, 0.25],
  "music.note": [6.5, 10.75, 0, 0],
  "camera.fill": [13.25, 10.5, 0.25, -0.25],
  "gamecontroller.fill": [16.25, 10.25, 0.5, 0],
  "cart.fill": [12.75, 11, -0.5, -1.25],
  "banknote.fill": [14.75, 9.25, -0.25, 0.5],
  airplane: [12.5, 8.25, 0.25, 0.5],
  "figure.run": [9.25, 11.25, 0, -0.25],
  "cup.and.saucer.fill": [14.5, 11, 0.5, 0.25],
  "leaf.fill": [12, 8.75, -0.25, -0.25],
  "pawprint.fill": [12, 11.25, 0.25, 0.5],
  "heart.fill": [11.5, 10.5, 0, 0],
  "star.fill": [13.25, 12.5, 0.25, 0],
  "moon.stars.fill": [11, 11.75, 0.75, 0.75],
  "person.fill": [8.75, 10.25, 0.25, 0.25],
  "person.2.fill": [15, 9.5, 0, 0],
  "building.2.fill": [13, 13, 0.5, -0.25],
  "terminal.fill": [13, 10.5, 0, 0],
  "server.rack": [13.25, 10.25, 0.5, 0],
  "flask.fill": [10.5, 12, 0.25, 0.25],
  "lightbulb.fill": [7.75, 13, -0.25, -0.75],
  sparkles: [9.75, 10.25, 0.25, 0.75],
  "newspaper.fill": [12, 11.75, 0.5, 0.25],
  "film.fill": [13, 10.25, 0.5, 0],
  headphones: [11.25, 11.5, 0.25, -0.25],
  "sportscourt.fill": [15.5, 10.25, 0.25, 0],
  bicycle: [19, 11.5, 0, 0.25],
  "fork.knife": [8.25, 12, 0.75, 0],
  "gift.fill": [11, 11.5, 0.25, 0.5],
  stethoscope: [13.75, 11.5, -0.25, 0],
  "chart.line.uptrend.xyaxis": [12.75, 10.25, 1, -0.25],
  "envelope.fill": [13.25, 9.75, 0.25, 0.25],
  "bubble.left.and.bubble.right.fill": [16.25, 12.25, -0.25, -0.25],
  calendar: [11.25, 10.5, 0.25, -0.25],
  "mountain.2.fill": [20.75, 10.5, 0.25, 0.25],
  "beach.umbrella.fill": [10.75, 7.75, 0, -0.5],
  "lock.fill": [8, 11, 0.25, -0.5],
  "flame.fill": [9.75, 13.25, -0.25, -0.25],
  "bolt.fill": [8, 12, 0, -0.5],
};

export type SwitcherFit = { scale: number; dx: number; dy: number };

const UNMEASURED: SwitcherFit = { scale: 1, dx: 0, dy: 0 };

export function switcherFit(symbol: string): SwitcherFit {
  if (!Object.hasOwn(SWITCHER_INK, symbol)) return UNMEASURED;
  const [width, height, centreX, centreY] = SWITCHER_INK[symbol]!;
  const scale = Math.min(profileSwitcher.ink / width, profileSwitcher.ink / height);
  return { scale, dx: -centreX * scale, dy: -centreY * scale };
}
