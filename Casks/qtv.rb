cask "qtv" do
  arch arm: "aarch64", intel: "x64"

  version "1.0.0"
  sha256 arm:   "7eecafcddb4f3553d39b5b4c864589a6455e06a7529d6f0629dcee76332196a4",
         intel: "b08ba0d72c1d28894e646d08f7ea2c24dc9d31f55e2f62fe4232bb4f04ba67bd"

  url "https://github.com/qinxianhahaha/QTV/releases/download/v#{version}/QTV_#{version}_#{arch}.dmg"
  name "QTV"
  desc "Favorites-first live-stream player"
  homepage "https://github.com/qinxianhahaha/QTV"

  depends_on macos: :monterey

  app "QTV.app"
end
