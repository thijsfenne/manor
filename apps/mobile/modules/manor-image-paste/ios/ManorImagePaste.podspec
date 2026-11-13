Pod::Spec.new do |s|
  s.name           = 'ManorImagePaste'
  s.version        = '0.1.0'
  s.summary        = "Manor's iOS composer image-paste bridge"
  s.description    = "Adds image paste to React Native's multiline text input without replacing it."
  s.license        = { :type => 'MIT' }
  s.author         = 'Thijs Fenne'
  s.homepage       = 'https://github.com/thijsfenne/manor'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }

  s.dependency 'ExpoModulesCore'

  s.static_framework = true
  s.source_files = '**/*.{h,m,swift}'
end
