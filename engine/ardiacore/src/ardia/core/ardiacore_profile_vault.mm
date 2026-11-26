#import "ardia/core/public/ArdiaCore.h"

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "ardia/core/ac_vault_sign_in.h"
#include "ardia/core/ac_vault_transfer.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/strings/sys_string_conversions.h"
#include "chrome/browser/profiles/profile.h"
#include "net/base/schemeful_site.h"
#include "net/base/url_util.h"
#import "ardia/core/ardiacore_internal.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/url_constants.h"

namespace {

bool IsWebOrigin(const url::Origin& origin) {
  return !origin.opaque() && (origin.scheme() == url::kHttpsScheme ||
                              (origin.scheme() == url::kHttpScheme &&
                               net::IsLocalhost(origin.GetURL())));
}

NSDictionary<NSString*, id>* Refused(NSString* status) {
  return @{@"status" : status, @"readyMs" : @(-1), @"fillMs" : @(-1), @"totalMs" : @0};
}

}

@implementation ArdiaCoreVaultSignIn {
  base::OnceClosure _cancel;
}

- (void)setCancel:(base::OnceClosure)cancel {
  _cancel = std::move(cancel);
}

- (void)cancel {
  if (![NSThread isMainThread]) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [self cancel];
    });
    return;
  }
  if (_cancel) {
    std::move(_cancel).Run();
  }
}

@end

@implementation ArdiaCoreProfile (Vault)

- (ArdiaCoreVaultSignIn*)vaultSignInAtURL:(NSURL*)url
                                   origin:(NSString*)origin
                                 username:(NSString*)username
                             codeProvider:(nullable void (^)(ArdiaCoreVaultCodeReply reply))codeProvider
                               completion:(void (^)(NSDictionary<NSString*, id>* result))completion {
  ArdiaCoreVaultSignIn* handle = [[ArdiaCoreVaultSignIn alloc] init];
  void (^answer)(NSDictionary<NSString*, id>*) = [completion copy];
  Profile* profile = self.chromeProfile;
  const GURL target(base::SysNSStringToUTF8(url.absoluteString ?: @""));
  const url::Origin saved =
      url::Origin::Create(GURL(base::SysNSStringToUTF8(origin ?: @"")));
  if (!profile || profile->IsOffTheRecord() ||
      ardiacore::IsProfileDying(profile) || !target.is_valid() ||
      !IsWebOrigin(url::Origin::Create(target)) || !IsWebOrigin(saved) ||
      username.length == 0) {
    dispatch_async(dispatch_get_main_queue(), ^{
      answer(Refused(@"failed"));
    });
    return handle;
  }
  if (net::SchemefulSite(saved) !=
      net::SchemefulSite(url::Origin::Create(target))) {
    dispatch_async(dispatch_get_main_queue(), ^{
      answer(Refused(@"cross_origin"));
    });
    return handle;
  }
  ardiacore::VaultSignInRequest request;
  request.url = target;
  request.origin = saved;
  request.username = base::SysNSStringToUTF16(username);
  if (codeProvider) {
    void (^provide)(ArdiaCoreVaultCodeReply) = [codeProvider copy];
    request.code_provider = base::BindRepeating(
        [](void (^provide)(ArdiaCoreVaultCodeReply), ardiacore::VaultCodeReply reply) {
          auto pending =
              std::make_shared<ardiacore::VaultCodeReply>(std::move(reply));
          provide(^(NSString* _Nullable code) {
            std::optional<std::u16string> value;
            if (code.length) {
              value = base::SysNSStringToUTF16(code);
            }
            dispatch_async(dispatch_get_main_queue(), ^{
              if (*pending) {
                std::move(*pending).Run(value);
              }
            });
          });
        },
        provide);
  }
  [handle setCancel:ardiacore::StartVaultSignIn(
                        profile, std::move(request),
                        base::BindOnce(^(NSDictionary<NSString*, id>* result) {
                          answer(result);
                        }))];
  return handle;
}

+ (void)setVaultTransferHoldForTesting:(NSTimeInterval)seconds {
  const base::TimeDelta hold = base::Seconds(std::max(0.0, seconds));
  dispatch_async(dispatch_get_main_queue(), ^{
    ardiacore::SetVaultTransferHoldForTesting(hold);
  });
}

@end
