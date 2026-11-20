export type EmptyAnnouncement = { say: string | null; announced: string | null };

export function emptyAnnouncement(announced: string | null, empty: string | null, hasRows: boolean): EmptyAnnouncement {
  if (hasRows) return { say: null, announced: null };
  if (empty && empty !== announced) return { say: empty, announced: empty };
  return { say: null, announced };
}
