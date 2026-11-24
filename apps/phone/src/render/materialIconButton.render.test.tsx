import { Platform, StyleSheet, View } from "react-native";
import type { ReactTestInstance } from "react-test-renderer";
import { MaterialFindBar } from "../components/browsing/MaterialFindBar";
import { SuggestionRow } from "../components/search/SuggestionRow";
import { DesignProvider, MaterialIconButton, Symbol } from "../components/ui";
import { withAlpha } from "../lib/color";
import { SEEDED_SCHEMES } from "../lib/material/schemes";
import { MATERIAL_STATE, rolesFromScheme } from "../components/ui/materialRoles";
import { materialShape, materialSize } from "../components/ui/materialTokens";
import { renderSurface, unmount, withMaterialYou } from "../../test/render/harness";

withMaterialYou();

const onAndroid = Platform.OS === "android" ? test : test.skip;
const LIGHT = SEEDED_SCHEMES.ardia.light;
const ROLES = rolesFromScheme(LIGHT, false);
const noop = () => undefined;

type Root = ReturnType<typeof renderSurface>;
const pressable = (root: Root, id: string) => root.root.findAll((node) => node.props.testID === id && typeof node.props.onPress === "function" && node.props.android_ripple !== undefined)[0]!;
const pressableByLabel = (root: Root, label: string) => root.root.findAll((node) => node.props.accessibilityLabel === label && typeof node.props.onPress === "function" && node.props.android_ripple !== undefined)[0]!;
const flat = (node: ReactTestInstance | undefined) => StyleSheet.flatten(node?.props.style) ?? {};
const containerOf = (button: ReactTestInstance) => button.findAll((node) => node.type === View && node.props.pointerEvents === "none")[0]!;
const symbolOf = (button: ReactTestInstance) => button.findAll((node) => node.type === Symbol)[0]!;

onAndroid("standard MaterialIconButton enforces a 48dp target, 40dp circular container, and 20dp circular ripple", () => {
  const root = renderSurface(
    <DesignProvider design="material">
      <MaterialIconButton testID="btn" icon="star" label="Bookmark" scheme={LIGHT} onPress={noop} />
    </DesignProvider>,
  );
  const button = pressable(root, "btn");
  expect(flat(button)).toMatchObject({ width: materialSize.touchTarget, height: materialSize.touchTarget, borderRadius: materialShape.full });
  expect(button.props.hitSlop).toBeUndefined();
  expect(button.props.accessibilityRole).toBe("button");
  expect(button.props.accessibilityLabel).toBe("Bookmark");
  expect(button.props.accessibilityState).toEqual({ disabled: false });
  expect(button.props.android_ripple).toEqual({
    color: withAlpha(LIGHT.onSurfaceVariant, MATERIAL_STATE.pressed),
    borderless: true,
    radius: materialSize.iconButton / 2,
  });
  const container = containerOf(button);
  expect(flat(container)).toMatchObject({ width: materialSize.iconButton, height: materialSize.iconButton, borderRadius: materialShape.full });
  expect(flat(container).backgroundColor).toBeUndefined();
  expect(symbolOf(button).props.color).toBe(LIGHT.onSurfaceVariant);
  expect(symbolOf(button).props.size).toBe(materialSize.icon);
  unmount(root);
});

onAndroid("toggleable standard MaterialIconButton switches ink and accessibilityState.selected", () => {
  const unselectedRoot = renderSurface(
    <DesignProvider design="material">
      <MaterialIconButton testID="pin" icon="star" label="Pin" selected={false} scheme={LIGHT} onPress={noop} />
    </DesignProvider>,
  );
  const unselected = pressable(unselectedRoot, "pin");
  expect(unselected.props.accessibilityState).toEqual({ disabled: false, selected: false });
  expect(symbolOf(unselected).props.color).toBe(LIGHT.onSurfaceVariant);
  unmount(unselectedRoot);

  const selectedRoot = renderSurface(
    <DesignProvider design="material">
      <MaterialIconButton testID="pin" icon="starFill" label="Pinned" selected scheme={LIGHT} onPress={noop} />
    </DesignProvider>,
  );
  const selected = pressable(selectedRoot, "pin");
  expect(selected.props.accessibilityState).toEqual({ disabled: false, selected: true });
  expect(symbolOf(selected).props.color).toBe(LIGHT.primary);
  expect(selected.props.android_ripple).toEqual({
    color: withAlpha(LIGHT.primary, MATERIAL_STATE.pressed),
    borderless: true,
    radius: materialSize.iconButton / 2,
  });
  unmount(selectedRoot);
});

