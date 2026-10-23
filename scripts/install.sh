#!/usr/bin/env bash
# Install an already-built app; never run dependency installers as root.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
action=${1:-install}
build_dir=${2:-dist/linux-unpacked}
install_root=${3:-/opt/winboat-workspace}
prefix=${4:-/usr/local}
destdir=${5:-}
fail() { echo "WinBoat installer: $*" >&2; exit 1; }
[[ $action == install || $action == rollback ]] || fail 'Expected install or rollback.'
[[ $install_root == /* && $prefix == /* ]] || fail 'INSTALL_ROOT and PREFIX must be absolute.'
[[ -z $destdir || $destdir == /* ]] || fail 'DESTDIR must be absolute.'
for value in "$install_root" "$prefix" "$destdir"; do
    [[ $value != *$'\n'* && $value != *$'\r'* && $value != *'"'* && $value != *'`'* && $value != *'$'* && $value != *'\\'* ]] || fail 'Unsupported character in installation path.'
done
[[ $install_root != / && $install_root != /opt/winboat ]] || fail 'Refusing to use a protected installation directory.'
[[ -n $destdir || $EUID == 0 ]] || fail 'Run sudo make install, or use DESTDIR for a staging installation.'
if [[ -z $destdir ]] && pgrep -x winboat >/dev/null; then
    fail 'Close the WinBoat app before installing or rolling back. Windows data is untouched.'
fi
root="$destdir$install_root"
bin_dir="$destdir$prefix/bin"
applications="$destdir$prefix/share/applications"
icons="$destdir$prefix/share/icons/hicolor/scalable/apps"
[[ ! -L $root && ! -L $root/releases && ! -L $root/backups ]] || fail 'Installation directories must not be symlinks.'
for name in current previous; do
    [[ ! -e $root/$name || -L $root/$name ]] || fail "$root/$name is not a managed symlink."
done
valid_release() {
    local target=$1
    [[ $target =~ ^releases/[A-Za-z0-9._-]+$ && -d $root/$target && ! -L $root/$target && -f $root/$target/.winboat-managed && -x $root/$target/winboat ]]
}
old_target=''
if [[ -L $root/current ]]; then
    old_target=$(readlink "$root/current")
    valid_release "$old_target" || fail 'The current release is not managed by this installer.'
fi
mkdir -p "$root/releases"
exec 9>"$root/.install.lock"
flock -n 9 || fail 'Another installation is in progress.'
# Re-read after acquiring the lock so simultaneous invocations cannot lose rollback state.
if [[ -L $root/current ]]; then old_target=$(readlink "$root/current"); fi
stage=''
trap 'if [[ -n $stage ]]; then rm -rf -- "$stage"; fi; rm -f -- "$root/.current.$$" "$root/.previous.$$"' EXIT
if [[ $action == rollback ]]; then
    [[ -L $root/previous ]] || fail 'No previous managed release is available.'
    new_target=$(readlink "$root/previous")
    valid_release "$new_target" || fail 'The previous release is not managed by this installer.'
else
    [[ -f icons/winboat_logo.svg ]] || fail 'Installer icon is missing from the source or extracted artifact.'
    [[ -x $build_dir/winboat && -f $build_dir/resources/app.asar && -f $build_dir/build-manifest.json ]] || fail 'No complete build. Run make build as your regular user first.'
    release_id=$(python3 - "$build_dir" <<'PY'
import hashlib, json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'build-manifest.json').read_text())
id = manifest.get('releaseId', '')
if not re.fullmatch(r'[A-Za-z0-9._-]+', id):
    raise SystemExit('Invalid release ID')
digest = hashlib.sha256()
for file in sorted(root.rglob('*')):
    if file.is_symlink():
        raise SystemExit(f'Unexpected symlink in build: {file}')
    if file.is_file() and file.name != 'build-manifest.json':
        digest.update(str(file.relative_to(root)).encode())
        with file.open('rb') as data:
            for block in iter(lambda: data.read(1024 * 1024), b''):
                digest.update(block)
if digest.hexdigest() != manifest.get('payloadSha256'):
    raise SystemExit('Build payload does not match its manifest; rebuild before installing')
print(id)
PY
    ) || fail 'Build verification failed.'
    new_target="releases/$release_id"
    if [[ -e $root/$new_target || -L $root/$new_target ]]; then
        valid_release "$new_target" || fail "Release path already exists and is unmanaged: $new_target"
        cmp -s "$build_dir/build-manifest.json" "$root/$new_target/build-manifest.json" || fail 'Release ID collision; refusing to overwrite an existing release.'
    else
        stage=$(mktemp -d "$root/releases/.install.XXXXXX")
        cp -a -- "$build_dir/." "$stage/"
        printf '%s\n' 'WinBoat custom installer v1' > "$stage/.winboat-managed"
        if [[ $EUID == 0 ]]; then chown -R root:root "$stage"; fi
        chmod -R go-w "$stage"
        chmod 755 "$stage" "$stage/winboat"
        # Electron's fallback sandbox must be owned by root; never disable sandboxing.
        if [[ -f $stage/chrome-sandbox ]]; then
            if [[ $EUID == 0 ]]; then chmod 4755 "$stage/chrome-sandbox"; else chmod 755 "$stage/chrome-sandbox"; fi
        fi
        mv -T -- "$stage" "$root/$new_target"
        stage=''
    fi
    mkdir -p "$bin_dir" "$applications" "$icons"
    for entry in "$bin_dir/winboat" "$applications/winboat.desktop"; do
        [[ ! -L $entry ]] || fail "Refusing to replace an existing symlink: $entry"
        if [[ -e $entry ]] && ! grep -q 'WinBoat-Managed' "$entry"; then
            fail "Existing unmanaged file: $entry. Move it aside before installation."
        fi
    done
    stage=$(mktemp -d "$root/.integration.XXXXXX")
    cat > "$stage/winboat" <<LAUNCHER
#!/bin/sh
# WinBoat-Managed launcher. WINBOAT_HOME is honored by the app.
exec "$install_root/current/winboat" "\$@"
LAUNCHER
    cat > "$stage/winboat.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=WinBoat
Comment=Manage Windows installations and run Windows apps
Exec="$prefix/bin/winboat" %U
Icon=winboat-custom
Terminal=false
Categories=System;Utility;
StartupWMClass=winboat
X-WinBoat-Managed=true
DESKTOP
    install -m 755 "$stage/winboat" "$bin_dir/.winboat.new"
    mv -T "$bin_dir/.winboat.new" "$bin_dir/winboat"
    install -m 644 "$stage/winboat.desktop" "$applications/.winboat.desktop.new"
    mv -T "$applications/.winboat.desktop.new" "$applications/winboat.desktop"
    install -m 644 icons/winboat_logo.svg "$icons/winboat-custom.svg"
    rm -rf -- "$stage"
    stage=''
fi
if [[ -n $old_target && $old_target != "$new_target" ]]; then
    ln -s -- "$old_target" "$root/.previous.$$"
    mv -Tf -- "$root/.previous.$$" "$root/previous"
fi
ln -s -- "$new_target" "$root/.current.$$"
mv -Tf -- "$root/.current.$$" "$root/current"
if [[ -z $destdir ]]; then
    command -v update-desktop-database >/dev/null && update-desktop-database "$applications" || true
    command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$destdir$prefix/share/icons/hicolor" || true
fi
printf 'WinBoat %s: %s\n' "$action" "$install_root/$new_target"
printf 'Previous app and all Windows disks are preserved. Launch: %s/bin/winboat\n' "$prefix"
