import { labLog, legacyImport, legacyLab } from "@ardia/phone-native";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

const VISIT_PAGE = 1000;

const failure = (error: unknown) => {
  const coded = error as { code?: string; message?: string };
  return coded.code ?? coded.message ?? "error";
};

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function UpgradeLab({ note }: { note: (line: string) => void }) {
  const [lines, setLines] = useState<string[]>([]);

  const say = useCallback(
    (line: string) => {
      labLog(`PAGELAB upgrade ${line}`);
      note(`upgrade ${line}`);
      setLines((all) => [...all, line].slice(-12));
    },
    [note],
  );

  const readSource = useCallback(() => {
    const started = Date.now();
    legacyImport.source().then(
      (source) => say(`source ${JSON.stringify(source)} in ${Date.now() - started} ms`),
      (error) => say(`source ✗ ${failure(error)}`),
    );
  }, [say]);

  const readAll = useCallback(async () => {
    const started = Date.now();
    try {
      const read = await legacyImport.read();
      const withState = [...read.tabs, ...read.archive].filter((tab) => tab.savedState).length;
      const thumbnails = [...read.tabs, ...read.archive].filter((tab) => tab.snapshotPath).length;
      const selected = read.tabs.findIndex((tab) => tab.id === read.selectedTabId);
      say(
        `read tabs ${read.tabs.length} archive ${read.archive.length} states ${withState} thumbnails ${thumbnails} selected #${selected} in ${Date.now() - started} ms`,
      );
      say(`preferences ${Object.keys(read.preferences).sort().join(", ") || "none"}`);
      let visits = 0;
      let pages = 0;
      let after: number | null = 0;
      const visitsStarted = Date.now();
      while (after !== null) {
        const page = await legacyImport.readVisits(after, VISIT_PAGE);
        visits += page.visits.length;
        pages += 1;
        after = page.next;
      }
      say(`visits ${visits} in ${pages} pages, ${Date.now() - visitsStarted} ms`);
    } catch (error) {
      say(`read ✗ ${failure(error)}`);
    }
  }, [say]);

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Upgrade import (reads only, plus a failure switch)</Text>
      <Text style={styles.line}>{lines.length ? lines.join("\n") : "nothing read yet"}</Text>
      <View style={styles.row}>
        <Button label="Read source" onPress={readSource} />
        <Button label="Read everything" onPress={() => void readAll()} />
        <Button label="Make source unusable" onPress={() => say(legacyLab.setUnusable(true) ? "source reports unusable (io) until made usable again; Compose files untouched" : "not in this build")} />
        <Button label="Make source usable" onPress={() => say(legacyLab.setUnusable(false) ? "source reads the old app's data again" : "not in this build")} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: "#f2ece4", padding: 6, borderRadius: 6, gap: 4 },
  title: { fontSize: 13, fontWeight: "700", color: "#1d1a17" },
  line: { fontSize: 11, color: "#1d1a17" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  button: { backgroundColor: "#e0d6c6", paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  buttonText: { fontSize: 13, color: "#1d1a17" },
});
