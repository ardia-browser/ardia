// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/location.h"

#include <cmath>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/ref_counted.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/process/launch.h"
#include "base/strings/string_split.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/timer/timer.h"
#include "components/dbus/thread_linux/dbus_thread_linux.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "dbus/bus.h"
#include "dbus/message.h"
#include "dbus/object_path.h"
#include "dbus/object_proxy.h"
#include "services/device/public/cpp/geolocation/location_provider.h"
#include "services/device/public/mojom/geoposition.mojom.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaLocation";
constexpr char kGeoClue[] = "org.freedesktop.GeoClue2";
constexpr char kManagerPath[] = "/org/freedesktop/GeoClue2/Manager";
constexpr char kManager[] = "org.freedesktop.GeoClue2.Manager";
constexpr char kClient[] = "org.freedesktop.GeoClue2.Client";
constexpr char kLocation[] = "org.freedesktop.GeoClue2.Location";
constexpr char kProperties[] = "org.freedesktop.DBus.Properties";
constexpr uint32_t kAccuracyExact = 8;
constexpr int kCallTimeoutMs = 10000;
constexpr base::TimeDelta kFirstFixDeadline = base::Seconds(10);
constexpr base::TimeDelta kIdleStop = base::Minutes(5);
constexpr base::TimeDelta kRetryUnavailable = base::Seconds(60);

struct Fix {
  double latitude = 0;
  double longitude = 0;
  double accuracy = 1000;
  std::optional<double> altitude;
  std::optional<double> heading;
  std::optional<double> speed;
};

bool Usable(double value) {
  return std::isfinite(value) && value > -1e300;
}

device::mojom::GeopositionResultPtr ResultOf(const std::optional<Fix>& fix) {
  if (!fix) {
    return device::mojom::GeopositionResult::NewError(
        device::mojom::GeopositionError::New(
            device::mojom::GeopositionErrorCode::kPositionUnavailable,
            "The system location service isn't available.", ""));
  }
  auto position = device::mojom::Geoposition::New();
  position->latitude = fix->latitude;
  position->longitude = fix->longitude;
  position->accuracy = fix->accuracy;
  if (fix->altitude) {
    position->altitude = *fix->altitude;
  }
  if (fix->heading) {
    position->heading = *fix->heading;
  }
  if (fix->speed) {
    position->speed = *fix->speed;
  }
  position->timestamp = base::Time::Now();
  return device::mojom::GeopositionResult::NewPosition(std::move(position));
}

class Relay : public base::RefCountedThreadSafe<Relay> {
 public:
  using Deliver = base::RepeatingCallback<void(std::optional<Fix>)>;

  Relay(scoped_refptr<base::SequencedTaskRunner> runner, Deliver deliver)
      : runner_(std::move(runner)), deliver_(std::move(deliver)) {}

  void Send(std::optional<Fix> fix) {
    runner_->PostTask(FROM_HERE, base::BindOnce(deliver_, std::move(fix)));
  }

 private:
  friend class base::RefCountedThreadSafe<Relay>;
  ~Relay() = default;

  scoped_refptr<base::SequencedTaskRunner> runner_;
  Deliver deliver_;
};

class GeoClue {
 public:
  static GeoClue& Get() {
    static base::NoDestructor<GeoClue> geoclue;
    return *geoclue;
  }

  void Watch(scoped_refptr<Relay> relay) {
    ++requests_;
    idle_timer_.Stop();
    relays_.insert(relay);
    if (latest_) {
      relay->Send(latest_);
      return;
    }
    if (state_ == State::kUnavailable &&
        base::TimeTicks::Now() - unavailable_since_ < kRetryUnavailable) {
      relay->Send(std::nullopt);
      return;
    }
    first_fix_timer_.Start(FROM_HERE, kFirstFixDeadline,
                           base::BindOnce(&GeoClue::NoFirstFix,
                                          weak_factory_.GetWeakPtr()));
    if (state_ == State::kIdle || state_ == State::kUnavailable) {
      Start();
    }
  }

