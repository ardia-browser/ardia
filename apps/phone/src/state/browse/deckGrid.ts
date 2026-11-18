import { Platform } from "react-native";
import { create } from "zustand";
import { readPreferences, writePreference } from "../store/browserDatabase";
import { browserDatabase } from "../store/database";
import { countUsage } from "../telemetry/telemetry";

export const DECK_GRID_KEY = "tabs.deckGrid";

export const deckGridOffered = () => Platform.OS === "ios";

const useDeckGridStore = create<{ grid: boolean | null }>()(() => ({ grid: null }));

let stored: boolean | null = null;

const storedGrid = () => (stored ??= readPreferences(browserDatabase())[DECK_GRID_KEY] === "true");

export const deckIsGrid = () => useDeckGridStore.getState().grid ?? storedGrid();

export function useDeckGrid(): boolean {
  const grid = useDeckGridStore((s) => s.grid);
  return grid ?? storedGrid();
}

export function setDeckGrid(grid: boolean, counted = true) {
  if (deckIsGrid() === grid) return;
  writePreference(browserDatabase(), DECK_GRID_KEY, String(grid));
  stored = grid;
  useDeckGridStore.setState({ grid });
  if (grid && counted) countUsage("deck_grid_shown");
}

export function forgetDeckGrid() {
  stored = null;
  useDeckGridStore.setState({ grid: null });
}
