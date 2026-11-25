import { donorsFrom, type Donor } from "../data/donors.ts";

export const LIVE_FETCH_TIMEOUT_MS = 4000;
export const LIVE_REFRESH_MS = 10 * 60 * 1000;

interface ListElement {
  hidden: boolean;
  replaceChildren(...nodes: unknown[]): void;
}
interface DocumentLike {
  createElement(tag: "li"): { className: string; textContent: string | null };
  visibilityState?: string;
  addEventListener?(type: "visibilitychange", listener: () => void): void;
}

export function renderDonors(list: ListElement, empty: { hidden: boolean }, donors: readonly Donor[], doc: DocumentLike) {
  list.replaceChildren(
    ...donors.map((donor) => {
      const item = doc.createElement("li");
      item.className = `name ${donor.tier}`;
      item.textContent = donor.name;
      return item;
    }),
  );
  list.hidden = donors.length === 0;
  empty.hidden = donors.length > 0;
}

export async function liveDonors(url: string, fetchImpl: typeof fetch = fetch): Promise<Donor[] | null> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return donorsFrom(await res.json());
  } catch {
    return null;
  }
}

interface PageEvents {
  addEventListener(type: "pagehide" | "pageshow", listener: (event: Event) => void): void;
  setInterval?(handler: () => void, ms: number): unknown;
}

export function mountLiveDonors({
  page,
  list,
  empty,
  url,
  doc,
  fetchImpl = fetch,
}: {
  page: PageEvents;
  list: ListElement;
  empty: { hidden: boolean };
  url: string;
  doc: DocumentLike;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  let generation = 0;
  const load = async () => {
    const mine = ++generation;
    const donors = await liveDonors(url, fetchImpl);
    if (mine === generation) renderDonors(list, empty, donors ?? [], doc);
  };
  page.addEventListener("pagehide", () => {
    generation++;
    renderDonors(list, empty, [], doc);
  });
  page.addEventListener("pageshow", (event) => {
    if ((event as Event & { persisted?: boolean }).persisted) void load();
  });
  doc.addEventListener?.("visibilitychange", () => {
    if (doc.visibilityState === "visible") void load();
  });
  page.setInterval?.(() => {
    if (doc.visibilityState !== "hidden") void load();
  }, LIVE_REFRESH_MS);
  return load();
}
