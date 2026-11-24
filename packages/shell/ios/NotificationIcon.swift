struct NotificationIcon {
  var status: String
  var errorCode: Int?

  static let absent = NotificationIcon(status: "none", errorCode: nil)
}
