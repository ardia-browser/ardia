import type { Plugin } from "vite";
import { rewordWith, wordingPlugin, type Wording } from "./credentialWording";

export const SYNC_WORDING: readonly Wording[] = [
  {
    file: "components/settings/panes/SyncSection.tsx",
    replacements: [
      [
        `            icon={<Symbol name="exclamationmark.icloud" size={14} color={theme.warning} style={WARNING_ICON} />}
            title={\`\${PLATFORM_TERMS.cloudDrive} is off on this \${PLATFORM_TERMS.computer}\`}
            description={\`\${PLATFORM_TERMS.turnOnCloudDrive}, or pick any folder that syncs, like Dropbox.\`}
          >
            {PLATFORM_TERMS.cloudDriveSettingsUrl ? <Button title="Open iCloud Settings" onPress={() => void Linking.openURL(PLATFORM_TERMS.cloudDriveSettingsUrl)} /> : null}
`,
        `            icon={<Symbol name="exclamationmark.triangle.fill" size={13} color={theme.warning} style={WARNING_ICON} />}
            title="The default sync folder’s location is missing"
            description="Choose a folder that syncs between your computers, like one that Syncthing, Nextcloud or Dropbox keeps in sync, or one on a NAS or a USB drive."
          >
`,
      ],
      ["title: `Show Sync Folder in ${PLATFORM_TERMS.fileManager}`", `title: "Open Sync Folder"`],
    ],
  },
  {
    file: "components/settings/panes/SyncSheets.tsx",
    replacements: [
      ["  useEffect(() => void recoveryKitPreview(168)?.then(setPreview), []);\n", ""],
      [
        "  const more = async () => {\n    const choice = await showMenu([\n      { id: \"copy\", title: \"Copy\", symbol: \"doc.on.doc\" },\n      ...(PLATFORM_FEATURES.sharesFiles ? [{ id: \"share\", title: \"Share…\", symbol: \"square.and.arrow.up\" }] : []),\n      { separator: true },\n      { id: \"text\", title: \"Save as Text…\", symbol: \"doc.plaintext\" },\n    ]);\n    if (choice === \"copy\") await copyRecoveryKit();\n    else if (choice === \"share\") await shareRecoveryKit();\n    else if (choice === \"text\") await save(\"text\");\n  };\n",
        "",
      ],
      [
        `subtitle="Your Recovery Kit contains all you need to recover your data should you lose access to this device."`,
        `subtitle="Your Recovery Kit is a text file with all you need to recover your data should you lose access to this device. It holds your recovery phrase, so keep it private."`,
      ],
      [`Saved to {saved.replace(/^\\/Users\\/[^/]+/, "~")}.`, `Saved to {saved.replace(/^\\/home\\/[^/]+/, "~")}.`],
      [
        `        <View accessibilityLabel="Recovery kit preview" style={[PREVIEW_FRAME(), { borderColor: theme.groupBorder }]}>
          {preview ? <Image source={{ uri: preview }} style={PREVIEW} /> : null}
        </View>
`,
        "",
      ],
      [
        `      <DialogActions leading={<Button title="Other Options" onPress={() => void more()} />}>
        <Button title="Close" onPress={closeSettingsSheet} />
        <Button title="Save…" kind="primary" onPress={() => void save("pdf")} />`,
        `      <DialogActions>
        <Button title="Close" onPress={closeSettingsSheet} />
        <Button title="Save as Text…" kind="primary" onPress={() => void save("text")} />`,
      ],
      ["return `Couldn’t save the sync key in ${PLATFORM_TERMS.secretStore}.`;", `return "Couldn’t save the sync key in your system keyring.";`],
      [
        "On your other ${PLATFORM_TERMS.syncedComputer}, open Ardia › Settings › General › Sync and choose the same sync folder.",
        `On your other device, open Ardia › Settings › General › Sync and choose the same sync folder.`,
      ],
      [
        "Click Show Code. On your iPhone, open Ardia, tap Sync With Mac, and scan the code. For another Mac, you can also scan it with your iPhone’s camera and paste the words there with Universal Clipboard.",
        "Click Show Code, then scan the code with your phone’s camera to copy the words, and type or paste them on your other device.",
      ],
      ["Your data on each ${PLATFORM_TERMS.syncedComputer} stays.", "Your data on each device stays."],
      [
        `  if (folder.inICloud) {
    const rest = folder.path.split("com~apple~CloudDocs")[1]?.split("/").filter(Boolean) ?? [];
    return ["iCloud Drive", ...rest].join(" › ");
  }
  return folder.path.replace(/^\\/Users\\/[^/]+/, "~");`,
        `  return folder.path.replace(/^\\/home\\/[^/]+(?=\\/|$)/, "~");`,
      ],
    ],
  },
  {
    file: "components/settings/rows/generalRows.ts",
    replacements: [
      [`keywords: ["icloud drive", "dropbox", "folder"]`, `keywords: ["syncthing", "nextcloud", "dropbox", "folder"]`],
      [`keywords: ["devices", "computers", "macs", "remove device"]`, `keywords: ["devices", "computers", "remove device"]`],
    ],
  },
  {
    file: "lib/themeLook.ts",
    replacements: [[`export const MONO_FAMILY = "Menlo";`, `export const MONO_FAMILY = "monospace";`]],
  },
  {
    file: "state/sync/engine.ts",
    replacements: [["Enter your recovery phrase to keep syncing on this ${PLATFORM_TERMS.computer}.", "Enter your recovery phrase to keep syncing on this device."]],
  },
];

export function rewordSync(id: string, code: string): string | null {
  return rewordWith(SYNC_WORDING, "syncWording.ts", id, code);
}

export function syncWording(): Plugin {
  return wordingPlugin("ardia-linux:sync-wording", SYNC_WORDING, "syncWording.ts");
}
