#include "ardia/linux/ui_host/modules.h"

#include <string>

#include "base/functional/bind.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

class RecordingSink : public ModuleEventSink {
 public:
  void OnModuleEvent(std::string_view module,
                     std::string_view event,
                     const base::Value& payload) override {
    seen = std::string(module) + "." + std::string(event);
    value = payload.Clone();
  }
  std::string seen;
  base::Value value;
};

}

TEST(ModuleRegistryTest, ShapesListMethodsAndConstants) {
  ModuleRegistry registry;
  registry.Define("ArdiaApp")
      .Sync("systemInfo", base::BindRepeating([](const base::ListValue&) {
              return ModuleResult(base::Value("info"));
            }))
      .Async("appIcons", base::BindRepeating([](base::ListValue,
                                                ModuleReply reply) {
               std::move(reply).Run(base::Value(base::ListValue()));
             }))
      .Constant("linuxBackend", base::Value("chromium"));
  base::DictValue shapes = registry.Shapes();
  const base::DictValue* app = shapes.FindDict("ArdiaApp");
  ASSERT_TRUE(app);
  EXPECT_EQ(app->FindList("sync")->front().GetString(), "systemInfo");
  EXPECT_EQ(app->FindList("async")->front().GetString(), "appIcons");
  EXPECT_EQ(*app->FindDict("constants")->FindString("linuxBackend"),
            "chromium");
}

TEST(ModuleRegistryTest, CallsAnswerAndFail) {
  ModuleRegistry registry;
  registry.Define("ArdiaDocuments")
      .Sync("readDocument",
            base::BindRepeating([](const base::ListValue& args) {
              if (args.empty() || !args.front().is_string()) {
                return ModuleFailure("a name is needed", "ERR_ARGS");
              }
              return ModuleResult(base::Value(args.front().GetString() + "!"));
            }));
  base::ListValue args;
  args.Append("session");
  ModuleResult read = registry.CallSync("ArdiaDocuments", "readDocument", args);
  ASSERT_TRUE(read.has_value());
  EXPECT_EQ(read->GetString(), "session!");

  ModuleResult refused =
      registry.CallSync("ArdiaDocuments", "readDocument", base::ListValue());
  ASSERT_FALSE(refused.has_value());
  EXPECT_EQ(refused.error().code, "ERR_ARGS");

  EXPECT_FALSE(registry.CallSync("ArdiaDocuments", "nothing", args).has_value());
  EXPECT_FALSE(registry.CallSync("ArdiaNothing", "x", args).has_value());

  std::string async_answer;
  registry.Call("ArdiaDocuments", "readDocument", args.Clone(),
                base::BindOnce(
                    [](std::string* out, ModuleResult result) {
                      *out = result->GetString();
                    },
                    &async_answer));
  EXPECT_EQ(async_answer, "session!");
  EXPECT_EQ(registry.TakeSyncTimings().calls, 3);
}

TEST(ModuleRegistryTest, EventsReachSinks) {
  ModuleRegistry registry;
  RecordingSink sink;
  registry.AddEventSink(&sink);
  registry.Emit("ArdiaEngineHost", "event", base::Value(1));
  EXPECT_EQ(sink.seen, "ArdiaEngineHost.event=1\n");
  registry.RemoveEventSink(&sink);
}

}
