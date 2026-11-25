#import <Foundation/Foundation.h>

#include <atomic>
#include <pthread.h>

namespace ardia_freeze {

constexpr int kThreadCount = 2;

struct Stretch {
  std::atomic<uint64_t> start{0};
  std::atomic<uint64_t> id{0};
};

struct Ended {
  int thread;
  const Stretch *source;
  uint64_t id;
  double ms;
  double inputWaitMs;
  double gcMs;
  double gcCount;
  uint64_t epoch;
};

void Watch(int thread, pthread_t pthread, const Stretch *stretch);
void Unwatch(int thread, const Stretch *stretch);
void Arm();
void Idle();
void StretchEnded(const Ended &ended);
void SetEmitter(void (^emit)(NSDictionary *record));
void Annotate(uint64_t freezeId, NSString *activity);

}
