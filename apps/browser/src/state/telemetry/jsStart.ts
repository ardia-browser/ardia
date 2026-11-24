export const jsStartedAt = Date.now();

export function firstCommitMs(renderAt: number | undefined, commitAt: number | undefined): number | null {
  if (renderAt === undefined || commitAt === undefined) return null;
  const took = commitAt - renderAt;
  return took >= 0 && took < 60_000 ? Math.round(took) : null;
}
