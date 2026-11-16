export type OnboardingSystem = { isDefault: boolean; inDock: boolean; dockAvailable: boolean; loginEnabled: boolean };

type SystemProbes = {
  isDefaultBrowser: () => Promise<boolean>;
  isInDock: () => Promise<boolean>;
  launchAtLoginStatus: () => Promise<string>;
};

export async function probeOnboardingSystem(probes: SystemProbes): Promise<OnboardingSystem> {
  const [isDefault, dock, login] = await Promise.all([
    probes.isDefaultBrowser().catch(() => false),
    probes.isInDock().then((inDock) => ({ inDock, available: true }), () => ({ inDock: false, available: false })),
    probes.launchAtLoginStatus().catch(() => "notRegistered"),
  ]);
  return { isDefault, inDock: dock.inDock, dockAvailable: dock.available, loginEnabled: login === "enabled" };
}
