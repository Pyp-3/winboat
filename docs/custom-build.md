# Custom WinBoat build

This fork adds a library of isolated Windows installations. The default policy allows one installation to run at a time. Each installation has its own storage, settings, container identity and ports. Existing Windows storage is adopted without formatting or reinstalling it.

## Interrupted Windows setup

An unfinished installation created by this manager offers **Resume Windows setup**. Recovery uses its saved settings and credentials; it refuses changed compose files, another profile’s recovery marker, or an unavailable container runtime. The private `.pending-installation.json` file has mode `0600` and is removed after the guest reports healthy. Do not commit or share it.

Missing setup assets can be recreated only before a Windows disk or container exists. Once either exists, missing assets or mismatched guest tokens require restoring the originals. Recovery preserves existing disk files and does not regenerate credentials for an installation that has started. Imported Windows installations are never enrolled in this recovery process.

## Workspace

The local workspace is `/opt/winboat-workspace`: `source/` holds this checkout and its branches; `worktrees/` holds temporary upstream validation checkouts; `releases/` holds installed binaries; `current` and `previous` select releases. `build-backups/` preserves older uninstalled builds. Windows data is independent of the application releases. Never delete the workspace to uninstall the app.

The original app at `/opt/winboat` is preserved. Installation writes `/usr/local/bin/winboat` and `/usr/local/share/applications/winboat.desktop`. Standard desktop and PATH precedence select this build. The installer will refuse to overwrite an unrelated file at either destination. It never edits `/usr/bin/winboat` or deletes a VM.

## Build and install

Install Bun **1.3.14**, Node **24**, Go (the version in `guest_server/go.mod` or newer), Python 3, Make, Git, zip, and your distribution's libudev/libusb development packages. Dependencies come from the committed Bun lockfile. Build as your regular user:

```sh
cd /opt/winboat-workspace/source
make build
sudo make install
winboat
```

`make build` runs type checking, regression tests, compiles both Windows guest services, and packages the Linux Electron application. `sudo make install` only verifies and installs that completed build; it performs no dependency installation or network downloads. Close WinBoat before installing. The installer leaves running Windows containers and all VM files untouched.

The app honors `WINBOAT_HOME`. Without an override, it uses its normal per-user data location. The launcher does not force every Linux account to share one user's Windows library.

To restore the previous custom binary:

```sh
sudo make rollback
```

Rollback changes the app binary only; it does not reverse changes made inside Windows or restore a disk backup. The original binary remains available at `/opt/winboat/winboat`.

Installation paths can be customized with `INSTALL_ROOT=/some/path` and `PREFIX=/usr/local`. `DESTDIR=/temporary/staging` creates a staging layout without root access, useful for packaging and testing. The default installation root must never be set to a VM storage directory.

## CI artifact

The **Custom WinBoat** GitHub Actions workflow builds on pushes and pull requests to `multi-installations`, and supports manual runs. Download the `winboat-linux-x86_64-<commit>` artifact from a successful run, extract the Actions download, verify the `.tar.gz.sha256`, and extract the tarball:

```sh
sha256sum -c winboat-*.tar.gz.sha256
tar -xzf winboat-*.tar.gz
cd winboat
sudo make install
```

Run `make package` locally to produce the same installable archive. Artifacts include the full unpacked Electron application, its guest binaries, installer, icon, and build manifest. The manifest identifies the source commit, whether the source had uncommitted edits, and the payload checksum. A checksum detects corruption; it is not a publisher signature.

## Update from upstream

Commit or stash all changes first, then run:

```sh
make sync
sudo make install
```

Sync fetches `upstream/main`, merges into a temporary worktree under the workspace, and builds and tests there. A conflict or failed check leaves your branch, existing build and installed app unchanged. After successful validation, your branch advances by fast-forward and `dist/` receives the new build. Any previous `dist/` is preserved under `build-backups/`. Sync does not install, push, discard edits, or reset your branch. Review the merge and push with `git push origin multi-installations` when desired.

Use `WINBOAT_UPSTREAM_BRANCH=another-branch make sync` only when intentionally following a different upstream branch. If the update conflicts, merge and resolve the changes yourself on a branch, run `make build`, and install after reviewing the result. Keep the current release until the replacement works.

A disk backup is separate from binary rollback. Before large upstream changes, shut down Windows and back up the VM storage using a sparse-file-aware tool and sufficient free storage.
