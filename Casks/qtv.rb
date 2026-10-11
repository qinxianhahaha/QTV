cask "qtv" do
  version "1.1.0"
  sha256 "e52128c38aec0163fe6f00b18f4ccaf4604df59d65959af0d07591be8c90b6b4"

  url "https://github.com/qinxianhahaha/QTV/releases/download/v#{version}/QTV_#{version}_aarch64.dmg"
  name "QTV"
  desc "Favorites-first live-stream player"
  homepage "https://github.com/qinxianhahaha/QTV"

  depends_on macos: :monterey
  depends_on arch: :arm64

  app "QTV.app"
end
