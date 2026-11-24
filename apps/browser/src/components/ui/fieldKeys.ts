import { useMemo } from "react";

type ExtraKey = { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean };

export type ExtraKeyProps = { extraKeys?: readonly ExtraKey[]; onExtraKey?: (pressed: ExtraKey) => boolean };

export function useKeyDownEvents(base: readonly ExtraKey[] | undefined, extra: readonly ExtraKey[] | undefined): ExtraKey[] | undefined {
  return useMemo(() => (extra?.length ? [...(base ?? []), ...extra] : base ? [...base] : undefined), [base, extra]);
}
