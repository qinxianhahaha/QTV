#!/usr/bin/env python3
"""Verify the signed distribution bundle, including V8's required JIT entitlement."""
import pathlib
import plistlib
import subprocess
import sys

app = pathlib.Path(sys.argv[1])
architecture = sys.argv[2]
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
entitlements = subprocess.check_output(["codesign", "-d", "--entitlements", "-", "--xml", str(app)])
assert plistlib.loads(entitlements).get("com.apple.security.cs.allow-jit") is True, "V8 JIT entitlement missing"
info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
assert info["CFBundleIdentifier"] == "io.github.qinxianhahaha.qtv"
executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
subprocess.run(["lipo", "-verify_arch", architecture, str(executable)], check=True)
resources = app / "Contents/Resources/resources"
for name in ("QTV-AGPL-3.0.txt", "DTV-MIT.txt", "biliup-LICENSE.txt", "crypto-js-LICENSE.txt"):
    assert (resources / name).is_file(), f"Missing license: {name}"
print(f"Verified QTV {info['CFBundleShortVersionString']} ({architecture}), signature, JIT and licenses")
