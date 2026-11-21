Pod::Spec.new do |s|
  s.name           = 'ArdiaShell'
  s.version        = '0.0.0'
  s.summary        = 'Window chrome and menus'
  s.author         = ''
  s.homepage       = 'https://github.com/ardia'
  s.license        = 'Apache-2.0'
  s.platforms      = { :osx => '14.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'ArdiaCore'
  s.dependency 'hermes-engine'
  s.dependency 'React-jsi'
  s.dependency 'Sparkle', '~> 2.9'
  s.frameworks     = 'AppKit', 'LocalAuthentication', 'ServiceManagement', 'UniformTypeIdentifiers', 'UserNotifications', 'CoreImage', 'EventKit', 'Security', 'NaturalLanguage', 'SwiftUI'
  s.weak_frameworks = 'Translation'
  s.source_files   = '**/*.{h,m,mm,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'HEADER_SEARCH_PATHS' => '"${PODS_ROOT}/hermes-engine/destroot/include"',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  }
end
