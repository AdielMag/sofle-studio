# Sofle Windows Tray App (`MySofleHost`)

A lightweight, portable Windows desktop companion that sits in your **hidden icons** (notification area / system tray).

## What it does
1. **Hidden Icons Tray Presence**: Lives quietly in the tray with a custom keyboard icon.
2. **HE/EN Layout Monitoring**: Automatically monitors active Windows input language (`Alt+Shift` / `Win+Space`) and pushes `EN` or `HE` directly to the Sofle nice!oled display widget over Raw HID, along with time and volume.
3. **Offline Configurator App**: Hosts the built-in web configurator offline (`http://127.0.0.1:8765`) and opens it in borderless Chromium App mode (`--app`), looking and behaving like a native desktop app with full WebHID and WebSerial support.
4. **Auto-Start**: Can automatically start with Windows via the tray context menu ("Start with Windows").

## How to run
- **Quick launch**: Double-click `Launch-Sofle.bat` in the root folder, or run `host/MySofleHost/dist/MySofleHost.exe`.
- **System tray**: Look in the Windows taskbar hidden icons (click the `^` chevron). You will see the keyboard icon.
- **Open Configurator**: Left-click or double-click the tray icon (or right-click -> **Open Configurator**).
- **Start with Windows**: Right-click the tray icon and check **Start with Windows**.

## Build & Publish
To rebuild from source:
```powershell
powershell -ExecutionPolicy Bypass -File host/MySofleHost/publish.ps1
```
The output is bundled in `host/MySofleHost/dist/`.
