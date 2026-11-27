#import "../ios/ArdiaLaunchConfig.h"

#include <cstdio>

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

static NSString *const kExecutable = @"/Applications/Ardia Dev.app/Contents/MacOS/Ardia";
static NSString *gHome;

static NSString *InHome(NSString *path) {
  return [gHome stringByAppendingPathComponent:path];
}

static ArdiaLaunchConfig *Config(NSDictionary<NSString *, NSString *> *environment, NSArray<NSString *> *arguments = @[]) {
  return [[ArdiaLaunchConfig alloc] initWithEnvironment:environment
                                              arguments:[@[ kExecutable ] arrayByAddingObjectsFromArray:arguments]
                                          homeDirectory:gHome
                                  signedForDistribution:^BOOL { return NO; }];
}

static void MakeHome() {
  char pattern[] = "/tmp/ardia-launch-config-XXXXXX";
  gHome = [NSString stringWithUTF8String:mkdtemp(pattern)];
  NSFileManager *files = NSFileManager.defaultManager;
  for (NSString *folder in @[ @"Library/Application Support/com.ardia.browser/Chromium", @"Library/Application Support/Ardia", @"scratch" ])
    [files createDirectoryAtPath:InHome(folder) withIntermediateDirectories:YES attributes:nil error:nil];
  [files createSymbolicLinkAtPath:InHome(@"scratch/live-link") withDestinationPath:InHome(@"Library/Application Support/com.ardia.browser") error:nil];
  [files createSymbolicLinkAtPath:InHome(@"scratch/legacy-link") withDestinationPath:InHome(@"Library/Application Support/Ardia") error:nil];
  [files createSymbolicLinkAtPath:InHome(@"scratch/deep") withDestinationPath:InHome(@"Library/Application Support/com.ardia.browser/Chromium") error:nil];
  for (NSString *folder in @[ @"scratch/engine-link", @"scratch/engine-legacy", @"scratch/engine-own/Chromium" ])
    [files createDirectoryAtPath:InHome(folder) withIntermediateDirectories:YES attributes:nil error:nil];
  [files createSymbolicLinkAtPath:InHome(@"scratch/engine-link/Chromium") withDestinationPath:InHome(@"Library/Application Support/com.ardia.browser/Chromium") error:nil];
  [files createSymbolicLinkAtPath:InHome(@"scratch/engine-legacy/Chromium") withDestinationPath:InHome(@"Library/Application Support/Ardia") error:nil];
}

