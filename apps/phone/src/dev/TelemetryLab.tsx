import { labLog, system } from "@ardia/phone-native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { usageToday } from "../state/telemetry/telemetry";

type Reading = { day: string | null; counts: string; sharing: boolean; pending: string; consent: string };

const pairs = (counts: Record<string, number | undefined>) =>
  Object.entries(counts)
    .filter(([, value]) => (value ?? 0) > 0)
    .map(([field, value]) => `${field} ${value}`)
    .join(", ") || "none";

function read(): Reading {
  const today = usageToday();
  const consent = system.usageConsent();
  return {
    day: today.day,
    counts: pairs(today.counts),
    sharing: today.sharing,
    pending: pairs(system.peekPendingCounts()),
    consent: consent ? `${consent.sharing ? "on" : "off"}, generation ${consent.generation}` : "not reported",
  };
}

export function TelemetryLab({ note }: { note: (line: string) => void }) {
  const [reading, setReading] = useState<Reading>(read);
  const refresh = useCallback(() => {
    const next = read();
    setReading(next);
    const line = `PAGELAB telemetry day ${next.day ?? "none"} sharing ${next.sharing ? "on" : "off"} | counts ${next.counts} | native pending ${next.pending} | native consent ${next.consent}`;
    labLog(line);
    note(line);
  }, [note]);
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (state) => state === "active" && refresh());
    return () => subscription.remove();
  }, [refresh]);
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Telemetry</Text>
      <Text style={styles.line}>Sharing: {reading.sharing ? "on" : "off"}</Text>
      <Text style={styles.line}>Today ({reading.day ?? "nothing counted"}): {reading.counts}</Text>
      <Text style={styles.line}>Native pending: {reading.pending}</Text>
      <Text style={styles.line}>Native consent: {reading.consent}</Text>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Refresh telemetry" onPress={refresh} style={styles.button}>
          <Text style={styles.buttonText}>Refresh</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: "#e4ecf2", padding: 6, borderRadius: 6, gap: 4 },
  title: { fontSize: 13, fontWeight: "700", color: "#1d1a17" },
  line: { fontSize: 11, color: "#1d1a17" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  button: { backgroundColor: "#c6d6e0", paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  buttonText: { fontSize: 13, color: "#1d1a17" },
});
