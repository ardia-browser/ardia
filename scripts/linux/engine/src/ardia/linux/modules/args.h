// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_ARGS_H_
#define ARDIA_LINUX_MODULES_ARGS_H_

#include <optional>
#include <string>

#include "ardia/linux/ui_host/modules.h"
#include "base/functional/bind.h"
#include "base/values.h"

namespace ardia_linux {

inline const base::Value* ArgAt(const base::ListValue& args, size_t index) {
  return index < args.size() ? &args[index] : nullptr;
}

inline std::string StringArg(const base::ListValue& args, size_t index) {
  const base::Value* value = ArgAt(args, index);
  if (!value) {
    return std::string();
  }
  if (value->is_string()) {
    return value->GetString();
  }
  if (value->is_int() || value->is_double()) {
    return value->DebugString();
  }
  return std::string();
}

inline std::optional<std::string> OptionalStringArg(
    const base::ListValue& args,
    size_t index) {
  const base::Value* value = ArgAt(args, index);
  return value && value->is_string() ? std::optional(value->GetString())
                                     : std::nullopt;
}

inline bool BoolArg(const base::ListValue& args, size_t index) {
  const base::Value* value = ArgAt(args, index);
  if (!value) {
    return false;
  }
  if (value->is_bool()) {
    return value->GetBool();
  }
  if (value->is_int()) {
    return value->GetInt() != 0;
  }
  if (value->is_double()) {
    return value->GetDouble() != 0;
  }
  if (value->is_string()) {
    return !value->GetString().empty();
  }
  return !value->is_none();
}

inline double NumberArg(const base::ListValue& args,
                        size_t index,
                        double fallback = 0) {
  const base::Value* value = ArgAt(args, index);
  if (!value) {
    return fallback;
  }
  return value->GetIfDouble().value_or(fallback);
}

inline const base::DictValue* DictArg(const base::ListValue& args,
                                      size_t index) {
  const base::Value* value = ArgAt(args, index);
  return value ? value->GetIfDict() : nullptr;
}

inline const base::ListValue* ListArg(const base::ListValue& args,
                                      size_t index) {
  const base::Value* value = ArgAt(args, index);
  return value ? value->GetIfList() : nullptr;
}

inline base::Value OrNull(std::optional<std::string> text) {
  return text ? base::Value(std::move(*text)) : base::Value();
}

template <typename Run>
SyncMethod SyncOf(Run run) {
  return base::BindRepeating(
      [](const Run& run, const base::ListValue& args) -> ModuleResult {
        return run(args);
      },
      std::move(run));
}

template <typename Run>
AsyncMethod AsyncOf(Run run) {
  return base::BindRepeating(
      [](const Run& run, base::ListValue args, ModuleReply reply) {
        run(std::move(args), std::move(reply));
      },
      std::move(run));
}

template <typename Run>
AsyncMethod AnswerOf(Run run) {
  return base::BindRepeating(
      [](const Run& run, base::ListValue args, ModuleReply reply) {
        std::move(reply).Run(run(args));
      },
      std::move(run));
}

}

#endif
