import { DOWNLOADS_BUTTON_TEST_ID } from "../../browser/src/components/downloads/downloadsButtonId";

const SECONDARY_BUTTON = 2;

type Press = Pick<Event, "target"> & { button?: number };

type Closest = { closest: (selector: string) => unknown };

const canSearchAncestors = (target: unknown): target is Closest => !!target && typeof (target as Closest).closest === "function";

export const pressOpensDownloadsMenu = (event: Press): boolean =>
  event.button === SECONDARY_BUTTON && canSearchAncestors(event.target) && !!event.target.closest(`[data-testid="${DOWNLOADS_BUTTON_TEST_ID}"]`);
