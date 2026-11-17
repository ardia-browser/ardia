#import "ArdiaLaunchSequence.h"

#include <sys/resource.h>

@interface ArdiaLaunchWaiter : NSObject
@property(nonatomic) ArdiaLaunchMilestone milestones;
@property(nonatomic, copy) dispatch_block_t block;
@end

@implementation ArdiaLaunchWaiter
@end

@interface ArdiaLaunchSequence ()
@property(atomic, strong, nullable) NSNumber *mainMajorFaults;
@property(atomic, strong, nullable) NSNumber *mainBlockInputs;
@property(atomic, strong, nullable) NSNumber *engineMajorFaults;
@property(atomic, strong, nullable) NSNumber *engineBlockInputs;
@end

// This process's page-in counters so far. False when getrusage fails, so the caller leaves its counters nil.
static BOOL ReadPageIn(long *majorFaults, long *blockInputs) {
  struct rusage usage;
  if (getrusage(RUSAGE_SELF, &usage) != 0) return NO;
  *majorFaults = usage.ru_majflt;
  *blockInputs = usage.ru_inblock;
  return YES;
}

@implementation ArdiaLaunchSequence {
  ArdiaLaunchMilestone _reached;
  NSMutableArray<ArdiaLaunchWaiter *> *_waiters;
}

+ (ArdiaLaunchSequence *)shared {
  static ArdiaLaunchSequence *shared = [ArdiaLaunchSequence new];
  return shared;
}

- (instancetype)init {
  if ((self = [super init])) _waiters = [NSMutableArray array];
  return self;
}

- (BOOL)reached:(ArdiaLaunchMilestone)milestones {
  return (_reached & milestones) == milestones;
}

- (void)reach:(ArdiaLaunchMilestone)milestone {
  if (_shutDown) return;
  _reached |= milestone;
  for (;;) {
    NSUInteger ready = [_waiters indexOfObjectPassingTest:^BOOL(ArdiaLaunchWaiter *waiter, NSUInteger, BOOL *) {
      return [self reached:waiter.milestones];
    }];
    if (ready == NSNotFound || _shutDown) return;
    ArdiaLaunchWaiter *waiter = _waiters[ready];
    [_waiters removeObjectAtIndex:ready];
    waiter.block();
  }
}

- (void)appKitFinishedHidden:(BOOL)hidden forDocuments:(BOOL)documents {
  _launchedHidden = hidden;
  _launchedForDocuments = documents;
  [self reach:ArdiaLaunchAppKitDidFinish];
}

- (void)stampMainPageIn {
  long faults = 0, blocks = 0;
  if (!ReadPageIn(&faults, &blocks)) return;
  self.mainMajorFaults = @(faults);
  self.mainBlockInputs = @(blocks);
}

- (void)stampEnginePageIn {
  long faults = 0, blocks = 0;
  if (!ReadPageIn(&faults, &blocks)) return;
  self.engineMajorFaults = @(faults);
  self.engineBlockInputs = @(blocks);
}

- (void)after:(ArdiaLaunchMilestone)milestones do:(dispatch_block_t)block {
  if (_shutDown) return;
  ArdiaLaunchWaiter *waiter = [ArdiaLaunchWaiter new];
  waiter.milestones = milestones;
  waiter.block = block;
  [_waiters addObject:waiter];
  [self reach:0];
}

- (void)engineShutDown {
  _engineRunning = NO;
  _shutDown = YES;
  [_waiters removeAllObjects];
}

@end