static void EveryRequest(void (^check)(ArdiaLaunchConfig *config)) {
  check(Config(@{@"ARDIA_SHELL" : @"webui"}));
  check(Config(@{@"ARDIA_SHELL" : @" WebUI "}));
  check(Config(@{}, @[ @"--ardia-shell=webui" ]));
  check(Config(@{}, @[ @"--x", @"--ardia-shell=WEBUI" ]));
  check(Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_WEBUI_APP" : @"/tmp/Ardia WebUI.app", @"ARDIA_WEBUI_HANDED_OFF" : @"1"}, @[ @"--ardia-shell=webui" ]));
}

static void Neither() {
  for (ArdiaLaunchConfig *config in @[
         Config(@{}), Config(@{@"ARDIA_SHELL" : @"native"}), Config(@{@"ARDIA_SHELL" : @""}), Config(@{@"ARDIA_SHELL_X" : @"webui"}),
         Config(@{}, @[ @"--ardia-shell=native" ]), Config(@{}, @[ @"--ardia-shell", @"webui" ]),
       ]) {
    CHECK(!config.webUIShell);
    CHECK(config.dataDirectory == nil);
    CHECK(!config.isolated);
    CHECK(!config.webUIDataDirectoryDefaulted);
  }
  ArdiaLaunchConfig *executableOnly = [[ArdiaLaunchConfig alloc] initWithEnvironment:@{}
                                                                           arguments:@[ @"--ardia-shell=webui" ]
                                                                       homeDirectory:gHome
                                                               signedForDistribution:^BOOL { return NO; }];
  CHECK(!executableOnly.webUIShell);
}

#if DEBUG
static NSString *DevDataDirectory() {
  return InHome(@"Library/Application Support/Ardia WebUI Dev");
}

static NSString *LiveProfile() {
  return InHome(@"Library/Application Support/com.ardia.browser");
}

static void RefusesLiveProfiles() {
  NSArray<NSString *> *live = @[
    @"Library/Application Support/com.ardia.browser",
    @"Library/Application Support/com.ardia.browser/Chromium",
    @"Library/Application Support/com.ardia.browser/not-made-yet",
    @"Library/Application Support/Ardia",
    @"Library/Application Support/Ardia/Default",
    @"library/application support/COM.ARDIA.BROWSER",
    @"Library/Application Support/./com.ardia.browser/../com.ardia.browser",
    @"scratch/live-link",
    @"scratch/live-link/Chromium",
    @"scratch/live-link/not-made-yet",
    @"scratch/legacy-link",
    @"scratch/deep/..",
    @"scratch/deep/../made-later",
    @"scratch/missing/../live-link",
    @"scratch/missing/../deep/../made-later",
    @"scratch/engine-link",
    @"scratch/engine-legacy",
  ];
  for (NSString *path in live) {
    ArdiaLaunchConfig *config = Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_DATA_DIR" : InHome(path), @"ARDIA_WEBUI_APP" : @"/tmp/Ardia WebUI.app"});
    if (config.webUIShell || !config.webUIRefusedDataDirectory) std::printf("FAIL live profile accepted: %s\n", path.UTF8String);
    CHECK(!config.webUIShell);
    CHECK(config.webUIRefusedDataDirectory);
    CHECK(config.webUIHostApp == nil);
    CHECK(config.dataDirectory == nil);
    CHECK(!config.isolated);
    CHECK([config.snapshot[@"webUIRefusedDataDirectory"] isEqual:@YES]);
  }
  for (NSString *path in @[ @"scratch", @"scratch/webui", @"Library/Application Support/Ardia WebUI Dev", @"Library/Application Support/com.ardia.browser-copy", @"Library/Application Support/Ardia copy", @"scratch/../scratch/fresh", @"scratch/engine-own", @"scratch/deep/../../../../scratch/after-climb" ]) {
    ArdiaLaunchConfig *config = Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_DATA_DIR" : InHome(path)});
    if (!config.webUIShell) std::printf("FAIL safe directory refused: %s\n", path.UTF8String);
    CHECK(!config.webUIRefusedDataDirectory);
  }
  for (NSString *alias in @[ [@"/private" stringByAppendingString:LiveProfile()], [@"/System/Volumes/Data/private" stringByAppendingString:LiveProfile()] ]) {
    ArdiaLaunchConfig *config = Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_DATA_DIR" : alias});
    if (config.webUIShell) std::printf("FAIL firmlink alias accepted: %s\n", alias.UTF8String);
    CHECK(!config.webUIShell);
    CHECK(config.webUIRefusedDataDirectory);
    CHECK(config.dataDirectory == nil);
  }
  ArdiaLaunchConfig *withoutFlag = Config(@{@"ARDIA_DATA_DIR" : LiveProfile()});
  CHECK(!withoutFlag.webUIRefusedDataDirectory);
  CHECK([withoutFlag.dataDirectory isEqualToString:LiveProfile()]);

  [NSFileManager.defaultManager createSymbolicLinkAtPath:DevDataDirectory() withDestinationPath:LiveProfile() error:nil];
  ArdiaLaunchConfig *linkedDefault = Config(@{@"ARDIA_SHELL" : @"webui"});
  CHECK(!linkedDefault.webUIShell);
  CHECK(linkedDefault.webUIRefusedDataDirectory);
  CHECK(linkedDefault.dataDirectory == nil);
  CHECK(!linkedDefault.webUIDataDirectoryDefaulted);
  CHECK(!linkedDefault.isolated);
  [NSFileManager.defaultManager removeItemAtPath:DevDataDirectory() error:nil];
}

static void DebugBuild() {
  Neither();
  EveryRequest(^(ArdiaLaunchConfig *config) {
    CHECK(config.webUIShell);
    CHECK([config.snapshot[@"webUIShell"] isEqual:@YES]);
    CHECK([config.dataDirectory isEqualToString:DevDataDirectory()]);
    CHECK(![config.dataDirectory isEqualToString:LiveProfile()]);
    CHECK(config.webUIDataDirectoryDefaulted);
    CHECK(config.isolated);
    CHECK([config.configDirectory isEqualToString:[DevDataDirectory() stringByAppendingPathComponent:@"config"]]);
    CHECK([config.engineSwitches containsObject:[@"--ardia-data-dir=" stringByAppendingString:DevDataDirectory()]]);
  });
  ArdiaLaunchConfig *explicitDirectory = Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_DATA_DIR" : @"/tmp/scratch-webui"});
  CHECK(explicitDirectory.webUIShell);
  CHECK([explicitDirectory.dataDirectory isEqualToString:@"/tmp/scratch-webui"]);
  CHECK(!explicitDirectory.webUIDataDirectoryDefaulted);
  ArdiaLaunchConfig *host = Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_WEBUI_APP" : @"/tmp/Ardia WebUI.app", @"ARDIA_WEBUI_HANDED_OFF" : @"1"});
  CHECK([host.webUIHostApp isEqualToString:@"/tmp/Ardia WebUI.app"]);
  CHECK(host.webUIHandedOff);
  ArdiaLaunchConfig *unrequested = Config(@{@"ARDIA_WEBUI_APP" : @"/tmp/Ardia WebUI.app", @"ARDIA_WEBUI_HANDED_OFF" : @"1"});
  CHECK(unrequested.webUIHostApp == nil);
  CHECK(!unrequested.webUIHandedOff);
  RefusesLiveProfiles();
}
#else
static void ReleaseBuild() {
  Neither();
  EveryRequest(^(ArdiaLaunchConfig *config) {
    CHECK(!config.webUIShell);
    CHECK([config.snapshot[@"webUIShell"] isEqual:@NO]);
    CHECK(config.dataDirectory == nil);
    CHECK(!config.isolated);
    CHECK(!config.webUIDataDirectoryDefaulted);
    CHECK(config.webUIHostApp == nil);
    CHECK(!config.webUIHandedOff);
  });
  ArdiaLaunchConfig *explicitDirectory = Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_DATA_DIR" : @"/tmp/scratch-webui"});
  CHECK(!explicitDirectory.webUIShell);
  CHECK(!Config(@{@"ARDIA_SHELL" : @"webui", @"ARDIA_DATA_DIR" : InHome(@"scratch/live-link")}).webUIRefusedDataDirectory);
  CHECK([explicitDirectory.dataDirectory isEqualToString:@"/tmp/scratch-webui"]);
}
#endif

int main() {
  @autoreleasepool {
    MakeHome();
#if DEBUG
    DebugBuild();
    std::printf("launch-config-webui debug: %d failures\n", failures);
#else
    ReleaseBuild();
    std::printf("launch-config-webui release: %d failures\n", failures);
#endif
    [NSFileManager.defaultManager removeItemAtPath:gHome error:nil];
  }
  return failures ? 1 : 0;
}
