# Self-contained single-file win-x64 publish into .\dist with zmk-hid-host files and web configurator alongside.
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$dist = Join-Path $here 'dist'
$srcHost = Join-Path $here '..\..\zmk-hid-host' | Resolve-Path
$srcWeb = Join-Path $here '..\..\zmk-config-sofle\web' | Resolve-Path

if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }

dotnet publish "$here\MySofleHost.csproj" -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true -p:DebugType=none -o $dist

if ($LASTEXITCODE -ne 0) { throw "publish failed" }

Copy-Item "$srcHost\zmk-hid-host.exe", "$srcHost\qmk-hid-host.json" $dist
Copy-Item "$srcWeb" -Destination (Join-Path $dist "web") -Recurse

Get-ChildItem $dist | Select-Object Name, Length
