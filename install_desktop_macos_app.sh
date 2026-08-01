#!/bin/zsh
set -e

APP_DIR="${0:A:h}"
APP_NAME="Codex合并台桌面版"
TARGET="$APP_DIR/$APP_NAME.app"
CONTENTS="$TARGET/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
# 最低支持的 macOS 版本（Intel 与 Apple Silicon 通用）
MIN_MACOS="${MIN_MACOS:-11.0}"

mkdir -p "$MACOS" "$RESOURCES"
rm -f "$MACOS/CodexSessionDesktop"
cp "$APP_DIR/server.py" "$RESOURCES/server.py"
cp "$APP_DIR/index.html" "$RESOURCES/index.html"
cp "$APP_DIR/app.js" "$RESOURCES/app.js"
cp "$APP_DIR/styles.css" "$RESOURCES/styles.css"
cp "$APP_DIR/AppIcon.icns" "$RESOURCES/AppIcon.icns"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>CodexSessionStudio</string>
  <key>CFBundleIdentifier</key>
  <string>local.codex.session.studio</string>
  <key>CFBundleName</key>
  <string>Codex Session Studio</string>
  <key>CFBundleDisplayName</key>
  <string>Codex Session Studio</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>2.1</string>
  <key>CFBundleVersion</key>
  <string>3</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_MACOS</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

# 编译 Intel + Apple Silicon 通用二进制，兼容多版本 Mac
build_slice() {
  xcrun swiftc \
    -O \
    -target "$1-apple-macos$MIN_MACOS" \
    -framework AppKit \
    -framework WebKit \
    "$APP_DIR/macos_app.swift" \
    -o "$2"
}
build_slice arm64 "$MACOS/.studio-arm64"
build_slice x86_64 "$MACOS/.studio-x86_64"
lipo -create "$MACOS/.studio-arm64" "$MACOS/.studio-x86_64" -output "$MACOS/CodexSessionStudio.bin"
rm -f "$MACOS/.studio-arm64" "$MACOS/.studio-x86_64"

# 启动脚本：路径全部相对自身推导，App 拷到任何位置/任何机器都能运行
cat > "$MACOS/CodexSessionStudio" <<'LAUNCHER'
#!/bin/zsh
SELF_DIR="${0:A:h}"
export CODEX_SESSION_APP_DIR="$SELF_DIR/../Resources"
for candidate in \
  /Library/Frameworks/Python.framework/Versions/3.12/bin/python3 \
  /Library/Frameworks/Python.framework/Versions/3.11/bin/python3 \
  /opt/homebrew/bin/python3 \
  /usr/local/bin/python3 \
  /usr/bin/python3; do
  if [[ -x "$candidate" ]]; then
    export CODEX_SESSION_PYTHON="$candidate"
    break
  fi
done
[[ -n "$CODEX_SESSION_PYTHON" ]] || export CODEX_SESSION_PYTHON="$(command -v python3)"
exec "$SELF_DIR/CodexSessionStudio.bin"
LAUNCHER
chmod +x "$MACOS/CodexSessionStudio"

rm -f "$MACOS/launch-environment"

# 本地自签名，减少「已损坏」提示（跨机器分发仍需右键打开或 xattr -dr com.apple.quarantine）
codesign --force --deep -s - "$TARGET" 2>/dev/null || true

echo "Created $TARGET"
lipo -info "$MACOS/CodexSessionStudio.bin"
