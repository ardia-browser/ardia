// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_DBUS_SIGNAL_WATCH_H_
#define ARDIA_LINUX_DBUS_SIGNAL_WATCH_H_

#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"

namespace dbus {
class Bus;
class Signal;
}

namespace ardia_linux {

class SignalWatch {
 public:
  using OnSignal = base::RepeatingCallback<void(dbus::Signal* signal)>;
  using Started = base::OnceCallback<void(bool watching, std::string why)>;
  using Member = std::pair<std::string, std::string>;

  SignalWatch(scoped_refptr<dbus::Bus> bus,
              std::vector<std::string> match_rules,
              std::set<Member> members,
              OnSignal on_signal,
              Started started);
  SignalWatch(const SignalWatch&) = delete;
  SignalWatch& operator=(const SignalWatch&) = delete;
  ~SignalWatch();

  static std::string SignalRule(const std::string& sender,
                                const std::string& path,
                                const std::string& interface,
                                const std::string& member,
                                const std::string& arg0 = std::string());

 private:
  class Core;
  scoped_refptr<Core> core_;
};

}

#endif
