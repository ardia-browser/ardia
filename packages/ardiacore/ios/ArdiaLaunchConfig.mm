#import "ArdiaLaunchConfig.h"

#import <Security/Security.h>
#import <limits.h>
#import <stdlib.h>
#import <sys/stat.h>
#import <os/log.h>

namespace {

NSString *const kDataDirVariable = @"ARDIA_DATA_DIR";
NSString *const kBackgroundVariable = @"ARDIA_BACKGROUND";
NSString *const kRemoteDebuggingPortVariable = @"ARDIA_REMOTE_DEBUGGING_PORT";
NSString *const kInstanceVariable = @"ARDIA_INSTANCE";
NSString *const kSwitchesVariable = @"ARDIA_SWITCHES";
NSString *const kTraceVariable = @"ARDIA_TRACE";
NSString *const kTestVariable = @"ARDIA_TEST";
NSString *const kPrewarmVariable = @"ARDIA_PREWARM";
NSString *const kFeedbackURLVariable = @"ARDIA_FEEDBACK_URL";
NSString *const kSwitchesCacheDocument = @"switches-cache.json";
NSString *const kShellVariable = @"ARDIA_SHELL";
NSString *const kShellArgument = @"--ardia-shell=webui";
NSString *const kWebUIShell = @"webui";
NSString *const kWebUIHostAppVariable = @"ARDIA_WEBUI_APP";
NSString *const kWebUIHandedOffVariable = @"ARDIA_WEBUI_HANDED_OFF";
NSString *const kWebUIDevDataFolder = @"Library/Application Support/Ardia WebUI Dev";
NSString *const kApplicationSupportFolder = @"Library/Application Support";
NSString *const kInstalledBundleIdentifier = @"com.ardia.browser";
NSString *const kLegacyProfileFolder = @"Ardia";
NSString *const kEngineDataFolder = @"Chromium";

NSArray<NSString *> *InstanceKeys() {
  return @[
    @"jsLocation", @"chromiumSwitches", @"downloadsDir", @"updateFeed", @"allowAudio", @"allowOcclusion", @"releaseNotes",
    @"cliHome", @"cliBinDir", @"cliUrl", @"syncFolder", @"sharedFolders", @"importSourceDir", @"importSafariHome", @"officialPluginsFrom",
  ];
}

NSArray<NSString *> *EngineInstanceKeys() {
  return @[ @"downloadsDir" ];
}

NSArray<NSString *> *EngineTestKeys() {
  return @[
    @"keychain", @"keychainHiddenReads", @"keychainFail", @"safeStorageAnswer", @"reauth", @"bluetoothChooser",
    @"externalProtocolNoLaunch", @"externalProtocolApp", @"mediaRouteProvider", @"systemMediaPermission", @"applyProfileGate", @"contextMenu",
    @"loginsDelay", @"loginsReleaseAfter", @"cdpTabsVisible", @"nativeDragRefused",
  ];
}

NSArray<NSString *> *AppTestKeys() {
  return @[
    @"pipSelfTest", @"pipHover", @"fakeFullScreenMs", @"shadersKeyWindow", @"peekStrict", @"peekMesh", @"peekReady", @"peekReduceMotion", @"peekSlow", @"importSecret", @"importDiaBundleId", @"importDiaWindows",
    @"cliInstallScript", @"legacySource", @"legacyCrashAfter", @"bangsUrl", @"onboarding", @"whatsNew", @"telemetry",
    @"liveMock", @"calendarFixture", @"appMenu", @"appDialog", @"loginsTimeout", @"screenRecording", @"systemLocationPermission", @"officialPin",
    @"applePasswordsPanel", @"systemPanelRace", @"controlDoorbell",
  ];
}

NSArray<NSString *> *KeysWhoseValuesHoldCommas() {
  return @[
    @"chromiumSwitches", @"downloadsDir", @"updateFeed", @"cliHome", @"cliBinDir", @"cliUrl", @"syncFolder", @"sharedFolders", @"importSourceDir",
    @"importSafariHome", @"importSecret", @"cliInstallScript", @"legacySource", @"bangsUrl", @"liveMock", @"officialPin", @"officialPluginsFrom",
  ];
}

NSArray<NSString *> *TraceAreas() {
  return @[ @"visibility", @"pip", @"pipZoom", @"trafficLights", @"profileGate" ];
}

void Note(NSString *line) {
  os_log(OS_LOG_DEFAULT, "[ardia] %{public}@", line);
  fprintf(stderr, "[ardia] %s\n", line.UTF8String);
}

NSString *Trimmed(NSString *text) {
  return [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
}

NSString *Present(NSString *_Nullable value) {
  return value.length ? value : nil;
}

BOOL Truthy(NSString *_Nullable value) {
  return value && ![@[ @"0", @"off", @"false" ] containsObject:value];
}

NSNumber *_Nullable OnOff(NSString *value) {
  if ([@[ @"on", @"1", @"true" ] containsObject:value]) return @YES;
  if ([@[ @"off", @"0", @"false" ] containsObject:value]) return @NO;
  return nil;
}

NSDictionary<NSString *, NSString *> *KeyedEntries(NSString *_Nullable text, NSArray<NSString *> *known, NSString *variable) {
  NSMutableDictionary<NSString *, NSString *> *entries = [NSMutableDictionary dictionary];
  if (!text.length) return entries;
  NSMutableArray<NSString *> *pieces = [NSMutableArray array];
  NSString *previousKey = nil;
  for (NSString *piece in [text componentsSeparatedByString:@","]) {
    NSString *head = Trimmed([piece componentsSeparatedByString:@"="].firstObject ?: @"");
    if (![known containsObject:head] && [KeysWhoseValuesHoldCommas() containsObject:previousKey]) {
      pieces[pieces.count - 1] = [pieces.lastObject stringByAppendingFormat:@",%@", piece];
      continue;
    }
    [pieces addObject:piece];
    previousKey = head;
  }
  for (NSString *piece in pieces) {
    const NSRange equals = [piece rangeOfString:@"="];
    NSString *key = Trimmed(equals.location == NSNotFound ? piece : [piece substringToIndex:equals.location]);
    if (!key.length) continue;
    if (![known containsObject:key]) {
      Note([NSString stringWithFormat:@"%@: unknown key %@ ignored", variable, key]);
      continue;
    }
    entries[key] = equals.location == NSNotFound ? @"1" : Trimmed([piece substringFromIndex:NSMaxRange(equals)]);
  }
  return entries;
}

NSDictionary<NSString *, NSNumber *> *SwitchEntries(NSString *_Nullable text) {
  NSMutableDictionary<NSString *, NSNumber *> *entries = [NSMutableDictionary dictionary];
  for (NSString *piece in [text ?: @"" componentsSeparatedByString:@","]) {
    NSArray<NSString *> *pair = [piece componentsSeparatedByString:@"="];
    if (pair.count != 2) continue;
    NSString *name = Trimmed(pair[0]);
    NSNumber *value = OnOff(Trimmed(pair[1]));
    if (name.length && value) entries[name] = value;
  }
  return entries;
}

NSSet<NSString *> *AreaEntries(NSString *_Nullable text) {
  NSMutableSet<NSString *> *areas = [NSMutableSet set];
  for (NSString *piece in [text ?: @"" componentsSeparatedByString:@","]) {
    NSString *area = Trimmed(piece);
    if (!area.length) continue;
    if (![TraceAreas() containsObject:area]) Note([NSString stringWithFormat:@"%@: unknown area %@ ignored", kTraceVariable, area]);
    else [areas addObject:area];
  }
  return areas;
}

NSString *_Nullable StandardizedDirectory(NSString *_Nullable path) {
  if (!path.length) return nil;
  if (!path.absolutePath) path = [NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:path];
  return path.stringByStandardizingPath;
}

BOOL BackgroundValue(NSString *_Nullable value) {
  return value.length && ![value isEqualToString:@"0"];
}

NSString *Kebab(NSString *key) {
  NSMutableString *kebab = [NSMutableString string];
  for (NSUInteger i = 0; i < key.length; i++) {
    const unichar c = [key characterAtIndex:i];
    if (c >= 'A' && c <= 'Z') [kebab appendFormat:@"-%C", (unichar)(c - 'A' + 'a')];
    else [kebab appendFormat:@"%C", c];
  }
  return kebab;
}

NSString *Joined(NSDictionary<NSString *, NSString *> *entries, NSArray<NSString *> *keys) {
  NSMutableArray<NSString *> *parts = [NSMutableArray array];
  for (NSString *key in keys)
    if (NSString *value = entries[key]) [parts addObject:[value isEqualToString:@"1"] ? key : [NSString stringWithFormat:@"%@=%@", key, value]];
  return [parts componentsJoinedByString:@","];
}

#if DEBUG
BOOL WebUIShellRequested(NSString *_Nullable shell, NSArray<NSString *> *arguments) {
  if ([Trimmed(shell ?: @"").lowercaseString isEqualToString:kWebUIShell]) return YES;
  for (NSUInteger i = 1; i < arguments.count; i++)
    if ([arguments[i].lowercaseString isEqualToString:kShellArgument]) return YES;
  return NO;
}

NSString *RealPath(NSString *path) {
  char resolved[PATH_MAX];
  return realpath(path.fileSystemRepresentation, resolved) ? [NSString stringWithUTF8String:resolved] : nil;
}

NSString *CanonicalPath(NSString *path) {
  if (!path.absolutePath) path = [NSFileManager.defaultManager.currentDirectoryPath stringByAppendingPathComponent:path];
  NSString *resolved = @"/";
  for (NSString *component in path.pathComponents) {
    if (!component.length || [component isEqualToString:@"/"] || [component isEqualToString:@"."]) continue;
    if ([component isEqualToString:@".."]) {
      resolved = resolved.stringByDeletingLastPathComponent;
      continue;
    }
    NSString *next = [resolved stringByAppendingPathComponent:component];
    resolved = RealPath(next) ?: next;
  }
  return resolved;
}

BOOL SameFile(const struct stat &a, const struct stat &b) {
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

BOOL PathWithin(NSString *path, NSString *root) {
  NSString *canonicalPath = CanonicalPath(path).lowercaseString;
  NSString *canonicalRoot = CanonicalPath(root).lowercaseString;
  if ([canonicalPath isEqualToString:canonicalRoot] || [canonicalPath hasPrefix:[canonicalRoot stringByAppendingString:@"/"]]) return YES;
  struct stat rootStatus;
  if (stat(root.fileSystemRepresentation, &rootStatus) != 0) return NO;
  for (NSString *ancestor = CanonicalPath(path); ancestor.length > 1; ancestor = ancestor.stringByDeletingLastPathComponent) {
    struct stat status;
    if (stat(ancestor.fileSystemRepresentation, &status) == 0 && SameFile(status, rootStatus)) return YES;
  }
  return NO;
}

NSArray<NSString *> *LiveProfileRoots(NSString *home) {
  NSString *support = [home stringByAppendingPathComponent:kApplicationSupportFolder];
  NSMutableOrderedSet<NSString *> *names = [NSMutableOrderedSet orderedSetWithArray:@[ kInstalledBundleIdentifier, kLegacyProfileFolder ]];
  if (NSString *running = NSBundle.mainBundle.bundleIdentifier) [names addObject:running];
  NSMutableArray<NSString *> *roots = [NSMutableArray array];
  for (NSString *name in names) [roots addObject:[support stringByAppendingPathComponent:name]];
  return roots;
}

BOOL InsideLiveProfile(NSString *path, NSString *home) {
  NSString *engineData = [path stringByAppendingPathComponent:kEngineDataFolder];
  for (NSString *root in LiveProfileRoots(home))
    if (PathWithin(path, root) || PathWithin(engineData, root)) return YES;
  return NO;
}
#endif

BOOL SignedForDistribution() {
  SecCodeRef code = nullptr;
  if (SecCodeCopySelf(kSecCSDefaultFlags, &code) != errSecSuccess) return YES;
  SecRequirementRef requirement = nullptr;
  const OSStatus made = SecRequirementCreateWithString(
      CFSTR("anchor apple generic and "
            "(certificate leaf[field.1.2.840.113635.100.6.1.9] exists or "
            "certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
            "certificate leaf[field.1.2.840.113635.100.6.1.13] exists)"),
      kSecCSDefaultFlags, &requirement);
  if (made != errSecSuccess) {
    CFRelease(code);
    return YES;
  }
  const BOOL distribution = SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement) == errSecSuccess;
  CFRelease(requirement);
  CFRelease(code);
  return distribution;
}

}

@implementation ArdiaLaunchConfig {
  NSDictionary<NSString *, NSString *> *_instance;
  NSDictionary<NSString *, NSNumber *> *_switches;
  NSDictionary<NSString *, NSNumber *> *_cachedSwitches;
  NSSet<NSString *> *_requestedAreas;
  NSDictionary<NSString *, NSString *> *_requestedTest;
  BOOL (^_signedForDistribution)(void);
  NSNumber *_testInstance;
  NSDictionary<NSString *, NSString *> *_environmentForChildProcesses;
}

+ (ArdiaLaunchConfig *)shared {
  static ArdiaLaunchConfig *shared;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    shared = [[ArdiaLaunchConfig alloc] initWithEnvironment:NSProcessInfo.processInfo.environment
                                                  arguments:NSProcessInfo.processInfo.arguments
                                              homeDirectory:NSHomeDirectory()
                                      signedForDistribution:^BOOL { return SignedForDistribution(); }];
  });
  return shared;
}

