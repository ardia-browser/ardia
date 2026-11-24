import { labLog, CompletingField, completingFieldIsNative, type CompletingFieldHandle, type CompletionOffer } from "@ardia/phone-native";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

const CANDIDATES = ["google.com", "github.com", "gmail.com", "wikipedia.org", "ardia.dev", "news.ycombinator.com"];

const offerFor = (typed: string): CompletionOffer | null => {
  if (!typed) return null;
  const lower = typed.toLowerCase();
  const match = CANDIDATES.find((candidate) => candidate.startsWith(lower));
  return { query: typed, completion: match ?? typed };
};

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function CompletionLab({ note }: { note: (line: string) => void }) {
  const field = useRef<CompletingFieldHandle>(null);
  const [typed, setTyped] = useState("");
  const [suffix, setSuffix] = useState("");
  const [offer, setOffer] = useState<CompletionOffer | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const say = (line: string) => {
    labLog(`PAGELAB completion ${line}`);
    note(`completion ${line}`);
  };
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Completion (native {String(completingFieldIsNative())})</Text>
      <CompletingField
        ref={field}
        style={styles.field}
        text={typed}
        offer={offer}
        highlightColor="rgba(0, 122, 255, 0.3)"
        placeholder="Type goo, gi, wi…"
        placeholderTextColor="#8a8580"
        color="#1d1a17"
        fontSize={18}
        keyboardType="url"
        returnKeyType="go"
        autoCorrect={false}
        autoCapitalize="none"
        accessibilityLabel="Completion lab field"
        onTypedChange={(next) => {
          setTyped(next);
          setOffer(offerFor(next));
        }}
        onSuffixChange={setSuffix}
        onFocusChange={(focused) => say(`focus ${focused}`)}
        onSubmit={(displayed) => {
          setSubmitted(displayed);
          say(`submit "${displayed}"`);
        }}
      />
      <Text style={styles.line}>
        typed "{typed}" · suffix "{suffix}" · submitted {submitted === null ? "-" : `"${submitted}"`}
      </Text>
      <View style={styles.row}>
        <Button label="Focus" onPress={() => field.current?.focus()} />
        <Button label="Blur" onPress={() => field.current?.blur()} />
        <Button label="Set ardia.dev" onPress={() => field.current?.setText("ardia.dev", true)} />
        <Button label="Clear" onPress={() => field.current?.setText("", false)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: "#e4ecf2", padding: 6, borderRadius: 6, gap: 4 },
  title: { fontSize: 13, fontWeight: "700", color: "#1d1a17" },
  field: { height: 44, backgroundColor: "#ffffff", borderRadius: 10, paddingHorizontal: 10 },
  line: { fontSize: 11, color: "#1d1a17" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  button: { backgroundColor: "#c6d6e0", paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  buttonText: { fontSize: 13, color: "#1d1a17" },
});
