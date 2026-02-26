#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/Library/Logs/agent-visualization"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
APP_BUNDLE="$SCRIPT_DIR/menubar/AgentMenuBar.app"

# Check dependencies
if ! command -v node &> /dev/null; then
    echo "Error: node is not installed. Please install Node.js first."
    exit 1
fi

if ! command -v swiftc &> /dev/null; then
    echo "Error: swiftc is not found. Please install Xcode Command Line Tools:"
    echo "  xcode-select --install"
    exit 1
fi

NODE_PATH="$(which node)"
echo "=== Agent Visualization — Install ==="
echo ""
echo "  Node: $NODE_PATH"
echo "  Home: $HOME"
echo ""

# 1. Create directories
echo "[1/11] Creating directories..."
mkdir -p "$APP_BUNDLE/Contents/MacOS"
mkdir -p "$LOG_DIR"
mkdir -p "$LAUNCH_DIR"

# 2. Install npm dependencies
echo "[2/11] Installing npm dependencies..."
cd "$SCRIPT_DIR" && npm install --production 2>&1
echo "      Done."

# 3. Compile Swift menu bar app
echo "[3/11] Compiling menu bar app..."
swiftc \
  "$SCRIPT_DIR/menubar/AgentMenuBar.swift" \
  -o "$APP_BUNDLE/Contents/MacOS/AgentMenuBar" \
  -framework Cocoa \
  -framework UserNotifications 2>&1
echo "      Done."

# 4. Copy resources into app bundle
echo "[4/11] Copying resources..."
mkdir -p "$APP_BUNDLE/Contents/Resources"
if [ ! -f "$SCRIPT_DIR/Icon.png" ]; then
    echo "Error: Icon.png not found in $SCRIPT_DIR"
    exit 1
fi
cp "$SCRIPT_DIR/Icon.png" "$APP_BUNDLE/Contents/Resources/Icon.png"
echo "      Done."

# 5. Strip quarantine attributes
echo "[5/11] Stripping quarantine attributes..."
xattr -cr "$APP_BUNDLE"
echo "      Done."

# 6. Ad-hoc code sign (required for notifications)
echo "[6/11] Code signing..."
codesign --force --sign - "$APP_BUNDLE"
echo "      Done."

# 7. Generate LaunchAgent plist files
echo "[7/11] Generating LaunchAgent plists..."

cat > "$LAUNCH_DIR/com.agent-visualization.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-visualization</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$SCRIPT_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$SCRIPT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/server.err</string>
</dict>
</plist>
PLIST

cat > "$LAUNCH_DIR/com.agent-visualization.menubar.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agent-visualization.menubar</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP_BUNDLE/Contents/MacOS/AgentMenuBar</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/menubar.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/menubar.err</string>
</dict>
</plist>
PLIST

echo "      Done."

# 8. Stop existing services
echo "[8/11] Stopping existing services..."
pkill -f "AgentMenuBar" 2>/dev/null || true
launchctl unload "$LAUNCH_DIR/com.agent-visualization.plist" 2>/dev/null || true
launchctl unload "$LAUNCH_DIR/com.agent-visualization.menubar.plist" 2>/dev/null || true
sleep 1

# 9. Load server
echo "[9/11] Starting server..."
launchctl load "$LAUNCH_DIR/com.agent-visualization.plist"

# 10. Load menu bar app
echo "[10/11] Starting menu bar app..."
launchctl load "$LAUNCH_DIR/com.agent-visualization.menubar.plist"

# 11. Verify
echo "[11/11] Verifying..."
sleep 2
if curl -s http://localhost:1217/state > /dev/null 2>&1; then
  echo "      Server: OK"
else
  echo "      Server: FAILED (check $LOG_DIR/server.err)"
fi
if pgrep -f AgentMenuBar > /dev/null 2>&1; then
  echo "      Menu bar: OK"
else
  echo "      Menu bar: FAILED (check $LOG_DIR/menubar.err)"
fi

echo ""
echo "=== Install complete ==="
echo ""
echo "  Server:   http://localhost:1217"
echo "  Logs:     $LOG_DIR/"
echo "  Menu bar: Look for 🤖 in the menu bar"
echo ""
echo "  To uninstall:"
echo "    launchctl unload $LAUNCH_DIR/com.agent-visualization.plist"
echo "    launchctl unload $LAUNCH_DIR/com.agent-visualization.menubar.plist"