  void Unwatch(scoped_refptr<Relay> relay) {
    relays_.erase(relay);
    if (relays_.empty()) {
      idle_timer_.Start(FROM_HERE, kIdleStop,
                        base::BindOnce(&GeoClue::Stop,
                                       weak_factory_.GetWeakPtr()));
    }
  }

  bool DeniedByDesktop() const {
    if (state_ != State::kUnavailable) {
      return false;
    }
    return reason_.find("AccessDenied") != std::string::npos ||
           reason_.find("not allowed") != std::string::npos ||
           reason_.find("disabled") != std::string::npos;
  }

  int requests() const { return requests_; }

 private:
  friend class base::NoDestructor<GeoClue>;
  enum class State { kIdle, kStarting, kRunning, kUnavailable };

  GeoClue() = default;

  dbus::ObjectProxy* Proxy(const dbus::ObjectPath& path) {
    return bus_->GetObjectProxy(kGeoClue, path);
  }

  void Start() {
    state_ = State::kStarting;
    bus_ = dbus_thread_linux::GetSharedSystemBus();
    dbus::MethodCall call(kManager, "GetClient");
    Proxy(dbus::ObjectPath(kManagerPath))
        ->CallMethodWithErrorResponse(
            &call, kCallTimeoutMs,
            base::BindOnce(&GeoClue::GotClient, weak_factory_.GetWeakPtr()));
  }

  static std::string ErrorText(dbus::ErrorResponse* error,
                               std::string_view fallback) {
    if (!error) {
      return std::string(fallback);
    }
    std::string message;
    dbus::MessageReader(error).PopString(&message);
    return error->GetErrorName() + ": " + message;
  }

  void GotClient(dbus::Response* response, dbus::ErrorResponse* error) {
    dbus::ObjectPath path;
    if (!response || !dbus::MessageReader(response).PopObjectPath(&path)) {
      GiveUp(ErrorText(error, "GeoClue didn't answer"));
      return;
    }
    client_ = path;
    SetProperty("DesktopId", [](dbus::MessageWriter& writer) {
      writer.AppendVariantOfString("ardia");
    });
    SetProperty("RequestedAccuracyLevel", [](dbus::MessageWriter& writer) {
      writer.AppendVariantOfUint32(kAccuracyExact);
    });
    Proxy(client_)->ConnectToSignal(
        kClient, "LocationUpdated",
        base::BindRepeating(&GeoClue::LocationUpdated,
                            weak_factory_.GetWeakPtr()),
        base::DoNothing());
    dbus::MethodCall start(kClient, "Start");
    Proxy(client_)->CallMethodWithErrorResponse(
        &start, kCallTimeoutMs,
        base::BindOnce(&GeoClue::Started, weak_factory_.GetWeakPtr()));
  }

  template <typename Write>
  void SetProperty(const char* name, Write write) {
    dbus::MethodCall call(kProperties, "Set");
    dbus::MessageWriter writer(&call);
    writer.AppendString(kClient);
    writer.AppendString(name);
    write(writer);
    Proxy(client_)->CallMethod(&call, kCallTimeoutMs, base::DoNothing());
  }

  void Started(dbus::Response* response, dbus::ErrorResponse* error) {
    if (!response) {
      GiveUp(ErrorText(error, "GeoClue didn't start"));
      return;
    }
    state_ = State::kRunning;
    Note("geolocation", "GeoClue started");
    dbus::MethodCall call(kProperties, "Get");
    dbus::MessageWriter writer(&call);
    writer.AppendString(kClient);
    writer.AppendString("Location");
    Proxy(client_)->CallMethod(
        &call, kCallTimeoutMs,
        base::BindOnce(
            [](base::WeakPtr<GeoClue> self, dbus::Response* response) {
              dbus::ObjectPath location;
              if (self && response &&
                  dbus::MessageReader(response).PopVariantOfObjectPath(
                      &location) &&
                  location.value() != "/") {
                self->ReadFix(location);
              }
            },
            weak_factory_.GetWeakPtr()));
  }

