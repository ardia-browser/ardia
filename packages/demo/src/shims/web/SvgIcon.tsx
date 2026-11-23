import { View, type ViewProps } from "react-native";

export type SvgIconProps = ViewProps & {
  svg: string;
  color?: string;
};

export function SvgIcon({ svg, color, style, ...props }: SvgIconProps) {
  const inline = svg.trimStart().startsWith("<");
  if (inline) {
    const markup = svg.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => `<svg${attrs.replace(/\b(?:width|height)="[^"]*"/g, "")} width="100%" height="100%">`);
    return (
      <View pointerEvents="none" {...props} style={style}>
        <span
          aria-hidden
          style={{ width: "100%", height: "100%", display: "flex", color: color ?? "currentColor", pointerEvents: "none" }}
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      </View>
    );
  }
  const mask = `url("${svg}") center / contain no-repeat`;
  return (
    <View pointerEvents="none" {...props} style={style}>
      <div
        aria-hidden
        style={{ width: "100%", height: "100%", backgroundColor: color ?? "currentColor", mask, WebkitMask: mask, pointerEvents: "none" }}
      />
    </View>
  );
}
