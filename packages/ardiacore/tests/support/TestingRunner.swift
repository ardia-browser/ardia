import Testing

@main
struct TestingRunner {
  static func main() async {
    await Testing.__swiftPMEntryPoint() as Never
  }
}
