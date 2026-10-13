# HayperMC Launcher

HayperMC Minecraft launcher for Windows.

## Downloads

- **Windows 7 / 8 / 8.1:** `release/HayperMC-Launcher-Windows7-8-Electron22.3.27.exe`
- **Windows 10 / 11:** `release/HayperMC-Launcher-Windows10-11-Electron33.4.11.exe`

## Build targets

- `package.win7.json`: Electron 22.3.27 for Windows 7/8/8.1.
- `package.json`: Electron 33.4.11 for Windows 10/11.

## Included Java runtime

On Windows, the launcher automatically detects the Java major version required by the selected Minecraft version and downloads the matching Temurin JRE when needed. Java does not need to be installed separately.

The launcher downloads Minecraft assets and selected loaders/mods when needed.
