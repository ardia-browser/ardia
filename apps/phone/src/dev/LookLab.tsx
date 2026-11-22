import { DeckBackdrop, FilmGrain, Frost, FrostSource, INCOGNITO_LOOK, labLog, lookBudget, lookIsNative, lookLab, PageView, ProfileBackdrop, type FrostVariant } from "@ardia/phone-native";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

const LOOKS = [
  { label: "plum", color: "plum", themeColors: [] as string[] },
  { label: "green", color: "green", themeColors: [] as string[] },
  { label: "green, blue-violet theme", color: "green", themeColors: ["#4F7CFF", "#9B6BFF"] },
  { label: "orange", color: "orange", themeColors: [] as string[] },
  { label: "incognito", color: INCOGNITO_LOOK, themeColors: [] as string[] },
];

const PAGE_URL = "https://en.wikipedia.org/wiki/Hippopotamus";

const VARIANTS: FrostVariant[] = ["bar", "sheet", "glass", "thin"];

const BLOB_RATES = [0, -1, 30, 20];

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function LookLab() {
  const [lookIndex, setLookIndex] = useState(0);
  const [dark, setDark] = useState(false);
  const [still, setStill] = useState(false);
  const [variant, setVariant] = useState(0);
  const [pageFrost, setPageFrost] = useState<"live" | "solid">("solid");
  const [faded, setFaded] = useState(false);
  const [lookOff, setLookOff] = useState(() => lookLab.lookIsOff());
  const [blobRate, setBlobRate] = useState(() => lookLab.blobFramesPerSecond());
  const [budget, setBudget] = useState(() => lookBudget.describe());
  const [blurOverBackdrop, setBlurOverBackdrop] = useState(() => lookLab.blurOverBackdrop());
  const [backdropDraw, setBackdropDraw] = useState(() => lookLab.backdropDraw());
  const [deckLayers, setDeckLayers] = useState(() => lookLab.deckLayers());
  const budgetAction = (run: () => void) => {
    run();
    const now = lookBudget.describe();
    labLog(`PAGELAB look budget ${now}`);
    setBudget(now);
  };
  const look = LOOKS[lookIndex]!;
  const alwaysDark = look.color === INCOGNITO_LOOK;
  const drawsDark = dark || alwaysDark;
  const ink = drawsDark ? "#fff" : "#1d1a17";
  return (
    <View style={styles.panel}>
      <Text style={styles.title}>Look (native {String(lookIsNative())})</Text>
      <View style={styles.row}>
        <Button label={`Look ${look.label}`} onPress={() => setLookIndex((index) => (index + 1) % LOOKS.length)} />
        <Button
          label={alwaysDark ? `Dark (incognito; asked ${dark ? "dark" : "light"})` : dark ? "Dark" : "Light"}
          onPress={() => {
            const next = !dark;
            labLog(`PAGELAB look lab asked ${next ? "dark" : "light"}, ${next || alwaysDark ? "dark" : "light"} will be drawn (look ${look.color})`);
            setDark(next);
          }}
        />
        <Button label={still ? "Reduce motion" : "Moving"} onPress={() => setStill((on) => !on)} />
        <Button label={`Frost ${VARIANTS[variant]}`} onPress={() => setVariant((index) => (index + 1) % VARIANTS.length)} />
        <Button label={faded ? "Fades out" : "No fade"} onPress={() => setFaded((on) => !on)} />
        <Button label={`Page frost ${pageFrost}`} onPress={() => {
          const next = pageFrost === "live" ? "solid" : "live";
          lookLab.setPageFrost(next);
          setPageFrost(next);
        }} />
        <Button label="Probe frost" onPress={() => lookLab.probeFrosts()} />
        <Button label={lookOff ? "Look off" : "Look on"} onPress={() => setLookOff(lookLab.setLookOff(!lookOff) ?? lookOff)} />
        <Button
          label={blobRate === 0 ? "Blobs paced" : blobRate === -1 ? "Blobs every frame" : `Blobs ${blobRate} fps`}
          onPress={() => setBlobRate(lookLab.setBlobFramesPerSecond(BLOB_RATES[(BLOB_RATES.indexOf(blobRate) + 1) % BLOB_RATES.length]!) ?? blobRate)}
        />
      </View>
      <Text style={styles.caption}>Look budget: {budget}. A change applies from the next time the deck is built.</Text>
      <View style={styles.row}>
        <Button
          label={`Backdrop: ${backdropDraw === "small" ? "small image" : backdropDraw === "smallnograin" ? "small, no grain" : backdropDraw === "full" ? "full size" : "flat colour"}`}
          onPress={() => {
            const next = backdropDraw === "small" ? "smallnograin" : backdropDraw === "smallnograin" ? "full" : backdropDraw === "full" ? "flat" : "small";
            setBackdropDraw(lookLab.setBackdropDraw(next) ?? backdropDraw);
          }}
        />
        <Button label={deckLayers ? "Deck layers: on" : "Deck layers: off"} onPress={() => setDeckLayers(lookLab.setDeckLayers(!deckLayers) ?? deckLayers)} />
        <Button
          label={blurOverBackdrop ? "Bar frosts: blur" : "Bar frosts: tinted fill"}
          onPress={() => setBlurOverBackdrop(lookLab.setBlurOverBackdrop(!blurOverBackdrop) ?? blurOverBackdrop)}
        />
        <Button label="Budget: force full" onPress={() => budgetAction(() => lookBudget.force("full"))} />
        <Button label="Budget: force degraded" onPress={() => budgetAction(() => lookBudget.force("degraded"))} />
        <Button label="Budget: measured" onPress={() => budgetAction(() => lookBudget.force(null))} />
        <Button label="Budget: reset" onPress={() => budgetAction(() => lookBudget.reset())} />
      </View>
      <View style={styles.stage}>
        <FrostSource name="lab" style={StyleSheet.absoluteFill}>
          <DeckBackdrop style={StyleSheet.absoluteFill} color={look.color} themeColors={look.themeColors} dark={dark} reduceMotion={still} />
          <Text style={[styles.stageText, { color: ink }]}>The deck's mesh, blobs and grain. The frost below blurs this.</Text>
        </FrostSource>
        <Frost source="lab" name="lab-bar" variant={VARIANTS[variant]} color={look.color} themeColors={look.themeColors} dark={dark} cornerRadius={14} style={styles.frost}>
          <Text style={{ color: ink }}>Frosted {VARIANTS[variant]}</Text>
        </Frost>
      </View>
      <View style={styles.pair}>
        <ProfileBackdrop style={styles.tile} color={look.color} themeColors={look.themeColors} dark={dark} themed />
        <ProfileBackdrop style={styles.tile} color={look.color} themeColors={look.themeColors} dark={dark} softened fadesOut={faded} />
        <FilmGrain style={[styles.tile, { backgroundColor: dark ? "#2a2a2c" : "#e8e4f0" }]} opacity={0.2} />
      </View>
      <Text style={styles.note}>A sheet frost over a live page: scroll the page; the frost should follow it, not stay black or frozen.</Text>
      <View style={styles.pageStage}>
        <FrostSource name="lab-page" style={StyleSheet.absoluteFill}>
          <PageView style={StyleSheet.absoluteFill} pageId="lab-look-page" initialUrl={PAGE_URL} />
        </FrostSource>
        <Frost source="lab-page" name="lab-page-sheet" variant="sheet" color={look.color} themeColors={look.themeColors} dark={dark} cornerRadius={14} style={styles.pageFrost} pointerEvents="none">
          <Text style={{ color: ink }}>Sheet frost over the page</Text>
        </Frost>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { backgroundColor: "#eeeae2", padding: 6, borderRadius: 6, gap: 6 },
  title: { fontSize: 13, fontWeight: "700", color: "#1d1a17" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  caption: { fontSize: 12, color: "#555" },
  button: { backgroundColor: "#ddd6c9", paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  buttonText: { fontSize: 13, color: "#1d1a17" },
  stage: { height: 220, borderRadius: 10, overflow: "hidden" },
  stageText: { fontSize: 13, padding: 10 },
  pair: { flexDirection: "row", gap: 6 },
  tile: { flex: 1, height: 70, borderRadius: 8, overflow: "hidden" },
  note: { fontSize: 11, color: "#1d1a17" },
  pageStage: { height: 320, borderRadius: 10, overflow: "hidden" },
  pageFrost: { position: "absolute", left: 12, right: 12, bottom: 12, height: 90, justifyContent: "center", alignItems: "center" },
  frost: { position: "absolute", left: 16, right: 16, bottom: 16, height: 56, justifyContent: "center", alignItems: "center" },
});
