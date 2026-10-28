#!/bin/sh
# Installs the latest Claudock release on macOS or Linux:
#   curl -fsSL https://behkha.github.io/claudock/install.sh | sh
# macOS: the .dmg's Claudock.app goes into /Applications, or ~/Applications when /Applications isn't writable.
# Linux: the AppImage goes into ~/.local/bin/claudock.
# curl doesn't set macOS's quarantine flag, so the app opens without a Gatekeeper warning. Never uses sudo.
# CLAUDOCK_VERSION=0.1.1 pins a release; CLAUDOCK_INSTALL_DIR=<folder> installs somewhere else.
set -eu

repo=https://github.com/behkha/claudock

say() { printf '==> %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

# Everything runs from main, at the end, so a download cut short never runs half a script.
main() {
  command -v curl >/dev/null 2>&1 || fail "curl is needed"

  version=${CLAUDOCK_VERSION:-}
  if [ -z "$version" ]; then
    say "Finding the latest release"
    # The latest release page redirects to .../releases/tag/v<version>.
    tag_url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$repo/releases/latest")
    version=${tag_url##*/v}
    case "$version" in [0-9]*) ;; *) fail "couldn't read the version from $tag_url" ;; esac
  fi
  say "Claudock $version"

  tmp=$(mktemp -d)
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  case "$(uname -s)" in
    Darwin) install_mac ;;
    Linux) install_linux ;;
    *) fail "install.sh is for macOS and Linux. On Windows run: irm https://behkha.github.io/claudock/install.ps1 | iex" ;;
  esac
}

mnt=
cleanup() {
  [ -n "$mnt" ] && hdiutil detach -quiet "$mnt" 2>/dev/null || true
  rm -rf "$tmp"
}

download() {
  say "Downloading $repo/releases/download/v$version/$1"
  curl -fL --progress-bar -o "$tmp/$1" "$repo/releases/download/v$version/$1" || fail "download failed"
}

install_mac() {
  # uname says x86_64 under Rosetta, so ask the hardware.
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; else arch=x64; fi
  file="Claudock-$version-$arch.dmg"
  download "$file"

  if [ -n "${CLAUDOCK_INSTALL_DIR:-}" ]; then dest=$CLAUDOCK_INSTALL_DIR
  elif [ -w /Applications ]; then dest=/Applications
  else dest=$HOME/Applications; fi
  mkdir -p "$dest"
  app="$dest/Claudock.app"

  if pgrep -f "$app/Contents/MacOS/" >/dev/null 2>&1; then
    fail "Claudock is running from $app. Quit it, then run this again."
  fi

  say "Opening the disk image"
  mnt="$tmp/mnt"
  mkdir "$mnt"
  hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mnt" "$tmp/$file" </dev/null

  say "Copying Claudock.app to $dest"
  rm -rf "$app.part"
  ditto "$mnt/Claudock.app" "$app.part"
  rm -rf "$app"
  mv "$app.part" "$app"

  say "Installed $app"
  printf '\nOpen it from Launchpad, or run: open "%s"\n' "$app"
}

install_linux() {
  case "$(uname -m)" in
    x86_64 | amd64) arch=x86_64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "no Claudock build for $(uname -m)" ;;
  esac
  file="Claudock-$version-$arch.AppImage"
  download "$file"

  dest=${CLAUDOCK_INSTALL_DIR:-$HOME/.local/bin}
  mkdir -p "$dest"
  say "Moving it to $dest/claudock"
  chmod +x "$tmp/$file"
  mv -f "$tmp/$file" "$dest/claudock"

  say "Installed $dest/claudock"
  case ":$PATH:" in
    *":$dest:"*) printf '\nRun it: claudock\n' ;;
    *) printf '\n%s is not on your PATH. Run it: %s/claudock\n' "$dest" "$dest" ;;
  esac
  # AppImages mount themselves with FUSE. 0.1.x needs FUSE 2's library, which Ubuntu 22.04 and later leave out; later
  # releases carry their own and need only the fusermount tool.
  case $version in
    0.1.*)
      if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
        printf 'If it does not start, install FUSE 2 (Ubuntu: sudo apt install libfuse2t64, or libfuse2 before 24.04).\n'
      fi
      ;;
    *)
      if ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; then
        printf 'If it does not start, install FUSE (Ubuntu: sudo apt install fuse3).\n'
      fi
      ;;
  esac
}

main "$@"
