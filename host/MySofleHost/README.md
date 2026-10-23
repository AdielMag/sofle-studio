# MySofleHost

Windows tray app wrapping `zmk-hid-host.exe` (sends PC layout EN/HE to the Sofle OLED).

- Runs the host hidden, restarts it after 2 s if it exits, kills it on Quit.
- Menu: status, Open configurator, Restart host, Start with Windows (HKCU Run), Quit.
- Single instance (named mutex). Configurator URL: `Program.ConfiguratorUrl` in `Program.cs`.
- Host config: `qmk-hid-host.json` next to the exe (passed via `-c`).

## Build / publish
    powershell -File publish.ps1
Output in `dist/` (self-contained single-file win-x64 + `zmk-hid-host.exe` + `qmk-hid-host.json`). Needs network on first restore.
Smaller framework-dependent alternative: `dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o dist` (needs .NET 7 Desktop runtime; copy host files manually).

## Run
Launch `dist\MySofleHost.exe`; look in the hidden-icons tray. Keep the three files together.
