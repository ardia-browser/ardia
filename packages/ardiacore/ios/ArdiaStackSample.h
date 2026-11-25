#ifndef ARDIA_STACK_SAMPLE_H
#define ARDIA_STACK_SAMPLE_H

#include <mach/mach.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum { kArdiaStackFrames = 24 };

typedef struct {
  thread_t port;
  uintptr_t stackLow;
  uintptr_t stackHigh;
} ArdiaSampledThread;

typedef struct {
  uint32_t count;
  int32_t runState;
  uint64_t frames[kArdiaStackFrames];
} ArdiaStackSample;

bool ArdiaSampledThreadInit(ArdiaSampledThread *thread, pthread_t pthread);
bool ArdiaStackSampleTake(const ArdiaSampledThread *thread, ArdiaStackSample *sample);
bool ArdiaDebuggerAttached(void);

#ifdef __cplusplus
}
#endif

#endif