- (instancetype)initWithEnvironment:(NSDictionary<NSString *, NSString *> *)environment
                          arguments:(NSArray<NSString *> *)arguments
                      homeDirectory:(NSString *)homeDirectory
              signedForDistribution:(BOOL (^)(void))signedForDistribution {
  if ((self = [super init])) {
    _dataDirectory = StandardizedDirectory(environment[kDataDirVariable]);
#if DEBUG
    _webUIShell = WebUIShellRequested(environment[kShellVariable], arguments);
    if (_webUIShell) {
      _webUIHostApp = Present(environment[kWebUIHostAppVariable]);
      _webUIHandedOff = Present(environment[kWebUIHandedOffVariable]) != nil;
      if (!_dataDirectory) {
        _dataDirectory = [homeDirectory stringByAppendingPathComponent:kWebUIDevDataFolder];
        _webUIDataDirectoryDefaulted = YES;
      }
      NSString *requested = Present(environment[kDataDirVariable]);
      if (InsideLiveProfile(_dataDirectory, homeDirectory) || (requested && InsideLiveProfile(requested, homeDirectory))) {
        Note([NSString stringWithFormat:@"%@=webui refused: %@ is inside the installed app's profile; pass a copy in %@", kShellVariable, _dataDirectory, kDataDirVariable]);
        _dataDirectory = nil;
        _webUIShell = NO;
        _webUIDataDirectoryDefaulted = NO;
        _webUIHostApp = nil;
        _webUIHandedOff = NO;
        _webUIRefusedDataDirectory = YES;
      }
    }
#endif
    _configDirectory = _dataDirectory ? [_dataDirectory stringByAppendingPathComponent:@"config"]
                                      : [NSHomeDirectory() stringByAppendingPathComponent:@".config/ardia"];
    _background = BackgroundValue(environment[kBackgroundVariable]);
    const NSInteger port = Trimmed(environment[kRemoteDebuggingPortVariable] ?: @"").integerValue;
    _remoteDebuggingPort = port > 0 && port < 65536 ? @(port) : nil;
    _prewarm = Present(environment[kPrewarmVariable]) != nil;
    _feedbackURL = Present(environment[kFeedbackURLVariable]);
    _instance = KeyedEntries(environment[kInstanceVariable], InstanceKeys(), kInstanceVariable);
    _switches = SwitchEntries(environment[kSwitchesVariable]);
    _requestedAreas = AreaEntries(environment[kTraceVariable]);
    _requestedTest = KeyedEntries(environment[kTestVariable], [EngineTestKeys() arrayByAddingObjectsFromArray:AppTestKeys()], kTestVariable);
    _signedForDistribution = [signedForDistribution copy];
    NSMutableDictionary<NSString *, NSString *> *inherited = [NSMutableDictionary dictionary];
    [environment enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSString *value, BOOL *) {
      if (![name hasPrefix:@"ARDIA_"]) inherited[name] = value;
    }];
    _environmentForChildProcesses = inherited;
    if ((_requestedAreas.count || _requestedTest.count) && !self.testInstance)
      Note([NSString stringWithFormat:@"%@ and %@ ignored: not a test instance (%@)", kTestVariable, kTraceVariable,
                                      _dataDirectory ? @"signed for distribution" : @"no scratch ARDIA_DATA_DIR"]);
  }
  return self;
}

