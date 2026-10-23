#!/usr/bin/env bash
# Run on Linux with Docker, after Tauri has built its .deb.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
version=$(node -p "require('./package.json').version")
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected a stable release version' >&2; exit 1; }
shopt -s nullglob
debs=(src-tauri/target/release/bundle/deb/*_amd64.deb)
[[ ${#debs[@]} == 1 ]] || { echo 'Expected exactly one amd64 .deb' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cp -- "${debs[0]}" "$work/project-desk.deb"
cp LICENSE "$work/LICENSE"
deb_sha=$(sha256sum "$work/project-desk.deb" | cut -d ' ' -f1)
license_sha=$(sha256sum "$work/LICENSE" | cut -d ' ' -f1)
sed -e "s/@VERSION@/$version/g" -e "s/@DEB_SHA256@/$deb_sha/g" \
  -e "s/@LICENSE_SHA256@/$license_sha/g" packaging/arch/PKGBUILD.in > "$work/PKGBUILD"
docker run --rm --mount "type=bind,source=$work,target=/work" archlinux:base-devel bash -euc '
  pacman -Syu --noconfirm --needed gtk3 webkit2gtk-4.1 libsoup3 openssl hicolor-icon-theme xdg-utils desktop-file-utils
  useradd -m builder
  cp -r /work /tmp/arch-build
  chown -R builder:builder /tmp/arch-build
  cd /tmp/arch-build
  runuser -u builder -- makepkg --noconfirm
  pacman -U --noconfirm ./project-desk-bin-*.pkg.tar.zst
  test -x /usr/bin/project-desk
  ldd /usr/bin/project-desk > /work/ldd.txt
  cat /work/ldd.txt
  if grep -q "not found" /work/ldd.txt; then exit 1; fi
  while IFS= read -r desktop; do desktop-file-validate "$desktop"; done < <(pacman -Qlq project-desk-bin | grep "\.desktop$")
  pacman -Qk project-desk-bin
  cp ./*.pkg.tar.zst /work/
'
mkdir -p src-tauri/target/release/bundle/arch
cp -- "$work"/*.pkg.tar.zst src-tauri/target/release/bundle/arch/
