import { useEffect, useState } from "react";
import { deliveredLines, nextAgeChange, type DeliveredItem } from "../../state/vaults/deliveredCodesModel";
import { Text } from "../ui";
import type { Ink } from "./VaultRows";

const SHRINKS = { flexShrink: 1, minWidth: 0 } as const;

type DeliveredCode = DeliveredItem["delivered"];

export function DeliveredDetail({ code, now, page, ink }: { code: DeliveredCode; now: number; page: string; ink: Ink }) {
  const { from, age } = deliveredLines(code, now, page);
  return (
    <>
      <Text lines={1} size="caption" color={ink.detail} style={SHRINKS}>
        {from}
      </Text>
      <Text lines={1} size="caption" color={ink.detail}>
        {` · ${age}`}
      </Text>
    </>
  );
}

export function useAgeClock(receivedAt: number, ticking: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setTimeout(() => setNow(Date.now()), nextAgeChange(receivedAt, Date.now()));
    return () => clearTimeout(timer);
  }, [receivedAt, ticking, now]);
  return now;
}

