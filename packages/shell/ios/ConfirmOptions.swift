import ExpoModulesCore

struct ConfirmOptions: Record {
  @Field var title: String = ""
  @Field var message: String = ""
  @Field var confirmTitle: String = "OK"
  @Field var cancelTitle: String = "Cancel"
  @Field var destructive: Bool = false
  @Field var suppression: String?
  @Field var windowId: String?
  @Field var onlyIfShown: Bool = false
  @Field var dismissKey: String?
  @Field var sheetOnly: Bool = false
}

struct ChooseOptions: Record {
  @Field var title: String = ""
  @Field var message: String = ""
  @Field var choices: [String] = []
  @Field var cancelChoice: Int?
  @Field var noDefault: Bool = false
  @Field var windowId: String?
  @Field var onlyIfShown: Bool = false
  @Field var dismissKey: String?
}
