// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_APP_LIFETIME_H_
#define ARDIA_LINUX_APP_LIFETIME_H_

#include <memory>

#include "base/memory/weak_ptr.h"
#include "base/timer/timer.h"

class ScopedKeepAlive;

namespace ardia_linux {

class AppLifetime {
 public:
  AppLifetime(const AppLifetime&) = delete;
  AppLifetime& operator=(const AppLifetime&) = delete;

  static AppLifetime& Get();

  void HoldKeepAlive();
  void WatchSignals();
  void RequestQuit();
  void ReplyToTerminate(bool ok);
  void Signalled(int signal);
  void Release();

  bool quitting() const { return quitting_; }
  bool finished() const { return finished_; }

 private:
  AppLifetime();
  ~AppLifetime();

  void AnswerOverdue(int generation);
  void Finish();

  std::unique_ptr<ScopedKeepAlive> keep_alive_;
  bool quitting_ = false;
  bool finished_ = false;
  int generation_ = 0;
  base::OneShotTimer answer_timer_;
  base::OneShotTimer exit_deadline_;
  base::WeakPtrFactory<AppLifetime> weak_factory_{this};
};

}

#endif
