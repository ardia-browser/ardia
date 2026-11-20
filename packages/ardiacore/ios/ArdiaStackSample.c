#include "ArdiaStackSample.h"

#include <mach/mach_vm.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <unistd.h>

static const uint64_t kAddressMask = 0x00007fffffffffffull;

bool ArdiaSampledThreadInit(ArdiaSampledThread *thread, pthread_t pthread) {
  const uintptr_t high = (uintptr_t)pthread_get_stackaddr_np(pthread);
  const size_t size = pthread_get_stacksize_np(pthread);
  if (!high || !size || size > high) return false;
  thread->port = pthread_mach_thread_np(pthread);
  thread->stackHigh = high;
  thread->stackLow = high - size;
  return thread->port != MACH_PORT_NULL;
}

bool ArdiaDebuggerAttached(void) {
  struct kinfo_proc info = {0};
  size_t size = sizeof info;
  int name[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
  if (sysctl(name, 4, &info, &size, NULL, 0) != 0) return true;
  return (info.kp_proc.p_flag & P_TRACED) != 0;
}

static bool ReadFrameRecord(uintptr_t fp, uint64_t record[2]) {
  mach_vm_size_t got = 0;
  return mach_vm_read_overwrite(mach_task_self(), fp, 2 * sizeof(uint64_t), (mach_vm_address_t)record, &got) == KERN_SUCCESS && got == 2 * sizeof(uint64_t);
}

static bool HeldElsewhere(thread_t port, int32_t *runState) {
  struct thread_basic_info info;
  mach_msg_type_number_t count = THREAD_BASIC_INFO_COUNT;
  if (thread_info(port, THREAD_BASIC_INFO, (thread_info_t)&info, &count) != KERN_SUCCESS) return true;
  *runState = info.run_state;
  return info.suspend_count > 0;
}

bool ArdiaStackSampleTake(const ArdiaSampledThread *thread, ArdiaStackSample *sample) {
#if defined(__arm64__)
  sample->count = 0;
  sample->runState = 0;
  if (thread->port == MACH_PORT_NULL || thread->port == pthread_mach_thread_np(pthread_self())) return false;
  if (HeldElsewhere(thread->port, &sample->runState)) return false;
  if (thread_suspend(thread->port) != KERN_SUCCESS) return false;
  arm_thread_state64_t state;
  mach_msg_type_number_t count = ARM_THREAD_STATE64_COUNT;
  uint32_t n = 0;
  if (thread_get_state(thread->port, ARM_THREAD_STATE64, (thread_state_t)&state, &count) == KERN_SUCCESS) {
    const uint64_t pc = __darwin_arm_thread_state64_get_pc(state) & kAddressMask;
    const uint64_t lr = __darwin_arm_thread_state64_get_lr(state) & kAddressMask;
    uintptr_t fp = (uintptr_t)__darwin_arm_thread_state64_get_fp(state);
    if (pc) sample->frames[n++] = pc;
    if (lr && n < kArdiaStackFrames) sample->frames[n++] = lr;
    while (n < kArdiaStackFrames) {
      if (fp & 0xf) break;
      if (fp < thread->stackLow || fp > thread->stackHigh - 2 * sizeof(uint64_t)) break;
      uint64_t record[2];
      if (!ReadFrameRecord(fp, record)) break;
      const uintptr_t next = (uintptr_t)record[0];
      const uint64_t ret = record[1] & kAddressMask;
      if (!ret) break;
      if (!(n == 2 && ret == lr)) sample->frames[n++] = ret;
      if (next <= fp) break;
      fp = next;
    }
  }
  thread_resume(thread->port);
  sample->count = n;
  return n > 0;
#else
  (void)thread;
  sample->count = 0;
  return false;
#endif
}
