import { useEffect } from "react";
import { View } from "react-native";
import type { PreviewId } from "./previews";
import { space } from "../ui/tokens";
import { OptionCard } from "./OptionCard";
import { useSection, type MockFocus } from "./sectionContext";

export type { MockFocus } from "./sectionContext";

export type ChoiceOption<T> = { value: T; preview: PreviewId; title: string; subtitle: string };

export function ChoiceList<T extends string | number | boolean | null>({
  options,
  value,
  onChange,
  mock,
}: {
  options: ChoiceOption<T>[];
  value: T;
  onChange: (value: T) => void;
  mock: MockFocus;
}) {
  const { active, key } = useSection();
  const settled = options.find((o) => o.value === value)?.preview ?? null;
  useEffect(() => {
    if (active) mock.settle(key, settled);
  }, [active, key, settled]);
  return (
    <View style={{ gap: space.m }} accessibilityRole="radiogroup">
      {options.map((o) => (
        <OptionCard
          key={String(o.value)}
          control="radio"
          title={o.title}
          subtitle={o.subtitle}
          selected={o.value === value}
          onHover={(on) => active && mock.hover(o.preview, on)}
          onPress={() => {
            if (o.value !== value) onChange(o.value);
            mock.choose(key, o.preview);
          }}
        />
      ))}
    </View>
  );
}