onAndroid("filled, tonal, and outlined MaterialIconButton variants apply Material 3 container, border, ink, and foreground ripple tokens", () => {
  const root = renderSurface(
    <DesignProvider design="material">
      <MaterialIconButton testID="filled" variant="filled" icon="plus" label="Filled" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="filledOff" variant="filled" selected={false} icon="plus" label="Filled Off" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="tonal" variant="tonal" icon="plus" label="Tonal" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="tonalOff" variant="tonal" selected={false} icon="plus" label="Tonal Off" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="outlined" variant="outlined" icon="plus" label="Outlined" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="outlinedOn" variant="outlined" selected icon="plus" label="Outlined On" scheme={LIGHT} onPress={noop} />
    </DesignProvider>,
  );

  const filled = pressable(root, "filled");
  expect(flat(containerOf(filled)).backgroundColor).toBe(LIGHT.primary);
  expect(symbolOf(filled).props.color).toBe(LIGHT.onPrimary);
  expect(filled.props.android_ripple).toMatchObject({ borderless: true, radius: 20, foreground: true });

  const filledOff = pressable(root, "filledOff");
  expect(flat(containerOf(filledOff)).backgroundColor).toBe(LIGHT.surfaceContainerHighest);
  expect(symbolOf(filledOff).props.color).toBe(LIGHT.primary);

  const tonal = pressable(root, "tonal");
  expect(flat(containerOf(tonal)).backgroundColor).toBe(LIGHT.secondaryContainer);
  expect(symbolOf(tonal).props.color).toBe(LIGHT.onSecondaryContainer);
  expect(tonal.props.android_ripple).toMatchObject({ borderless: true, radius: 20, foreground: true });

  const tonalOff = pressable(root, "tonalOff");
  expect(flat(containerOf(tonalOff)).backgroundColor).toBe(LIGHT.surfaceContainerHighest);
  expect(symbolOf(tonalOff).props.color).toBe(LIGHT.onSurfaceVariant);

  const outlined = pressable(root, "outlined");
  expect(flat(containerOf(outlined))).toMatchObject({ borderWidth: 1, borderColor: LIGHT.outline });
  expect(flat(containerOf(outlined)).backgroundColor).toBeUndefined();
  expect(symbolOf(outlined).props.color).toBe(LIGHT.onSurfaceVariant);
  expect(outlined.props.android_ripple).toMatchObject({ borderless: true, radius: 20 });

  const outlinedOn = pressable(root, "outlinedOn");
  expect(flat(containerOf(outlinedOn)).backgroundColor).toBe(LIGHT.inverseSurface);
  expect(flat(containerOf(outlinedOn)).borderWidth).toBeUndefined();
  expect(symbolOf(outlinedOn).props.color).toBe(LIGHT.inverseOnSurface);
  expect(outlinedOn.props.android_ripple).toMatchObject({ borderless: true, radius: 20, foreground: true });
  unmount(root);
});

