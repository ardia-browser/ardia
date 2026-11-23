import { useEffect } from "react";
import { useProfile } from "../../state/browser/hooks";
import { chooseProfileIcon, closeProfileIconPicker, closeProfileIconPickerIfShown, useProfileIconPicker, type ProfileIconPicker as Picker } from "../../state/profiles/iconPicker";
import { IconPickerLayer, nearAnchor } from "../iconPicker/IconPickerPanel";
import { usePopoverPresenceOf } from "../ui";
import { PROFILE_SYMBOLS } from "./ProfileIcons";

export function ProfileIconPicker({ windowId }: { windowId: string }) {
  const { shown: picker, closing, onClosed } = usePopoverPresenceOf(useProfileIconPicker((s) => (s.picker?.windowId === windowId ? s.picker : null)));
  return picker ? <PickerFor key={picker.profileId} picker={picker} closing={closing} onClosed={onClosed} /> : null;
}

function PickerFor({ picker, closing, onClosed }: { picker: Picker; closing: boolean; onClosed: () => void }) {
  const current = useProfile(picker.profileId, (p) => (p ? (p.icon ?? null) : undefined));
  const gone = current === undefined;
  useEffect(() => {
    if (gone) closeProfileIconPickerIfShown(picker);
    if (gone && closing) onClosed();
  }, [gone, picker, closing]);
  if (gone) return null;
  return (
    <IconPickerLayer
      current={current}
      symbols={PROFILE_SYMBOLS}
      actions={[
        {
          title: "No Icon",
          icon: picker.place === "sidebar" ? "circle.fill" : "textformat",
          primary: !current,
          onPress: () => chooseProfileIcon(picker, null),
        },
      ]}
      onChoose={(icon) => chooseProfileIcon(picker, icon)}
      onClose={closeProfileIconPicker}
      closing={closing}
      onClosed={onClosed}
      placeIn={nearAnchor(picker.anchor)}
    />
  );
}
