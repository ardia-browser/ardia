system(File.expand_path('../../core-rs/scripts/build-xcframework.sh', __dir__), exception: true, out: :err)

Pod::Spec.new do |s|
  s.name           = 'ArdiaSync'
  s.version        = '0.0.0'
  s.summary        = 'End-to-end-encrypted sync through a folder the user chooses'
  s.author         = ''
  s.homepage       = 'https://github.com/ardia'
  s.license        = 'Apache-2.0'
  s.platforms      = { :osx => '14.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.dependency 'ArdiaCore'
  s.frameworks     = 'AppKit', 'CoreImage', 'CoreServices', 'Security'
  s.source_files   = 'SyncModule.swift', 'SharedFoldersModule.swift', 'SharedFolderWatcher.swift', 'SyncNative.swift', 'Core/**/*.swift'
  s.vendored_frameworks = 'Frameworks/ArdiaCoreRS.xcframework'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