onAndroid("disabled MaterialIconButton uses Material 3 38% content and 12% container or outline opacity", () => {
  const expectedContent = withAlpha(LIGHT.onSurface, MATERIAL_STATE.disabledContent);
  const expectedContainer = withAlpha(LIGHT.onSurface, MATERIAL_STATE.disabledContainer);
  const root = renderSurface(
    <DesignProvider design="material">
      <MaterialIconButton testID="std" variant="standard" enabled={false} icon="xmark" label="Std" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="fill" variant="filled" enabled={false} icon="xmark" label="Fill" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="tonal" variant="tonal" enabled={false} icon="xmark" label="Tonal" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="out" variant="outlined" enabled={false} icon="xmark" label="Out" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="outOn" variant="outlined" selected enabled={false} icon="xmark" label="Out On" scheme={LIGHT} onPress={noop} />
    </DesignProvider>,
  );

  for (const id of ["std", "fill", "tonal", "out", "outOn"]) {
    const button = pressable(root, id);
    expect(button.props.disabled).toBe(true);
    expect(button.props.accessibilityState.disabled).toBe(true);
    expect(symbolOf(button).props.color).toBe(expectedContent);
  }
  expect(flat(containerOf(pressable(root, "std"))).backgroundColor).toBeUndefined();
  expect(flat(containerOf(pressable(root, "fill"))).backgroundColor).toBe(expectedContainer);
  expect(flat(containerOf(pressable(root, "tonal"))).backgroundColor).toBe(expectedContainer);
  expect(flat(containerOf(pressable(root, "out"))).borderColor).toBe(expectedContainer);
  expect(flat(containerOf(pressable(root, "outOn"))).backgroundColor).toBe(expectedContainer);
  unmount(root);
});

onAndroid("compact and narrow MaterialIconButton sizes expand hitSlop to preserve a 48dp minimum touch target", () => {
  const root = renderSurface(
    <DesignProvider design="material">
      <MaterialIconButton testID="compact" size="compact" icon="ellipsis" label="Compact" scheme={LIGHT} onPress={noop} />
      <MaterialIconButton testID="narrow" size="narrow" icon="chevronLeft" label="Narrow" scheme={LIGHT} onPress={noop} />
    </DesignProvider>,
  );
  const compact = pressable(root, "compact");
  expect(flat(compact)).toMatchObject({ width: materialSize.iconButton, height: materialSize.iconButton });
  expect(compact.props.hitSlop).toBe(4);

  const narrow = pressable(root, "narrow");
  expect(flat(narrow)).toMatchObject({ width: materialSize.iconButton, height: materialSize.touchTarget });
  expect(narrow.props.hitSlop).toEqual({ left: 4, right: 4 });
  unmount(root);
});

onAndroid("SuggestionRow refine button and MaterialFindBar controls render as Material 3 icon buttons", () => {
  const rowRoot = renderSurface(
    <DesignProvider design="material">
      <SuggestionRow
        row={{ key: "query:otter", kind: "query", title: "otter facts", url: "https://duckduckgo.com/?q=otter+facts", query: "otter facts" }}
        typed="otter"
        roles={ROLES}
        onActivate={noop}
        onRefine={noop}
        onMenu={noop}
      />
    </DesignProvider>,
  );
  const refine = rowRoot.root.findAll((node) => node.props.accessibilityLabel === "Refine otter facts" && typeof node.props.onPress === "function")[0]!;
  expect(flat(refine)).toMatchObject({ width: materialSize.iconButton, height: materialSize.iconButton });
  expect(refine.props.hitSlop).toBe(4);
  expect(refine.props.android_ripple).toMatchObject({ borderless: true, radius: 20 });
  unmount(rowRoot);

  const findRoot = renderSurface(
    <DesignProvider design="material">
      <MaterialFindBar tabId="tab-1" />
    </DesignProvider>,
  );
  const previous = pressableByLabel(findRoot, "Previous Match");
  expect(previous.props.disabled).toBe(true);
  expect(previous.props.android_ripple).toMatchObject({ borderless: true, radius: 20 });
  expect(symbolOf(previous).props.color).toBe(withAlpha(LIGHT.onSurface, MATERIAL_STATE.disabledContent));
  const done = pressableByLabel(findRoot, "Close Find");
  expect(done.props.android_ripple).toMatchObject({ borderless: true, radius: 20 });
  unmount(findRoot);
});
