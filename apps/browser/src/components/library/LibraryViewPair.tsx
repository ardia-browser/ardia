import { createRef, type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { View } from "react-native";
import { LIBRARY_VIEWS, type LibraryView } from "../../state/library/views";
import { LIBRARY_MOTION } from "./motion";

export type ViewScroll = { topItem: () => number; showItem: (index: number) => void };

export type ViewSlot = { active: boolean; scroll: RefObject<ViewScroll | null>; entry: RefObject<(() => void) | null> };

type Slots = Record<LibraryView, { scroll: RefObject<ViewScroll | null>; entry: RefObject<(() => void) | null> }>;

const FILL = { flex: 1 } as const;
const HIDDEN = { display: "none" } as const;

export function LibraryViewPair({
  view,
  live,
  entry,
  render,
}: {
  view: LibraryView;
  live: boolean;
  entry: RefObject<(() => void) | null>;
  render: (view: LibraryView, slot: ViewSlot) => ReactNode;
}) {
  const [built, setBuilt] = useState<readonly LibraryView[]>(() => [view]);
  const views = built.includes(view) ? built : [...built, view];
  const [slots] = useState(() => Object.fromEntries(LIBRARY_VIEWS.map((v) => [v, { scroll: createRef<ViewScroll>(), entry: createRef<() => void>() }])) as Slots);
  const shownView = useRef(view);
  const [enter] = useState(() => () => slots[shownView.current].entry.current?.());
  entry.current = enter;
  const held = useRef<Partial<Record<LibraryView, ReactNode>>>({});
  for (const v of views) {
    const active = v === view;
    if (active || held.current[v] === undefined) held.current[v] = render(v, { active, scroll: slots[v].scroll, entry: slots[v].entry });
  }
  useLayoutEffect(() => {
    const from = shownView.current;
    shownView.current = view;
    if (from === view) return;
    const top = slots[from].scroll.current?.topItem() ?? -1;
    if (top > 0) slots[view].scroll.current?.showItem(top);
  }, [view]);
  useEffect(() => {
    if (!live || views.length === LIBRARY_VIEWS.length) return;
    const later = setTimeout(() => setBuilt(LIBRARY_VIEWS), LIBRARY_MOTION.page.viewPrewarm);
    return () => clearTimeout(later);
  }, [live, views.length]);
  useEffect(() => {
    if (views !== built) setBuilt(views);
  });
  return (
    <>
      {LIBRARY_VIEWS.filter((v) => views.includes(v)).map((v) => (
        <View key={v} style={v === view ? FILL : HIDDEN}>
          {held.current[v]}
        </View>
      ))}
    </>
  );
}
