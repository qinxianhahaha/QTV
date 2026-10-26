cask "qtv" do
  version "1.1.5"
  sha256 "f3cd1e7e8d2e69642badc4163634ae8cff151b941eda672f5e6ac113ca55fed4"

  url "https://github.com/qinxianhahaha/QTV/releases/download/v#{version}/QTV_#{version}_aarch64.dmg"
  name "QTV"
  desc "Favorites-first live-stream player"
  homepage "https://github.com/qinxianhahaha/QTV"

  depends_on macos: :monterey
  depends_on arch: :arm64

  app "QTV.app"
end
