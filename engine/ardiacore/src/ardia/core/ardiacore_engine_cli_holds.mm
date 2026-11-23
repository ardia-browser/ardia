#import "ardia/core/public/ArdiaCore.h"

#include <utility>
#include <vector>

#include "ardia/core/ac_discard_veto.h"
#include "base/time/time.h"
#include "content/public/browser/web_contents.h"
#import "ardia/core/ardiacore_internal.h"

@implementation ArdiaCoreEngine (CliHolds)

+ (NSInteger)holdTabsForCli:(NSArray<ArdiaCoreTab*>*)tabs
                      until:(NSArray<NSNumber*>*)untilMs
                     marked:(NSMutableIndexSet*)marked {
  std::vector<std::pair<content::WebContents*, base::Time>> held;
  for (NSUInteger i = 0; i < tabs.count && i < untilMs.count; ++i) {
    held.emplace_back(tabs[i].contents,
                      base::Time::FromMillisecondsSinceUnixEpoch(
                          untilMs[i].doubleValue));
  }
  const std::vector<bool> placed = ardiacore::SetCliHeldTabs(held);
  for (size_t i = 0; i < placed.size(); ++i) {
    if (placed[i]) {
      [marked addIndex:i];
    }
  }
  return ardiacore::TakeCliHoldVetoes();
}

@end
