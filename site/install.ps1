# Installs the latest Claudock release on Windows:
#   irm https://behkha.github.io/claudock/install.ps1 | iex
# Downloads the installer with Invoke-WebRequest, which adds no Mark of the Web, so SmartScreen doesn't step in,
# then runs it. Asks for admin rights only if you choose "all users" in the installer.
# $env:CLAUDOCK_VERSION = '0.1.1' pins a release.

# A script block, so an error stops here instead of closing the PowerShell window that ran iex.
& {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell 5.1 shows Invoke-WebRequest's progress so slowly that it holds up the download.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'https://github.com/behkha/claudock'

  $version = $env:CLAUDOCK_VERSION
  if (-not $version) {
    Write-Host '==> Finding the latest release'
    $release = Invoke-RestMethod 'https://api.github.com/repos/behkha/claudock/releases/latest'
    $version = $release.tag_name -replace '^v', ''
  }
  Write-Host "==> Claudock $version"

  $file = "Claudock-Setup-$version.exe"
  $url = "$repo/releases/download/v$version/$file"
  $exe = Join-Path ([IO.Path]::GetTempPath()) $file

  Write-Host "==> Downloading $url"
  Invoke-WebRequest $url -OutFile $exe -UseBasicParsing
  Write-Host ('==> Downloaded {0:N0} MB' -f ((Get-Item $exe).Length / 1MB))

  try {
    Write-Host '==> Running the installer'
    $setup = Start-Process $exe -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "The installer stopped with code $($setup.ExitCode)" }
  } finally {
    Remove-Item $exe -ErrorAction SilentlyContinue
  }

  Write-Host '==> Installed. Open Claudock from the Start menu.'
}
