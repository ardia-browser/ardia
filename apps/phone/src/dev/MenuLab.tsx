import { actionSheet, ContextMenuView, labLog, nativeMenusAvailable, type MenuItem } from "@ardia/phone-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

const CARD_MENU: MenuItem[] = [
  { id: "copy", title: "Copy Link" },
  { id: "share", title: "Share" },
  { id: "send", title: "Send to Device", children: [
    { id: "send-mac", title: "Studio Mac", systemImage: "laptopcomputer" },
    { id: "send-phone", title: "Pixel", systemImage: "iphone" },
  ] },
  { id: "pin", title: "Pin to Mac" },
  { id: "move", title: "Move to Space", children: [
    { id: "move-work", title: "Work", systemImage: "briefcase" },
    { id: "move-home", title: "Home", systemImage: "house" },
  ] },
  { id: "close-group", title: "", inline: true, children: [{ id: "close", title: "Close Tab", destructive: true }] },
];

const LIBRARY_MENU: MenuItem[] = [{ id: "delete-all", title: "Delete All Downloads", destructive: true }];

export function MenuLab({ note }: { note: (line: string) => void }) {
  const [events, setEvents] = useState<string[]>([]);
  const said = (line: string) => {
    setEvents((shown) => [...shown, line].slice(-4));
    labLog(`PAGELAB menus ${line}`);
    note(line);
  };
  const confirm = async () => {
    const answer = await actionSheet({
      title: "Delete All Downloads?",
      message: "This deletes every downloaded file from this iPhone.",
      actions: [{ id: "delete", title: "Delete All Downloads", destructive: true }, { id: "cancel", title: "Cancel", cancel: true }],
    });
    said(`sheet ${answer ?? "dismissed"}`);
  };
  return (
    <View style={styles.panel}>
      <Text style={styles.status}>native menus {JSON.stringify(nativeMenusAvailable())}</Text>
      <Text style={styles.status} accessibilityLabel={`menu events ${events.join(", ")}`}>menu events {events.join(", ")}</Text>
      <ContextMenuView
        items={CARD_MENU}
        onSelect={(id) => said(`card ${id}`)}
        onOpen={() => said("card open")}
        onClose={() => said("card close")}
        style={styles.card}
        accessibilityLabel="Menu card"
      >
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Page 1</Text>
        </View>
      </ContextMenuView>
      <View style={styles.row}>
        <ContextMenuView items={LIBRARY_MENU} trigger="tap" fixedOrder onSelect={(id) => (id === "delete-all" ? void confirm() : said(id))} onOpen={() => said("more open")} onClose={() => said("more close")} style={styles.more}>
          <Text style={styles.buttonText}>More</Text>
        </ContextMenuView>
        <Pressable accessibilityRole="button" accessibilityLabel="Action sheet" onPress={() => void confirm()} style={styles.more}>
          <Text style={styles.buttonText}>Action sheet</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: 10, paddingVertical: 8 },
  status: { fontSize: 12, color: "#444" },
  card: { width: 160, height: 220, borderRadius: 20, overflow: "hidden", backgroundColor: "#fff", borderWidth: StyleSheet.hairlineWidth, borderColor: "#ccc" },
  cardHeader: { height: 70, backgroundColor: "#3b5b8f", justifyContent: "flex-end", padding: 10 },
  cardTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
  row: { flexDirection: "row", gap: 10 },
  more: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: "#e8e8ee" },
  buttonText: { fontSize: 14, color: "#111" },
});
