# Packaging

## Command-line archive

`cli/` builds the desktop app's command line as a standalone Linux x64 archive
(no Electron, no GTK) plus the `install.sh` one-line installer for sandboxes and
servers; see `cli/README.md`.

SeuOffice releases no Linux desktop package (AppImage, deb, rpm), so there are
no Flatpak, Nix or Docker recipes here (decision 0032).
