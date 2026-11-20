type FeatureFlags = {
  scheduleAnimatedCleanupInMicrotask?: unknown;
  override: (overrides: { scheduleAnimatedCleanupInMicrotask: () => boolean }) => void;
};
type EndResult = { finished: boolean };
type Ending = { __notifyAnimationEnd(result: EndResult): void };
type Detaching = { __detach(): void };

let detaching = 0;

export function deferCancellationsDuringDetach(animation: Ending, value: Detaching) {
  const notify = animation.__notifyAnimationEnd;
  animation.__notifyAnimationEnd = function (this: Ending, result: EndResult) {
    if (detaching > 0 && !result.finished) queueMicrotask(() => notify.call(this, result));
    else notify.call(this, result);
  };
  const detach = value.__detach;
  value.__detach = function (this: Detaching) {
    detaching++;
    try {
      detach.call(this);
    } finally {
      detaching--;
    }
  };
}

export function detachAnimatedPropsInCommit(): string | null {
  try {
    const flags: FeatureFlags = require("react-native/src/private/featureflags/ReactNativeFeatureFlags");
    if (typeof flags.scheduleAnimatedCleanupInMicrotask !== "function") return "React Native has no scheduleAnimatedCleanupInMicrotask flag";
    flags.override({ scheduleAnimatedCleanupInMicrotask: () => false });
    deferCancellationsDuringDetach(require("react-native/Libraries/Animated/animations/Animation").default.prototype, require("react-native/Libraries/Animated/nodes/AnimatedValue").default.prototype);
    return null;
  } catch (error) {
    return String((error as Error)?.message ?? error);
  }
}

const failed = detachAnimatedPropsInCommit();
if (failed) console.warn(`[animatedCleanup] kept React Native's microtask cleanup: ${failed}`);
