import { View } from "react-native";
import { closeSettingsSheet, showSettingsSheet } from "../../state/settings/sheet";
import { addPasswordManager, useManagerCatalogue, type CatalogueEntry } from "../../state/vaults/managerCatalogue";
import { Button, Dialog, DialogActions, DialogTitle, Divider, Group, Text, space } from "../ui";
import { BrandBadge } from "./VaultParts";

export const showAddManagerSheet = (onReady: (provider: string) => void) => showSettingsSheet(<AddManagerSheet onReady={onReady} />);

function AddManagerSheet({ onReady }: { onReady: (provider: string) => void }) {
  const catalogue = useManagerCatalogue();
  const add = (entry: CatalogueEntry) => {
    closeSettingsSheet();
    void addPasswordManager(entry, onReady);
  };
  return (
    <Dialog width="s" onDismiss={closeSettingsSheet} onSubmit={closeSettingsSheet} animated>
      <DialogTitle>Add Password Manager</DialogTitle>
      <View style={LIST}>
        <Group>
          <View>
            {catalogue.map((entry, i) => (
              <View key={entry.name}>
                {i > 0 ? <Divider thick inset="l" /> : null}
                <View style={ROW}>
                  <BrandBadge provider={entry.name} size="m" symbol={entry.icon || undefined} accent={entry.accent} />
                  <Text style={TITLE} lines={1}>
                    {entry.title}
                  </Text>
                  <Button title={entry.state === "installed" ? "Turn On" : "Add"} label={`Add ${entry.title}`} onPress={() => add(entry)} />
                </View>
              </View>
            ))}
          </View>
        </Group>
      </View>
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
      </DialogActions>
    </Dialog>
  );
}

const LIST = { marginTop: space.xl } as const;
const ROW = { flexDirection: "row", alignItems: "center", gap: space.l, paddingHorizontal: space.l, paddingVertical: space.m, minHeight: 44 } as const;
const TITLE = { flex: 1 } as const;
