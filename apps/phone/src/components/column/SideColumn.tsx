import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { columnCenterX, columnContentLeft, columnContentWidth, SCREEN_COLUMN, useScreenLayout, type ScreenColumn } from "../../state/app/screenLayout";

export const useColumn = (): ScreenColumn | null => useScreenLayout((state) => (state.layout.name === "column" ? state.layout.column : null));

export const columnContentFrame = (column: ScreenColumn, width: number) => {
  const left = columnContentLeft(column);
  const contentWidth = columnContentWidth(column, width);
  return { left, right: Math.max(width - left - contentWidth, 0), width: contentWidth };
};

export const columnPadding = (column: ScreenColumn) => (column.edge === "leading" ? { left: column.inset } : { right: column.inset });

export const columnFieldCenterY = () => SCREEN_COLUMN.top + SCREEN_COLUMN.button * 1.5 + SCREEN_COLUMN.spacing;

export const columnMenuPlace = (column: ScreenColumn, width: number, top: number) => {
  const away = SCREEN_COLUMN.button / 2 + SCREEN_COLUMN.spacing;
  const centerX = columnCenterX(column, width);
  return column.edge === "trailing" ? { top, right: width - centerX + away } : { top, left: centerX + away };
};

export function SideColumn({ column, width, testID, children }: { column: ScreenColumn; width: number; testID: string; children: ReactNode }) {
  return (
    <View testID={testID} pointerEvents="box-none" style={[styles.stack, { left: columnCenterX(column, width) - SCREEN_COLUMN.button / 2 }]}>
      {children}
    </View>
  );
}

export function ColumnContent({ column, width, clips = false, children }: { column: ScreenColumn | null; width: number; clips?: boolean; children: ReactNode }) {
  if (!column) return children;
  return (
    <View testID="columnContent" pointerEvents="box-none" style={[styles.content, columnContentFrame(column, width), clips ? styles.clipped : null]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { position: "absolute", top: SCREEN_COLUMN.top, width: SCREEN_COLUMN.button, gap: SCREEN_COLUMN.spacing, alignItems: "center" },
  content: { position: "absolute", top: 0, bottom: 0 },
  clipped: { overflow: "hidden" },
});
