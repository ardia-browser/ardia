import { useEffect, useRef, useState } from "react";
import { View, type ViewProps } from "react-native";
import page from "@ardia/shaders/ios/Meadow/index.html?raw";
import { callMain } from "../bridge";
import { meadowDocument, meadowFrameName } from "./meadowDocument";

type ToneEvent = { nativeEvent: { tone: string; halo: number } };
type MeadowProps = ViewProps & { night?: boolean; onTone?: (event: ToneEvent) => void };
type PageMessage = { ardiaMeadow?: string; state?: string; tone?: string; halo?: number };

const HANDOFF_MS = 400;
const HANDOFF_EASING = "cubic-bezier(0.37, 0, 0.63, 1)";
export function Meadow({ night = false, onTone, style, testID }: MeadowProps) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const channel = useRef(`meadow-${Math.random().toString(36).slice(2)}`).current;
  const opening = useRef(night).current;
  const [source] = useState(() => meadowDocument(page));
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const sentNight = useRef(opening);
  const latestTone = useRef(onTone);
  latestTone.current = onTone;

  useEffect(() => {
    const iframe = frame.current;
    const view = iframe?.ownerDocument.defaultView;
    if (!iframe || !view) return;
    const hear = (event: MessageEvent) => {
      const data = event.data as PageMessage | null;
      if (data?.ardiaMeadow !== channel) return;
      if (data.state === "ready" || data.state === "failed") void callMain("ArdiaAppWindows", "noteMeadow", data.state);
      if (data.state === "ready") setReady(true);
      else if (data.state === "failed") setFailed(true);
      else if (data.state === "tone" && typeof data.tone === "string") latestTone.current?.({ nativeEvent: { tone: data.tone, halo: data.halo ?? 0 } });
    };
    view.addEventListener("message", hear);
    return () => view.removeEventListener("message", hear);
  }, [channel]);

  useEffect(() => {
    if (!ready || sentNight.current === night) return;
    sentNight.current = night;
    frame.current?.contentWindow?.postMessage({ ardiaMeadow: channel, night }, "*");
  }, [ready, night, channel]);

  return (
    <View pointerEvents="none" testID={testID} style={[style, { overflow: "hidden" }]}>
      {failed ? null : (
        <iframe
          ref={frame}
          title="meadow"
          aria-hidden
          tabIndex={-1}
          name={meadowFrameName(channel, opening)}
          sandbox="allow-scripts"
          srcDoc={source}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, pointerEvents: "none", opacity: ready ? 1 : 0, transition: `opacity ${HANDOFF_MS}ms ${HANDOFF_EASING}` }}
        />
      )}
    </View>
  );
}
