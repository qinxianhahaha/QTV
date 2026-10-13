cask "qtv" do
  version "1.1.3"
  sha256 "d4f3f2fdbae90fed6b8351cd552212eeca99869f44521318ad21e3cb018ac72b"

  url "https://github.com/qinxianhahaha/QTV/releases/download/v#{version}/QTV_#{version}_aarch64.dmg"
  name "QTV"
  desc "Favorites-first live-stream player"
  homepage "https://github.com/qinxianhahaha/QTV"

  depends_on macos: :monterey
  depends_on arch: :arm64

  app "QTV.app"
end
