import { takeCycleWork } from "./cycleWork";
import { takeReturnedDeviceRemovals, takeReturnedProfileRemovals, takeSyncedDeviceRemovals, takeSyncedProfileRemovals } from "./profileRemoval";

let snapshotWrites = { count: 0, bytes: 0 };

export function noteSnapshot({ snapshotBytes }: { snapshotBytes: number }) {
  if (snapshotBytes) snapshotWrites = { count: snapshotWrites.count + 1, bytes: snapshotWrites.bytes + snapshotBytes };
}

export function takeSnapshotWrites() {
  const taken = { ...snapshotWrites, ...takeCycleWork(), removedProfiles: takeSyncedProfileRemovals(), removedDevices: takeSyncedDeviceRemovals(), removalsReturned: takeReturnedProfileRemovals() + takeReturnedDeviceRemovals() };
  snapshotWrites = { count: 0, bytes: 0 };
  return taken;
}
