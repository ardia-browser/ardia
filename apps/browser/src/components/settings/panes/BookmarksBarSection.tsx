import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import type { Settings } from "../../../state/settings/settings";
import { PopUp, type Option } from "../../ui";
import { Group, Row } from "../Form";
import { t } from "../../../lib/uiLanguage";


type BookmarksBarChoice = Settings["bookmarksBar"] | "hidden";

const BOOKMARKS_BAR_CHOICES: Option<BookmarksBarChoice>[] = [
  { value: "always", title: t(`Always`) },
  { value: "newTab", title: t(`On new tabs`) },
  { value: "never", title: t(`Never`) },
  { value: "hidden", title: t(`Hide bookmarks entirely`) },
];

export function BookmarksBarRow() {
  const shown = useSettings((s) => s.showBookmarks);
  const mode = useSettings((s) => s.bookmarksBar);
  return (
    <Row anchor="appearance.bookmarksBar">
      <PopUp
        value={shown ? mode : "hidden"}
        options={BOOKMARKS_BAR_CHOICES}
        onChange={(v) => updateSettings(v === "hidden" ? { showBookmarks: false } : { showBookmarks: true, bookmarksBar: v })}
        minWidth={190}
      />
    </Row>
  );
}

export function BookmarksBarSection() {
  return (
    <Group>
      <BookmarksBarRow />
    </Group>
  );
}
