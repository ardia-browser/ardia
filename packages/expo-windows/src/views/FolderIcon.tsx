import { forwardRef } from "react";
import type { FolderIconProps } from "@ardia/shell";
import { StyleSheet } from "react-native";
import { Symbol } from "../symbol/Symbol";
import { folderSymbolFor } from "./folderSymbol";
import { colorOrUndefined } from "./shared";

export const FolderIcon = forwardRef<unknown, FolderIconProps>(function FolderIcon({ open, stroke, face: _face, insideTop: _insideTop, insideBottom: _insideBottom, style, ...rest }, ref) {
  const { name, size } = folderSymbolFor(open === true, StyleSheet.flatten(style)?.width);
  return <Symbol {...rest} ref={ref} name={name} size={size} weight="medium" color={colorOrUndefined(stroke)} style={style} />;
});
