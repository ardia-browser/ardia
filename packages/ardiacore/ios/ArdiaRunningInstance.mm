#import "ArdiaHostInternal.h"

#include <signal.h>
#include <unistd.h>

static NSString *const kReopenRunningInstance = @"com.ardia.browser.reopenRunningInstance";
static NSString *const kRunningInstanceReopened = @"com.ardia.browser.runningInstanceReopened";
static const NSTimeInterval kRunningInstanceAnswerSeconds = 30;
static const int kRunningInstanceShowTries = 100;

static pid_t InstanceHoldingDataDirectory(NSString *chromiumDirectory) {
  NSString *lock = [chromiumDirectory stringByAppendingPathComponent:@"SingletonLock"];
  NSString *target = [NSFileManager.defaultManager destinationOfSymbolicLinkAtPath:lock error:nil];
  NSRange dash = target ? [target rangeOfString:@"-" options:NSBackwardsSearch] : NSMakeRange(NSNotFound, 0);
  if (dash.location == NSNotFound) return 0;
  char host[256] = {0};
  if (gethostname(host, sizeof host - 1) != 0 || ![[target substringToIndex:dash.location] isEqualToString:@(host)]) return 0;
  const pid_t pid = (pid_t)[target substringFromIndex:dash.location + 1].intValue;
  if (pid <= 1 || pid == getpid() || kill(pid, 0) != 0) return 0;
  NSRunningApplication *running = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (!running || running.terminated || ![running.bundleIdentifier isEqualToString:NSBundle.mainBundle.bundleIdentifier]) return 0;
  return pid;
}

static bool LaunchNamesDocuments(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    const char *arg = argv[i];
    if (!arg || arg[0] == '-') {
      if (arg && arg[0] == '-' && arg[1] != '-' && strncmp(arg, "-psn_", 5) != 0 && i + 1 < argc) i++;
      continue;
    }
    return true;
  }
  return false;
}

static bool ShowsAWindow() {
  for (NSWindow *window in NSApp.windows)
    if (window.isVisible && !window.isMiniaturized && ![window isKindOfClass:NSPanel.class] && window.frame.size.width >= 300) return true;
  return false;
}

static void AnswerOnceShown(NSString *chromiumDirectory, int triesLeft) {
  if (ShowsAWindow()) {
    [NSDistributedNotificationCenter.defaultCenter postNotificationName:kRunningInstanceReopened
                                                                 object:chromiumDirectory
                                                               userInfo:nil
                                                                options:NSDistributedNotificationDeliverImmediately];
    return;
  }
  if (triesLeft <= 0) return;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    AnswerOnceShown(chromiumDirectory, triesLeft - 1);
  });
}

namespace ardia_host {

bool HandOffToRunningInstance(NSString *chromiumDirectory, int argc, char **argv, bool background) {
  if (LaunchNamesDocuments(argc, argv)) return false;
  const pid_t pid = InstanceHoldingDataDirectory(chromiumDirectory);
  if (!pid) return false;
  NSDistributedNotificationCenter *center = NSDistributedNotificationCenter.defaultCenter;
  __block bool answered = false;
  id observer = [center addObserverForName:kRunningInstanceReopened object:chromiumDirectory queue:nil usingBlock:^(NSNotification *) { answered = true; }];
  [center postNotificationName:kReopenRunningInstance object:chromiumDirectory userInfo:nil options:NSDistributedNotificationDeliverImmediately];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:kRunningInstanceAnswerSeconds];
  while (!answered && kill(pid, 0) == 0 && deadline.timeIntervalSinceNow > 0)
    [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
  [center removeObserver:observer];
  if (!answered) {
    fprintf(stderr, "[ardiacore] the Ardia that held this data dir (pid %d) didn't answer; launching\n", pid);
    return false;
  }
  if (!background) [[NSRunningApplication runningApplicationWithProcessIdentifier:pid] activateWithOptions:NSApplicationActivateAllWindows];
  fprintf(stderr, "[ardiacore] Ardia is already running on this data dir (pid %d): it opened a window\n", pid);
  return true;
}

void ReopenWhenRelaunched(NSString *chromiumDirectory) {
  [NSDistributedNotificationCenter.defaultCenter addObserverForName:kReopenRunningInstance
                                                             object:chromiumDirectory
                                                              queue:NSOperationQueue.mainQueue
                                                         usingBlock:^(NSNotification *) {
                                                           id<NSApplicationDelegate> delegate = NSApp.delegate;
                                                           if (![delegate respondsToSelector:@selector(applicationShouldHandleReopen:hasVisibleWindows:)]) return;
                                                           [delegate applicationShouldHandleReopen:NSApp hasVisibleWindows:ShowsAWindow()];
                                                           AnswerOnceShown(chromiumDirectory, kRunningInstanceShowTries);
                                                         }];
}

}
