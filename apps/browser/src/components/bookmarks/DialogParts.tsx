import { type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { FolderTree } from "./FolderTree";
import { folderPicker } from "./tokens";

export function FolderPicker({ profileId, selectedId, onSelect, footer }: { profileId: string | null; selectedId: string | null; onSelect: (id: string) => void; footer?: ReactNode }) {
  return (
    <View style={FRAME}>
      <ScrollView style={LIST}>
        {profileId && <FolderTree profileId={profileId} selectedId={selectedId} onSelect={onSelect} rowHeight={folderPicker.row} rowGap={folderPicker.rowGap} look="soft" />}
      </ScrollView>
      {footer}
    </View>
  );
}

const FRAME = { gap: folderPicker.rowGap } as const;
const LIST = { flexGrow: 0, maxHeight: (folderPicker.row + folderPicker.rowGap) * folderPicker.shownRows } as const;
