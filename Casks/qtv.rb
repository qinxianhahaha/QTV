cask "qtv" do
  version "1.1.1"
  sha256 "c78e0f06f410ded00aa4217c15d216a19697f2ec201f473e2533b456ba105e27"

  url "https://github.com/qinxianhahaha/QTV/releases/download/v#{version}/QTV_#{version}_aarch64.dmg"
  name "QTV"
  desc "Favorites-first live-stream player"
  homepage "https://github.com/qinxianhahaha/QTV"

  depends_on macos: :monterey
  depends_on arch: :arm64

  app "QTV.app"
end
