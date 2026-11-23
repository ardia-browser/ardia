import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { Image } from "react-native";
import { Box, Checkbox, duration, IconTile, Text, type Space } from "../ui";
import { watchWindowActivation, windowActivatedAt } from "../../state/site/promptGuard";
import { useSiteTokens } from "./tokens";

export function PromptIcon({ icon }: { icon: string }) {
  return <IconTile symbol={icon} />;
}

export function PromptHeader({ icons, image, title, message }: { icons: string[]; image?: string | null; title: string; message?: string | null }) {
  return (
    <Box gap="ml">
      <Box row gap="s">
        {image ? <Image source={{ uri: image }} style={PROMPT_IMAGE} /> : null}
        {icons.map((icon) => (
          <PromptIcon key={icon} icon={icon} />
        ))}
      </Box>
      <Box gap="xs">
        <Text weight="semibold">{title}</Text>
        {message ? (
          <Text size="small" tone="textSecondary">
            {message}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

const PROMPT_IMAGE = { width: 32, height: 32 } as const;

export function Well({ list = false, gap, children }: { list?: boolean; gap?: Space; children: ReactNode }) {
  const { well } = useSiteTokens();
  return (
    <Box radius="tile" padX={list ? undefined : "ml"} padY={list ? "xs" : "m"} gap={gap} style={{ backgroundColor: well }}>
      {children}
    </Box>
  );
}

export function CheckRow({ value, onChange, label }: { value: boolean; onChange: (value: boolean) => void; label: string }) {
  return <Checkbox value={value} onChange={onChange} label={label} labelSize="small" />;
}

const PROMPT_INPUT_DELAY_MS = 500;

export function usePromptInputGuard(promptKey: string | number | null | undefined) {
  const visibleAt = useRef(Number.POSITIVE_INFINITY);
  const lastInputAt = useRef(0);
  useLayoutEffect(() => {
    watchWindowActivation();
    visibleAt.current = promptKey == null ? Number.POSITIVE_INFINITY : Date.now() + duration.base;
  }, [promptKey]);
  return useCallback(
    <A extends unknown[]>(action: (...args: A) => void) =>
      (...args: A) => {
        const now = Date.now();
        const previousInputAt = lastInputAt.current;
        lastInputAt.current = now;
        const settledAt = Math.max(visibleAt.current, windowActivatedAt()) + PROMPT_INPUT_DELAY_MS;
        if (now < settledAt || now - previousInputAt < PROMPT_INPUT_DELAY_MS) return;
        action(...args);
      },
    [],
  );
}
