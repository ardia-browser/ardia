#ifndef ARDIA_CORE_AC_LOGIN_FORMS_H_
#define ARDIA_CORE_AC_LOGIN_FORMS_H_

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "components/autofill/core/common/unique_ids.h"
#include "content/public/browser/global_routing_id.h"
#include "url/origin.h"

namespace content {
class RenderFrameHost;
class WebContents;
}

namespace password_manager {
class PasswordManagerInterface;
}

namespace ardiacore {

struct LoginForm {
  content::GlobalRenderFrameHostId frame;
  url::Origin origin;
  bool main_frame = false;
  bool same_origin_ancestors = false;
  autofill::FormRendererId form;
  autofill::FieldRendererId username;
  autofill::FieldRendererId password;
  autofill::FieldRendererId code;
  std::u16string password_name;
  std::u16string code_name;
  bool sign_up = false;
};

password_manager::PasswordManagerInterface* PasswordManagerFor(
    content::WebContents* contents);

class LoginFormIndex {
 public:
  explicit LoginFormIndex(content::WebContents* contents);
  ~LoginFormIndex();
  LoginFormIndex(const LoginFormIndex&) = delete;
  LoginFormIndex& operator=(const LoginFormIndex&) = delete;

  void SetChanged(base::RepeatingCallback<void(content::RenderFrameHost*)> changed);
  void SetLoginSucceeded(base::RepeatingClosure succeeded);
  std::vector<LoginForm> Forms(
      std::optional<url::Origin> origin,
      std::optional<content::GlobalRenderFrameHostId> only = std::nullopt) const;
  void Forget();

 private:
  class Observers;
  std::unique_ptr<Observers> observers_;
};

void WatchLoginForms(content::WebContents* contents);

}

#endif
