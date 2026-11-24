import { StyleSheet } from "react-native";
import type { FolderIconProps } from "@ardia-real/shell";
import { Symbol } from "./Symbol";

const DEFAULT_SIDE = 16;
const POINTS_PER_SIDE = 0.8;

export function FolderIcon({ open, stroke, face: _face, insideTop: _insideTop, insideBottom: _insideBottom, style, ...props }: FolderIconProps) {
  const flat = StyleSheet.flatten(style) ?? {};
  const side = typeof flat.width === "number" ? flat.width : DEFAULT_SIDE;
  return <Symbol {...props} name={open ? "folder.fill" : "folder"} size={side * POINTS_PER_SIDE} weight="medium" color={stroke} style={style} />;
}
