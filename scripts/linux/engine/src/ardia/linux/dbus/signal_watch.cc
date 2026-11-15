// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/dbus/signal_watch.h"

#include <dbus/dbus.h>

#include "base/functional/bind.h"
#include "base/memory/ref_counted.h"
#include "base/sequence_checker.h"
#include "base/strings/strcat.h"
#include "base/task/sequenced_task_runner.h"
#include "dbus/bus.h"
#include "dbus/error.h"
#include "dbus/message.h"

namespace ardia_linux {

class SignalWatch::Core : public base::RefCountedThreadSafe<Core> {
 public:
  Core(scoped_refptr<dbus::Bus> bus,
       std::vector<std::string> match_rules,
       std::set<Member> members,
       OnSignal on_signal)
      : bus_(std::move(bus)),
        match_rules_(std::move(match_rules)),
        members_(std::move(members)),
        on_signal_(std::move(on_signal)),
        origin_(base::SequencedTaskRunner::GetCurrentDefault()) {}

  void Begin(Started started) {
    bus_->GetDBusTaskRunner()->PostTask(
        FROM_HERE, base::BindOnce(&Core::StartOnBus, this, std::move(started)));
  }

  void End() {
    DCHECK_CALLED_ON_VALID_SEQUENCE(origin_checker_);
    on_signal_.Reset();
    bus_->GetDBusTaskRunner()->PostTask(
        FROM_HERE, base::BindOnce(&Core::StopOnBus, this));
  }

 private:
  friend class base::RefCountedThreadSafe<Core>;
  ~Core() = default;

  void StartOnBus(Started started) {
    std::string why;
    bool watching = bus_->Connect();
    if (!watching) {
      why = "the bus didn't connect";
    } else {
      bus_->AddFilterFunction(&Core::Filter, this);
      filtering_ = true;
      for (const std::string& rule : match_rules_) {
        dbus::Error error;
        bus_->AddMatch(rule, &error);
        if (error.IsValid()) {
          watching = false;
          why = base::StrCat({error.name(), ": ", error.message()});
          break;
        }
        added_rules_.push_back(rule);
      }
    }
    origin_->PostTask(FROM_HERE,
                      base::BindOnce(std::move(started), watching, why));
  }

  void StopOnBus() {
    for (const std::string& rule : added_rules_) {
      dbus::Error error;
      bus_->RemoveMatch(rule, &error);
    }
    added_rules_.clear();
    if (filtering_) {
      bus_->RemoveFilterFunction(&Core::Filter, this);
      filtering_ = false;
    }
  }

  static DBusHandlerResult Filter(DBusConnection*,
                                  DBusMessage* raw,
                                  void* data) {
    static_cast<Core*>(data)->Heard(raw);
    return DBUS_HANDLER_RESULT_NOT_YET_HANDLED;
  }

  void Heard(DBusMessage* raw) {
    if (dbus_message_get_type(raw) != DBUS_MESSAGE_TYPE_SIGNAL) {
      return;
    }
    const char* interface = dbus_message_get_interface(raw);
    const char* member = dbus_message_get_member(raw);
    if (!interface || !member || !members_.contains({interface, member})) {
      return;
    }
    dbus_message_ref(raw);
    std::unique_ptr<dbus::Signal> signal = dbus::Signal::FromRawMessage(raw);
    if (!signal) {
      return;
    }
    origin_->PostTask(FROM_HERE, base::BindOnce(&Core::Deliver, this,
                                                std::move(signal)));
  }

  void Deliver(std::unique_ptr<dbus::Signal> signal) {
    DCHECK_CALLED_ON_VALID_SEQUENCE(origin_checker_);
    if (on_signal_) {
      on_signal_.Run(signal.get());
    }
  }

  scoped_refptr<dbus::Bus> bus_;
  const std::vector<std::string> match_rules_;
  const std::set<Member> members_;
  OnSignal on_signal_;
  scoped_refptr<base::SequencedTaskRunner> origin_;
  std::vector<std::string> added_rules_;
  bool filtering_ = false;
  SEQUENCE_CHECKER(origin_checker_);
};

SignalWatch::SignalWatch(scoped_refptr<dbus::Bus> bus,
                         std::vector<std::string> match_rules,
                         std::set<Member> members,
                         OnSignal on_signal,
                         Started started)
    : core_(base::MakeRefCounted<Core>(std::move(bus),
                                       std::move(match_rules),
                                       std::move(members),
                                       std::move(on_signal))) {
  core_->Begin(std::move(started));
}

SignalWatch::~SignalWatch() {
  core_->End();
}

std::string SignalWatch::SignalRule(const std::string& sender,
                                    const std::string& path,
                                    const std::string& interface,
                                    const std::string& member,
                                    const std::string& arg0) {
  std::string rule = "type='signal'";
  if (!sender.empty()) {
    base::StrAppend(&rule, {",sender='", sender, "'"});
  }
  if (!path.empty()) {
    base::StrAppend(&rule, {",path='", path, "'"});
  }
  base::StrAppend(&rule, {",interface='", interface, "',member='", member,
                          "'"});
  if (!arg0.empty()) {
    base::StrAppend(&rule, {",arg0='", arg0, "'"});
  }
  return rule;
}

}
