#pragma once

#include <string>
#include <string_view>
#include <vector>

namespace base {

class FeatureList {
 public:
  static std::vector<std::string_view> SplitFeatureListString(std::string_view input) {
    std::vector<std::string_view> pieces;
    for (std::string_view piece : Split(input, ',')) {
      piece = Trim(piece);
      if (!piece.empty()) {
        pieces.push_back(piece);
      }
    }
    return pieces;
  }

  static bool ParseEnableFeatureString(std::string_view enable_feature,
                                       std::string* feature_name,
                                       std::string* study_name,
                                       std::string* group_name,
                                       std::string* params) {
    std::string_view first;
    std::string feature_params;
    if (!SplitIntoTwo(enable_feature, ':', &first, &feature_params)) {
      return false;
    }
    std::string group;
    if (!SplitIntoTwo(first, '.', &first, &group)) {
      return false;
    }
    std::string study;
    if (!SplitIntoTwo(first, '<', &first, &study)) {
      return false;
    }
    std::string name(first);
    if (!feature_params.empty()) {
      study = study.empty() ? "Study" + name : study;
      group = group.empty() ? "Group" + name : group;
    }
    *feature_name = name;
    *study_name = study;
    *group_name = group;
    *params = feature_params;
    return true;
  }

 private:
  static std::vector<std::string_view> Split(std::string_view text, char separator) {
    std::vector<std::string_view> parts;
    size_t start = 0;
    for (size_t at = text.find(separator); at != std::string_view::npos; at = text.find(separator, start)) {
      parts.push_back(text.substr(start, at - start));
      start = at + 1;
    }
    parts.push_back(text.substr(start));
    return parts;
  }

  static std::string_view Trim(std::string_view text) {
    const size_t begin = text.find_first_not_of(" \t\r\n");
    if (begin == std::string_view::npos) {
      return {};
    }
    return text.substr(begin, text.find_last_not_of(" \t\r\n") - begin + 1);
  }

  static bool SplitIntoTwo(std::string_view text, char separator, std::string_view* first, std::string* second) {
    std::vector<std::string_view> parts = Split(text, separator);
    if (parts.size() > 2) {
      return false;
    }
    if (parts.size() == 2) {
      *second = std::string(Trim(parts[1]));
    }
    *first = Trim(parts[0]);
    return true;
  }
};

}
