#ifndef ARDIA_CORE_AC_PASSWORD_PROMPT_H_
#define ARDIA_CORE_AC_PASSWORD_PROMPT_H_

#import <Foundation/Foundation.h>

namespace content {
class WebContents;
}

namespace ardiacore {

NSDictionary<NSString*, id>* PasswordPrompt(content::WebContents* contents);

NSDictionary<NSString*, NSString*>* PendingLogin(content::WebContents* contents);

void PasswordPromptShown(content::WebContents* contents);
void PasswordConfirmationShown(content::WebContents* contents);

void ResolvePasswordPrompt(content::WebContents* contents,
                           NSString* action,
                           NSString* username,
                           NSString* password);

}

#endif
