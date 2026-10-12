cask "qtv" do
  version "1.1.2"
  sha256 "6d651ef198d84e171c2870cf68be7ad292d1b1f4e0d0928455cd1a132c9723fc"

  url "https://github.com/qinxianhahaha/QTV/releases/download/v#{version}/QTV_#{version}_aarch64.dmg"
  name "QTV"
  desc "Favorites-first live-stream player"
  homepage "https://github.com/qinxianhahaha/QTV"

  depends_on macos: :monterey
  depends_on arch: :arm64

  app "QTV.app"
end
