import * as Reanimated from "react-native-reanimated";
import { act } from "react-test-renderer";
import { FrameProbe } from "../components/perf/FrameProbe";
import { beginInteraction, enableInteractionPerf } from "../state/app/interactionPerf";
import * as telemetry from "../state/telemetry/telemetry";
import { renderSurface, unmount } from "../../test/render/harness";

afterEach(() => {
  enableInteractionPerf(false);
  jest.restoreAllMocks();
});

test("FrameProbe only mounts useFrameCallback while recording is active", () => {
  const frameCallback = jest.spyOn(Reanimated, "useFrameCallback");
  const counted = jest.spyOn(telemetry, "countUsage").mockImplementation(() => undefined);
  const root = renderSurface(<FrameProbe />);
  expect(frameCallback).not.toHaveBeenCalled();
  expect(counted).not.toHaveBeenCalled();

  enableInteractionPerf(true, () => undefined);
  act(() => {
    beginInteraction("deckOpen", 900);
  });
  expect(frameCallback).toHaveBeenCalledTimes(1);
  expect(counted).toHaveBeenCalledWith("frame_probe_recordings");

  act(() => {
    enableInteractionPerf(false);
  });
  frameCallback.mockClear();
  act(() => {
    root.update(<FrameProbe />);
  });
  expect(frameCallback).not.toHaveBeenCalled();
  unmount(root);
});