  void LocationUpdated(dbus::Signal* signal) {
    dbus::MessageReader reader(signal);
    dbus::ObjectPath old_location;
    dbus::ObjectPath location;
    if (reader.PopObjectPath(&old_location) && reader.PopObjectPath(&location)) {
      ReadFix(location);
    }
  }

  void ReadFix(const dbus::ObjectPath& location) {
    dbus::MethodCall call(kProperties, "GetAll");
    dbus::MessageWriter(&call).AppendString(kLocation);
    Proxy(location)->CallMethod(
        &call, kCallTimeoutMs,
        base::BindOnce(&GeoClue::FixRead, weak_factory_.GetWeakPtr()));
  }

  void FixRead(dbus::Response* response) {
    if (!response) {
      return;
    }
    dbus::MessageReader reader(response);
    dbus::MessageReader properties(nullptr);
    if (!reader.PopArray(&properties)) {
      return;
    }
    std::map<std::string, double> values;
    while (properties.HasMoreData()) {
      dbus::MessageReader entry(nullptr);
      std::string name;
      double value = 0;
      if (!properties.PopDictEntry(&entry) || !entry.PopString(&name)) {
        return;
      }
      if (entry.PopVariantOfDouble(&value)) {
        values[name] = value;
      }
    }
    if (!values.contains("Latitude") || !values.contains("Longitude") ||
        !Usable(values["Latitude"]) || !Usable(values["Longitude"])) {
      return;
    }
    Fix fix;
    fix.latitude = values["Latitude"];
    fix.longitude = values["Longitude"];
    if (values.contains("Accuracy") && Usable(values["Accuracy"])) {
      fix.accuracy = values["Accuracy"];
    }
    if (values.contains("Altitude") && Usable(values["Altitude"])) {
      fix.altitude = values["Altitude"];
    }
    if (values.contains("Heading") && Usable(values["Heading"]) &&
        values["Heading"] >= 0) {
      fix.heading = values["Heading"];
    }
    if (values.contains("Speed") && Usable(values["Speed"]) &&
        values["Speed"] >= 0) {
      fix.speed = values["Speed"];
    }
    latest_ = fix;
    first_fix_timer_.Stop();
    for (const scoped_refptr<Relay>& relay : relays_) {
      relay->Send(latest_);
    }
  }

  void NoFirstFix() {
    if (latest_) {
      return;
    }
    for (const scoped_refptr<Relay>& relay : relays_) {
      relay->Send(std::nullopt);
    }
  }

  void GiveUp(const std::string& reason) {
    CountLinux("location_unavailable");
    if (state_ != State::kUnavailable) {
      Note("geolocation",
           "GeoClue isn't available, so pages get \"position unavailable\": " +
               reason);
    }
    state_ = State::kUnavailable;
    unavailable_since_ = base::TimeTicks::Now();
    reason_ = reason;
    latest_.reset();
    client_ = dbus::ObjectPath();
    first_fix_timer_.Stop();
    for (const scoped_refptr<Relay>& relay : relays_) {
      relay->Send(std::nullopt);
    }
  }

  void Stop() {
    if (state_ != State::kRunning && state_ != State::kStarting) {
      return;
    }
    if (client_.IsValid() && client_.value() != "/") {
      dbus::MethodCall call(kClient, "Stop");
      Proxy(client_)->CallMethod(&call, kCallTimeoutMs, base::DoNothing());
    }
    state_ = State::kIdle;
    latest_.reset();
    client_ = dbus::ObjectPath();
    Note("geolocation", "GeoClue stopped: no page asked for the location lately");
  }

