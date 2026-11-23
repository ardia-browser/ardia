import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { curve, duration, reduceMotion, tabularNums, Text, type Weight } from "../ui";
import { advanceRoll, codeCells, PLACEHOLDER_CODE, restingRoll, spokenCode, type ShownCode } from "./codeDigitsModel";
import { VAULT_CODE } from "./tokens";

type LiveDigits = { code: string; expiresAt: number; period: number };

const ROW = { flexDirection: "row" } as const;
const CLAMP = "clamp" as const;

function Glyph({ char, color, weight }: { char: string; color?: string; weight?: Weight }) {
  return (
    <Text weight={weight} color={color} style={tabularNums}>
      {char}
    </Text>
  );
}

type Layer = 0 | 1;
type Layers = { chars: readonly [string, string]; front: Layer; turn: number; rolled: boolean; char: string };

const otherLayer = (layer: Layer): Layer => (layer === 0 ? 1 : 0);

const withChar = (chars: readonly [string, string], at: Layer, char: string): [string, string] => (at === 0 ? [char, chars[1]] : [chars[0], char]);

function nextLayers(layers: Layers, char: string, rolling: boolean): Layers {
  if (char === layers.char) return layers;
  const turn = layers.turn + 1;
  if (!rolling) return { chars: [char, char], front: layers.front, turn, rolled: false, char };
  const front = otherLayer(layers.front);
  return { chars: withChar(layers.chars, front, char), front, turn, rolled: true, char };
}

function layerStyle(position: Animated.Value, still: boolean, overlay: boolean) {
  const shift = still ? 0 : VAULT_CODE.rollShift;
  return {
    ...(overlay ? StyleSheet.absoluteFillObject : null),
    opacity: still
      ? position.interpolate({ inputRange: [-1, 0, 1], outputRange: [0, 1, 0], extrapolate: CLAMP })
      : position.interpolate({ inputRange: [-1, -0.55, 0, 0.4, 1], outputRange: [0, 0, 1, 1, 0], extrapolate: CLAMP }),
    transform: [{ translateY: position.interpolate({ inputRange: [-1, 0, 1], outputRange: [-shift, 0, shift], extrapolate: CLAMP }) }],
  };
}

const Digit = memo(function Digit({ char, rolling, color, weight }: { char: string; rolling: boolean; color?: string; weight?: Weight }) {
  const [layers, setLayers] = useState<Layers>(() => ({ chars: [char, ""], front: 0, turn: 0, rolled: false, char }));
  const shown = nextLayers(layers, char, rolling);
  if (shown !== layers) setLayers(shown);
  const positions = useRef([new Animated.Value(0), new Animated.Value(-1)] as const).current;
  const still = reduceMotion() === true;
  const styles = useMemo(() => [layerStyle(positions[0], still, false), layerStyle(positions[1], still, true)] as const, [still]);
  useEffect(() => {
    if (!shown.turn) return;
    const entering = positions[shown.front];
    const leaving = positions[otherLayer(shown.front)];
    if (!shown.rolled) return void (entering.setValue(0), leaving.setValue(-1));
    entering.setValue(1);
    const move = (value: Animated.Value, toValue: number) => Animated.timing(value, { toValue, duration: still ? duration.base : VAULT_CODE.rollMs, easing: curve.enter, useNativeDriver: true });
    const run = Animated.parallel([move(entering, 0), move(leaving, -1)]);
    run.start();
    return () => run.stop();
  }, [shown.turn]);
  return (
    <View>
      <Animated.View style={styles[0]}>
        <Glyph char={shown.chars[0]} color={color} weight={weight} />
      </Animated.View>
      <Animated.View pointerEvents="none" style={styles[1]}>
        <Glyph char={shown.chars[1]} color={color} weight={weight} />
      </Animated.View>
    </View>
  );
});

export const CodeDigits = memo(function CodeDigits({ owner, code, color, weight }: { owner: string; code: LiveDigits | null; color?: string; weight?: Weight }) {
  const next: ShownCode | null = code ? { owner, code: code.code, expiresAt: code.expiresAt, period: code.period } : null;
  const [state, setState] = useState(() => restingRoll(next));
  const advanced = advanceRoll(state, next);
  if (advanced !== state) setState(advanced);
  const { shown, roll } = advanced;
  const cells = codeCells(shown?.code ?? PLACEHOLDER_CODE);
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={shown ? spokenCode(shown.code) : "Loading code"} style={ROW}>
      {cells.map((cell) => {
        if (cell.kind === "space") return <Glyph key="space" char=" " color={color} weight={weight} />;
        return <Digit key={`d${cell.at}`} char={cell.char} rolling={roll?.changed[cell.at] === true} color={color} weight={weight} />;
      })}
    </View>
  );
});
