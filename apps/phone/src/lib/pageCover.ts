export const PAGE_COVER = { deadlineMs: 4_000, settleMs: 150, fadeMs: 180 } as const;

export type CoverPageState = { isLive: boolean; isLoading: boolean };

export const pageCoverNeeded = (state: CoverPageState | null, hasSnapshot: boolean) =>
  !(state !== null && state.isLive && !state.isLoading && !hasSnapshot);