  scoped_refptr<dbus::Bus> bus_;
  State state_ = State::kIdle;
  dbus::ObjectPath client_;
  std::optional<Fix> latest_;
  base::TimeTicks unavailable_since_;
  std::string reason_;
  std::set<scoped_refptr<Relay>> relays_;
  base::OneShotTimer first_fix_timer_;
  base::OneShotTimer idle_timer_;
  int requests_ = 0;
  base::WeakPtrFactory<GeoClue> weak_factory_{this};
};

class GeoClueLocationProvider : public device::LocationProvider {
 public:
  GeoClueLocationProvider() = default;
  ~GeoClueLocationProvider() override { StopProvider(); }

  void FillDiagnostics(device::mojom::GeolocationDiagnostics&) override {}

  void SetUpdateCallback(const LocationProviderUpdateCallback& callback)
      override {
    callback_ = callback;
  }

  void StartProvider(bool) override {
    if (relay_) {
      return;
    }
    relay_ = base::MakeRefCounted<Relay>(
        base::SequencedTaskRunner::GetCurrentDefault(),
        base::BindRepeating(&GeoClueLocationProvider::Delivered,
                            weak_factory_.GetWeakPtr()));
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE, base::BindOnce(
                       [](scoped_refptr<Relay> relay) {
                         GeoClue::Get().Watch(std::move(relay));
                       },
                       relay_));
  }

  void StopProvider() override {
    if (!relay_) {
      return;
    }
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE, base::BindOnce(
                       [](scoped_refptr<Relay> relay) {
                         GeoClue::Get().Unwatch(std::move(relay));
                       },
                       std::move(relay_)));
  }

  const device::mojom::GeopositionResult* GetPosition() override {
    return position_.get();
  }

  void OnPermissionGranted() override {}

 private:
  void Delivered(std::optional<Fix> fix) {
    position_ = ResultOf(fix);
    if (callback_) {
      callback_.Run(this, position_.Clone());
    }
  }

  scoped_refptr<Relay> relay_;
  LocationProviderUpdateCallback callback_;
  device::mojom::GeopositionResultPtr position_;
  base::WeakPtrFactory<GeoClueLocationProvider> weak_factory_{this};
};

std::string LocationPermission() {
  return GeoClue::Get().DeniedByDesktop() ? "servicesOff" : "granted";
}

void OpenLocationSettings() {
  if (CurrentLaunchConfig().background || CurrentLaunchConfig().test_instance) {
    Note("geolocation", "not opening the location settings in a test instance");
    return;
  }
  base::ThreadPool::PostTask(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce([] {
        std::unique_ptr<base::Environment> environment =
            base::Environment::Create();
        const std::vector<std::string> folders =
            base::SplitString(environment->GetVar("PATH").value_or(""), ":",
                              base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
        const std::pair<const char*, const char*> kSettings[] = {
            {"gnome-control-center", "location"},
            {"systemsettings", "kcm_location"}};
        for (const auto& [command, page] : kSettings) {
          for (const std::string& folder : folders) {
            base::FilePath path = base::FilePath(folder).Append(command);
            if (base::PathExists(path)) {
              base::LaunchOptions options;
              base::LaunchProcess({path.value(), page}, options);
              return;
            }
          }
        }
        Note("geolocation", "no location settings app to open");
      }));
}

}

std::unique_ptr<device::LocationProvider> CreateGeoClueLocationProvider() {
  return std::make_unique<GeoClueLocationProvider>();
}

void RegisterLocationModule(ModuleRegistry& registry) {
  registry.Define(kModule)
      .Async("locationPermission", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value(LocationPermission()));
             }))
      .Async("requestLocationPermission", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value(LocationPermission()));
             }))
      .Async("openLocationSettings", AnswerOf([](const base::ListValue&) {
               OpenLocationSettings();
               return ModuleResult(base::Value());
             }))
      .Async("devLocationRequests", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value(GeoClue::Get().requests()));
             }));
}

}
