#ifndef ARDIA_WIN_PROFILES_H_
#define ARDIA_WIN_PROFILES_H_

#include <string>
#include <string_view>

#include "base/files/file_path.h"
#include "base/functional/callback.h"

class Profile;

namespace ardia_win {

struct ProfileName {
  std::string directory;
  bool off_the_record = false;
};

ProfileName ParseProfileName(std::string_view name,
                             std::string_view empty_original = {});

base::FilePath ProfilePath(const ProfileName& name);

void WithProfile(std::string_view name,
                 base::OnceCallback<void(Profile*)> callback,
                 std::string_view empty_original = {});

std::string NameOfProfile(Profile* profile);

std::string NameOfProfilePath(const base::FilePath& path);

}

#endif
