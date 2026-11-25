import Testing
@testable import ArdiaSync

struct DeviceNameTests {
  @Test func anIPadJoinsSyncAsAnIPad() {
    #expect(SyncMeta.deviceName(forModel: "iPad16,3") == "iPad")
    #expect(SyncMeta.deviceName(forModel: "iPhone18,1") == "iPhone")
    #expect(SyncMeta.deviceName(forModel: "arm64") == "iPhone")
  }
}