- (BOOL)isolated {
  return _dataDirectory != nil;
}

- (BOOL)testInstance {
  @synchronized(self) {
    if (!_testInstance) _testInstance = @(_dataDirectory != nil && !_signedForDistribution());
    return _testInstance.boolValue;
  }
}

- (NSString *)instance:(NSString *)key {
  return Present(_instance[key]);
}

- (BOOL)instanceFlag:(NSString *)key {
  return Truthy([self instance:key]);
}

- (NSDictionary<NSString *, NSNumber *> *)cachedSwitches {
  @synchronized(self) {
    if (!_cachedSwitches) _cachedSwitches = [self readCachedSwitches];
    return _cachedSwitches;
  }
}

- (NSDictionary<NSString *, NSNumber *> *)readCachedSwitches {
  NSString *directory = _dataDirectory;
  if (!directory) {
    NSString *support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
    directory = [support stringByAppendingPathComponent:NSBundle.mainBundle.bundleIdentifier ?: @"com.ardia.browser"];
  }
  NSData *data = [NSData dataWithContentsOfFile:[directory stringByAppendingPathComponent:kSwitchesCacheDocument]];
  NSDictionary *cache = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  NSDictionary *saved = [cache isKindOfClass:NSDictionary.class] && [cache[@"switches"] isKindOfClass:NSDictionary.class] ? cache[@"switches"] : @{};
  NSMutableDictionary<NSString *, NSNumber *> *switches = [NSMutableDictionary dictionary];
  [saved enumerateKeysAndObjectsUsingBlock:^(id name, id value, BOOL *) {
    if ([name isKindOfClass:NSString.class] && [value isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID())
      switches[name] = value;
  }];
  return [switches copy];
}

- (BOOL)switchOn:(NSString *)name {
  if (NSNumber *said = _switches[name]) return said.boolValue;
  if (NSNumber *cached = self.cachedSwitches[name]) return cached.boolValue;
  return YES;
}

- (BOOL)experimentOn:(NSString *)name {
  return _switches[name].boolValue;
}

- (BOOL)traced:(NSString *)area {
  return [_requestedAreas containsObject:area] && self.testInstance;
}

- (NSString *)testValue:(NSString *)key {
  NSString *value = _requestedTest[key];
  return value && self.testInstance ? value : nil;
}

- (BOOL)testFlag:(NSString *)key {
  return Truthy([self testValue:key]);
}

- (NSDictionary<NSString *, NSString *> *)honouredTest {
  return self.testInstance ? _requestedTest : @{};
}

- (NSSet<NSString *> *)honouredAreas {
  return self.testInstance ? _requestedAreas : [NSSet set];
}

- (NSArray<NSString *> *)engineSwitches {
  NSMutableArray<NSString *> *switches = [NSMutableArray array];
  if (_background) [switches addObject:@"--ardia-background"];
  if (_dataDirectory) [switches addObject:[@"--ardia-data-dir=" stringByAppendingString:_dataDirectory]];
  for (NSString *key in EngineInstanceKeys())
    if (NSString *value = [self instance:key]) [switches addObject:[NSString stringWithFormat:@"--ardia-%@=%@", Kebab(key), value]];
  if (_switches.count) {
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (NSString *name in [_switches.allKeys sortedArrayUsingSelector:@selector(compare:)])
      [parts addObject:[NSString stringWithFormat:@"%@=%@", name, _switches[name].boolValue ? @"on" : @"off"]];
    [switches addObject:[@"--ardia-switches=" stringByAppendingString:[parts componentsJoinedByString:@","]]];
  }
  NSString *test = Joined(self.honouredTest, EngineTestKeys());
  if (test.length) [switches addObject:[@"--ardia-test=" stringByAppendingString:test]];
  NSArray<NSString *> *areas = [self.honouredAreas.allObjects sortedArrayUsingSelector:@selector(compare:)];
  if (areas.count) [switches addObject:[@"--ardia-trace=" stringByAppendingString:[areas componentsJoinedByString:@","]]];
  return switches;
}

- (NSDictionary<NSString *, id> *)snapshot {
  NSMutableDictionary<NSString *, id> *switches = [NSMutableDictionary dictionary];
  [_switches enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSNumber *on, BOOL *) { switches[name] = on; }];
  return @{
    @"dataDirectory" : _dataDirectory ?: NSNull.null,
    @"configDirectory" : _configDirectory,
    @"background" : @(_background),
    @"isolated" : @(self.isolated),
    @"testInstance" : @(self.testInstance),
    @"instance" : _instance,
    @"switches" : switches,
    @"trace" : [self.honouredAreas.allObjects sortedArrayUsingSelector:@selector(compare:)],
    @"test" : self.honouredTest,
    @"feedbackURL" : _feedbackURL ?: NSNull.null,
    @"webUIShell" : @(_webUIShell),
    @"webUIRefusedDataDirectory" : @(_webUIRefusedDataDirectory),
  };
}

@end
