import { defineDomain } from "../define.ts";

export const autofill = defineDomain({
  kind: "engine",
  imports: {
    "../../autofill": ["AddressInput", "SavedAddress", "SavedCard"],
    "../wire": ["Profile"],
  },
  calls: {
    settings: {
      args: "Profile",
      result: "{ addresses: boolean; cards: boolean }",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
    setSettings: {
      args: "Profile & { addresses?: boolean; cards?: boolean }",
      result: "null",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
    addresses: {
      args: "Profile",
      result: "{ addresses: SavedAddress[] }",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
    saveAddress: {
      args: "Profile & { address: AddressInput }",
      result: "{ id: string }",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
    cards: {
      args: "Profile",
      result: "{ cards: SavedCard[] }",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
    remove: {
      args: "Profile & { id: string }",
      result: "{ ok: true }",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
    cardNumber: {
      args: "Profile & { id: string }",
      result: "{ number?: string | null }",
      desktop: "custom",
      mac: "custom",
      windows: "custom",
    },
    showSuggestions: {
      args: "{ tabId: string; passwords: boolean }",
      result: "boolean",
      desktop: "custom",
      mac: "custom",
      windows: "absent",
    },
  },
  events: {},
});
