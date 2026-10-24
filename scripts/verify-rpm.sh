#!/usr/bin/env bash
# Check the release RPM in both major RPM ecosystems before completing a release.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"
shopt -s nullglob
rpms=(src-tauri/target/release/bundle/rpm/*.rpm)
[[ ${#rpms[@]} == 1 ]] || { echo 'Expected exactly one RPM' >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cp -- "${rpms[0]}" "$work/project-desk.rpm"
for image in fedora:latest opensuse/tumbleweed:latest; do
  docker run --rm --mount "type=bind,source=$work,target=/packages,readonly" "$image" sh -euc '
    if command -v dnf >/dev/null; then
      dnf install -y /packages/project-desk.rpm desktop-file-utils
    else
      zypper --non-interactive --gpg-auto-import-keys install --allow-unsigned-rpm /packages/project-desk.rpm desktop-file-utils
    fi
    test -x /usr/bin/project-desk
    ldd /usr/bin/project-desk > /tmp/project-desk-libraries
    cat /tmp/project-desk-libraries
    if grep -q "not found" /tmp/project-desk-libraries; then exit 1; fi
    desktop-file-validate "/usr/share/applications/Project Desk.desktop"
    rpm -V project-desk
  '
done
