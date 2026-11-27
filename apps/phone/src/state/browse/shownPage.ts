export type ShownPageInputs = {
  appActive: boolean;
  surface: "start" | "browsing" | "deck";
  covered: boolean;
  voice: boolean;
  selectedId: string | null;
};

export const shownPageId = ({ appActive, surface, covered, voice, selectedId }: ShownPageInputs): string | null =>
  appActive && surface === "browsing" && !covered && !voice ? selectedId : null;

type Subscribable = { subscribe: (listener: () => void) => () => void };

export function followShownPage(shown: () => string | null, push: (id: string | null) => void, stores: readonly Subscribable[]) {
  let sent: string | null | undefined;
  const report = () => {
    const id = shown();
    if (id === sent) return;
    sent = id;
    push(id);
  };
  const stops = stores.map((store) => store.subscribe(report));
  report();
  return { report, stop: () => stops.forEach((stop) => stop()) };
}
