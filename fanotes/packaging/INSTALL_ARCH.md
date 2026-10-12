# FaNotes auf Arch Linux installieren

Die folgenden Wege funktionieren auf Arch Linux und Arch-basierten Distributionen auf `x86_64`. Für AppImage und Portable sind keine Node.js- oder Electron-Pakete erforderlich; Electron ist bereits im Bundle enthalten.

Für die kürzeste Startzeit empfiehlt sich die portable oder daraus gebaute Pacman-Installation: Sie läuft direkt aus dem Dateisystem und umgeht die zusätzliche FUSE-Dekompression eines AppImage. Der geprüfte Start bis zum editierbaren Editor liegt damit selbst bei 10.000 Notizen klar unter drei Sekunden.

GlyphenWerk mit Training, Live-Test, Sammlung und Export ist direkt in FaNotes integriert und über das Datenbank-Symbol oder `Strg+Umschalt+G` erreichbar. Neue bestätigte Beispiele wirken ohne ZIP-Umweg. Im Stiftmodus kann vorhandene Handschrift durch mehrfaches Hin- und Herkritzeln über dem gewünschten Wortbereich gelöscht werden. `Strg+Z` stellt die Löschung als einen einzelnen Undo-Schritt wieder her; die Geste funktioniert unter Wayland und X11 identisch.

## Dateien zuerst prüfen

Wenn im Auslieferungsordner eine `SHA256SUMS` liegt, vor der Installation aus diesem Ordner ausführen:

```bash
sha256sum -c SHA256SUMS
```

Nur Dateien verwenden, die mit `OK` bestätigt werden.

## Variante 1: AppImage

Das AppImage ist der einfachste Weg und verändert keine Systemdateien:

```bash
chmod +x FaNotes-2026.10.4-x86_64.AppImage
./FaNotes-2026.10.4-x86_64.AppImage
```

Für eine dauerhafte Installation im Benutzerkonto:

```bash
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" \
  "$HOME/.local/share/icons/hicolor/scalable/apps"
install -m755 FaNotes-2026.10.4-x86_64.AppImage \
  "$HOME/.local/bin/fanotes"
install -m644 packaging/fanotes.desktop \
  "$HOME/.local/share/applications/fanotes.desktop"
install -m644 packaging/fanotes.svg \
  "$HOME/.local/share/icons/hicolor/scalable/apps/fanotes.svg"
sed -i "s|^Exec=.*|Exec=$HOME/.local/bin/fanotes|" \
  "$HOME/.local/share/applications/fanotes.desktop"
sed -i '/^TryExec=/d' \
  "$HOME/.local/share/applications/fanotes.desktop"
```

Danach gegebenenfalls ab- und wieder anmelden, damit der Desktop-Launcher neu eingelesen wird. `update-desktop-database ~/.local/share/applications` ist optional.

Falls das AppImage wegen FUSE nicht startet:

```bash
sudo pacman -S --needed fuse2
```

Ohne FUSE kann es als langsamere Ausweichlösung direkt extrahiert und gestartet werden:

```bash
./FaNotes-2026.10.4-x86_64.AppImage --appimage-extract-and-run
```

## Variante 2: Portables tar.gz

Das portable Archiv besitzt genau einen Top-Level-Ordner. Es kann vollständig im Benutzerkonto installiert werden:

```bash
mkdir -p "$HOME/.local/opt" "$HOME/.local/bin"
tar -xzf FaNotes-2026.10.4-x86_64.tar.gz -C "$HOME/.local/opt"
ln -sfn \
  "$HOME/.local/opt/FaNotes-2026.10.4-x86_64/fanotes" \
  "$HOME/.local/bin/fanotes"
"$HOME/.local/bin/fanotes"
```

Die Desktop-Datei wird wie bei der AppImage-Variante installiert. Zum Entfernen genügt:

```bash
rm -f "$HOME/.local/bin/fanotes"
rm -f "$HOME/.local/share/applications/fanotes.desktop"
rm -rf "$HOME/.local/opt/FaNotes-2026.10.4-x86_64"
```

Vault und Einstellungen werden dadurch absichtlich nicht gelöscht.

## Variante 3: Echtes Pacman-Paket bauen

Das mitgelieferte `PKGBUILD` verpackt exakt das portable tar.gz. Es lädt nichts aus dem Internet nach und baut Electron nicht erneut.

1. `FaNotes-2026.10.4-x86_64.tar.gz`, `PKGBUILD`, `fanotes.desktop`, `fanotes.svg` und `LICENSE` gemeinsam in einen leeren Arbeitsordner kopieren.
2. Die Build-Werkzeuge installieren:

   ```bash
   sudo pacman -S --needed base-devel pacman-contrib
   ```

3. Als normaler Benutzer in diesem Arbeitsordner den absichtlich offenen Archiv-Hash durch den echten Hash ersetzen und bauen:

   ```bash
   updpkgsums
   makepkg --cleanbuild --syncdeps --install
   ```

`updpkgsums` ersetzt den einzelnen `SKIP`-Eintrag durch den SHA-256-Wert genau dieses Archivs. So enthält das anschließend erzeugte Paket keine erfundene oder veraltete Prüfsumme. Arch ersetzt den Bindestrich der Vorabkennung im Paketnamen durch einen Punkt; das Ergebnis heißt etwa `fanotes-bin-2026.7.1.beta.1-1-x86_64.pkg.tar.zst` und kann anschließend auch auf anderen Arch-Rechnern installiert werden:

```bash
sudo pacman -U fanotes-bin-2026.7.1.beta.1-1-x86_64.pkg.tar.zst
```

Deinstallation:

```bash
sudo pacman -Rns fanotes-bin
```

Bei einer neuen App-Version müssen `pkgver`, Archivname und Checksumme gemeinsam aktualisiert werden. `makepkg` niemals mit `sudo` ausführen.

## Automatische Updates

FaNotes prüft standardmäßig den Stable-Kanal kurz nach dem Start und danach alle sechs Stunden. Unter **Einstellungen → Updates → Update-Kanal** kann stattdessen Beta gewählt werden. Stable erhält nur gebündelte, vollständig geprüfte Releases; Beta erhält neue Funktionen früher als Vorabversion. Ein Wechsel zurück zu Stable installiert niemals eine ältere Version. Ein gefundenes Update wird im Hintergrund heruntergeladen und beim regulären Beenden installiert, nachdem alle offenen Notizen, Handschriften und Arbeitsblätter gespeichert wurden. Jede Automatik lässt sich einzeln deaktivieren oder ein geprüftes Update sofort installieren.

Bei einem direkt gestarteten, beschreibbaren AppImage bleibt dessen Pfad erhalten. Bei portablen, paketverwalteten oder schreibgeschützten Starts richtet der Updater eine verwaltete AppImage-Installation unter `~/.local/opt/FaNotes/FaNotes.AppImage` samt Benutzer-Launcher ein. Ein systemweit mit Pacman installiertes Paket wird dadurch nicht überschrieben.

## Grafiktablett unter Wayland und X11

FaNotes nutzt standardisierte Pointer Events von Chromium. Stiftdruck wird verwendet, wenn Treiber und Desktop-Sitzung einen variablen Druckwert liefern. Der Kernel und `libinput` müssen das Tablet erkennen:

```bash
sudo pacman -S --needed libinput
libinput list-devices
echo "$XDG_SESSION_TYPE"
```

### Hyprland und andere Wayland-Desktops

Unter Linux startet FaNotes immer mit Ozone X11. Stift und Trackpad teilen denselben Seat — nach dem Schreiben kannst du sofort mit zwei Fingern scrollen. Ein extra `--ozone-platform=x11` ist nicht nötig:

```bash
fanotes
```

Unter Hyprland verwendet FaNotes die normale Linux-Fensterleiste und keine zusätzliche Titelleiste in der App. Dadurch greifen Hyprland-Rahmen, Rundungen, Schatten und Fensterregeln.

Wenn in `~/.config/hypr/hyprland.conf` oder einer dort per `source =` eingebundenen Datei `force_zero_scaling = true` steht, setzt FaNotes die Geräteskalierung auf 2, damit die Schrift unter XWayland nicht winzig wirkt.

Unter GNOME und KDE Plasma werden Monitorzuordnung, aktive Tablet-Fläche und Stifttasten in den Systemeinstellungen konfiguriert.

Vulkan bleibt im nativen Wayland-Pfad aus; Chromium nutzt GL/EGL. Nur zum Test:

```bash
FANOTES_ENABLE_VULKAN=1 fanotes --use-angle=vulkan
```

### X11

Wacom-kompatible Geräte lassen sich zusätzlich mit `xsetwacom` prüfen und einem Monitor zuordnen:

```bash
sudo pacman -S --needed xf86-input-wacom
xsetwacom --list devices
xrandr --listmonitors
xsetwacom set "NAME DES STIFT-GERÄTS" MapToOutput DP-1
```

Gerätename und Ausgang müssen an die Ausgabe der beiden vorherigen Befehle angepasst werden. Bei Huion, XP-Pen und anderen Herstellern reichen auf aktuellen Desktops oft Kernel und `libinput`; herstellerspezifische Treiber können deren Dokumentation erfordern.

Wenn Striche funktionieren, aber immer gleich breit sind, unter **Einstellungen → Stift & Erkennung** die Druckempfindlichkeit testweise deaktivieren. Das ist meist ein Treiber-/Compositor-Thema und beeinträchtigt Zeichnen und Erkennen nicht.

## GlyphenWerk-Training importieren

1. In GlyphenWerk das trainierte Dataset als ZIP exportieren.
2. In FaNotes **Einstellungen → Stift & Erkennung** öffnen.
3. **Training importieren** wählen; der ZIP-Dateiwähler öffnet sich direkt und das Modell wird nach der Auswahl sofort aktualisiert.
4. Zum Schreiben die Stift-Schaltfläche öffnen und anschließend **Seite konvertieren** oder **Bereich konvertieren** wählen.
5. Den voreingestellten Modus **Automatisch** verwenden oder **Text** beziehungsweise **Mathematik** manuell festlegen.
6. Das Ergebnis in der Live-Vorschau kontrollieren und gegebenenfalls korrigieren.
7. Mit **Als Text einfügen** oder **Als Formel einfügen** bestätigen. Verwertbare Korrekturen werden lokal als neue Beispiele gespeichert.

Für Integrale, Summen, Brüche, Wurzeln und Indizes sollten im GlyphenWerk-Export nicht nur einzelne Symbolbeispiele, sondern auch passende Layout-Beispiele enthalten sein.

## Vault, Synchronisation und Backup

- Standard-Vault bei einer Neuinstallation: der Ordner `FaNotes` im Dokumente-Verzeichnis
- Notizen: normale Markdown-Dateien im Vault
- Zeichnungen: `.fanotes/assets/*.png` und `.fanotes/assets/*.json` im Vault
- importierte Arbeitsblätter und Textfelder: `.fanotes/worksheets/*` im Vault
- Einstellungen und Trainingsmodell: Electron-Profil unter `~/.config/FaNotes/`; frühere lokale Profile werden beim ersten Start automatisch übernommen
- Papierkorb: Gelöschte Vault-Dateien werden an den Papierkorb der Desktop-Umgebung übergeben

Für ein Backup die App zuerst beenden und Vault plus Profilordner kopieren. Bei Syncthing, Git oder NAS-Synchronisation sollte derselbe Markdown-Text nicht gleichzeitig auf zwei Geräten bearbeitet werden; sonst entscheidet das jeweilige Synchronisationswerkzeug über Konfliktdateien. Der versteckte `.fanotes`-Ordner gehört zum Vault-Backup.

Die Anwendung sendet weder Notizen noch Trainingsbeispiele an einen Cloud-Dienst. Ein importiertes GlyphenWerk-ZIP wird lokal gelesen; die Originaldatei kann danach separat archiviert oder entfernt werden.

## Fehlerbehebung

### App meldet eine laufende Instanz, obwohl keine geöffnet ist

FaNotes prüft die Electron-Dateien `SingletonLock`, `SingletonCookie` und `SingletonSocket` vor jedem Start. Gehört der Lock zu einem nachweislich nicht mehr existierenden lokalen Prozess, werden nur diese drei Symlinks automatisch entfernt. Aktive Prozesse, normale Dateien und nicht sicher bewertbare frische Locks bleiben unangetastet. Ein manuelles Löschen unter `~/.config/FaNotes/` ist ab Version 2.3.1 normalerweise nicht mehr erforderlich.

### Chromium-Sandbox

Das AppImage wird absichtlich ohne einen Schalter ausgeliefert, der die Chromium-Sandbox deaktiviert. Falls AppImage oder portabler Build auf einem speziell gehärteten System mit einer Sandbox-Meldung beendet werden, das Pacman-Paket verwenden. Das `PKGBUILD` installiert `chrome-sandbox` mit den erforderlichen Besitz-/Modusdaten. Die Sandbox nicht über einen Startparameter abschalten.

### Leeres oder flackerndes Fenster

Zum Eingrenzen eines Grafiktreiberproblems einmalig starten mit:

```bash
fanotes --disable-gpu
```

Funktioniert dies, System, Mesa und Grafiktreiber aktualisieren und danach wieder ohne Flag starten.

### App startet nicht aus dem Menü

Im Terminal `command -v fanotes` prüfen. Bei einer Benutzerinstallation muss `~/.local/bin` für die Desktop-Sitzung erreichbar sein, oder in der installierten `.desktop`-Datei muss wie oben beschrieben der absolute Pfad stehen.

## English

The following paths work on Arch Linux and Arch-based distributions on `x86_64`. AppImage and the portable build do not need Node.js or Electron packages; Electron is already in the bundle.

For the shortest startup, use the portable build or a Pacman package built from it. It runs directly from the file system and skips the extra FUSE decompression of an AppImage. The checked start until the editor is editable stays well under three seconds even with 10,000 notes.

GlyphenWerk, with training, a live test, the collection, and export, is built into FaNotes and opens from the database icon or `Ctrl+Shift+G`. Newly confirmed samples apply without a ZIP detour. In pen mode, existing handwriting can be deleted by scribbling back and forth over the word. `Ctrl+Z` restores that deletion as a single undo step. The gesture works the same way on Wayland and X11.

## Check the files first

If the delivery folder contains `SHA256SUMS`, run this from that folder before installing:

```bash
sha256sum -c SHA256SUMS
```

Use only files that are confirmed with `OK`.

## Option 1: AppImage

The AppImage is the simplest path and does not change system files:

```bash
chmod +x FaNotes-2026.10.4-x86_64.AppImage
./FaNotes-2026.10.4-x86_64.AppImage
```

For a lasting install in the user account:

```bash
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" \
  "$HOME/.local/share/icons/hicolor/scalable/apps"
install -m755 FaNotes-2026.10.4-x86_64.AppImage \
  "$HOME/.local/bin/fanotes"
install -m644 packaging/fanotes.desktop \
  "$HOME/.local/share/applications/fanotes.desktop"
install -m644 packaging/fanotes.svg \
  "$HOME/.local/share/icons/hicolor/scalable/apps/fanotes.svg"
sed -i "s|^Exec=.*|Exec=$HOME/.local/bin/fanotes|" \
  "$HOME/.local/share/applications/fanotes.desktop"
sed -i '/^TryExec=/d' \
  "$HOME/.local/share/applications/fanotes.desktop"
```

Log out and back in if the desktop launcher needs to be reread. `update-desktop-database ~/.local/share/applications` is optional.

If the AppImage does not start because of FUSE:

```bash
sudo pacman -S --needed fuse2
```

Without FUSE it can be extracted and started directly as a slower fallback:

```bash
./FaNotes-2026.10.4-x86_64.AppImage --appimage-extract-and-run
```

## Option 2: Portable tar.gz

The portable archive has exactly one top-level folder. It can be installed entirely in the user account:

```bash
mkdir -p "$HOME/.local/opt" "$HOME/.local/bin"
tar -xzf FaNotes-2026.10.4-x86_64.tar.gz -C "$HOME/.local/opt"
ln -sfn \
  "$HOME/.local/opt/FaNotes-2026.10.4-x86_64/fanotes" \
  "$HOME/.local/bin/fanotes"
"$HOME/.local/bin/fanotes"
```

Install the desktop file the same way as for the AppImage. To remove it:

```bash
rm -f "$HOME/.local/bin/fanotes"
rm -f "$HOME/.local/share/applications/fanotes.desktop"
rm -rf "$HOME/.local/opt/FaNotes-2026.10.4-x86_64"
```

The vault and settings are intentionally left in place.

## Option 3: Build a real Pacman package

The included `PKGBUILD` packages exactly the portable tar.gz. It does not download anything from the internet and does not rebuild Electron.

1. Copy `FaNotes-2026.10.4-x86_64.tar.gz`, `PKGBUILD`, `fanotes.desktop`, `fanotes.svg`, and `LICENSE` together into an empty working directory.
2. Install the build tools:

   ```bash
   sudo pacman -S --needed base-devel pacman-contrib
   ```

3. As a normal user, replace the intentionally open archive hash with the real hash and build:

   ```bash
   updpkgsums
   makepkg --cleanbuild --syncdeps --install
   ```

`updpkgsums` replaces the single `SKIP` entry with the SHA-256 value of this exact archive. The package that follows therefore does not contain an invented or stale checksum. Arch replaces the hyphen of a prerelease marker in the package name with a dot. The result is named something like `fanotes-bin-2026.7.1.beta.1-1-x86_64.pkg.tar.zst` and can then be installed on other Arch machines:

```bash
sudo pacman -U fanotes-bin-2026.7.1.beta.1-1-x86_64.pkg.tar.zst
```

Uninstall:

```bash
sudo pacman -Rns fanotes-bin
```

For a new app version, update `pkgver`, the archive name, and the checksum together. Never run `makepkg` with `sudo`.

## Automatic updates

By default FaNotes checks the Stable channel shortly after startup and then every six hours. Under **Settings → Updates → Update channel** you can choose Beta instead. Stable receives only bundled, fully tested releases. Beta receives new features earlier as a preview. Switching back to Stable never installs an older version. A found update is downloaded in the background and installed on a normal quit, after every open note, handwriting page, and worksheet has been saved. Each automatic step can be turned off, or a checked update can be installed immediately.

A directly started, writable AppImage keeps its path. For portable, package-managed, or read-only starts, the updater sets up a managed AppImage install at `~/.local/opt/FaNotes/FaNotes.AppImage` together with a user launcher. A package installed system-wide with Pacman is not overwritten.

## Graphics tablet on Wayland and X11

FaNotes uses Chromium's standard pointer events. Pen pressure is used when the driver and the desktop session provide a variable pressure value. The kernel and `libinput` must see the tablet:

```bash
sudo pacman -S --needed libinput
libinput list-devices
echo "$XDG_SESSION_TYPE"
```

### Hyprland and other Wayland desktops

On Linux, FaNotes always starts with Ozone X11. The pen and the trackpad share the same seat, so you can scroll with two fingers right after writing. An extra `--ozone-platform=x11` is not required:

```bash
fanotes
```

Under Hyprland, FaNotes uses the normal Linux window bar and no extra title bar inside the app. Hyprland borders, rounding, shadows, and window rules therefore apply.

If `force_zero_scaling = true` is set in `~/.config/hypr/hyprland.conf` or in a file included from there with `source =`, FaNotes sets the device scale to 2 so text is not tiny under XWayland.

On GNOME and KDE Plasma, configure monitor mapping, the active tablet area, and pen buttons in the system settings.

Vulkan stays off on the native Wayland path; Chromium uses GL/EGL. For a test only:

```bash
FANOTES_ENABLE_VULKAN=1 fanotes --use-angle=vulkan
```

### X11

Wacom-compatible devices can also be checked with `xsetwacom` and mapped to a monitor:

```bash
sudo pacman -S --needed xf86-input-wacom
xsetwacom --list devices
xrandr --listmonitors
xsetwacom set "NAME OF THE PEN DEVICE" MapToOutput DP-1
```

The device name and output must match the output of the two previous commands. For Huion, XP-Pen, and other vendors, current desktops often only need the kernel and `libinput`. Vendor-specific drivers may need their own documentation.

If strokes work but are always the same width, try turning pressure sensitivity off under **Settings → Pen & recognition**. That is usually a driver or compositor issue and does not affect drawing or recognition.

## Import GlyphenWerk training

1. In GlyphenWerk, export the trained dataset as a ZIP.
2. In FaNotes, open **Settings → Pen & recognition**.
3. Choose **Import training**. The ZIP file picker opens directly, and the model updates as soon as you select the file.
4. To write, open the pen button, then choose **Convert page** or **Convert region**.
5. Keep the default mode **Automatic**, or set **Text** or **Mathematics** manually.
6. Check the result in the live preview and correct it if needed.
7. Confirm with **Insert as text** or **Insert as formula**. Usable corrections are stored locally as new samples.

For integrals, sums, fractions, roots, and indices, a GlyphenWerk export should include matching layout samples, not only single symbol samples.

## Vault, sync, and backup

- Default vault on a fresh install: the `FaNotes` folder in Documents
- Notes: ordinary Markdown files in the vault
- Drawings: `.fanotes/assets/*.png` and `.fanotes/assets/*.json` in the vault
- Imported worksheets and text fields: `.fanotes/worksheets/*` in the vault
- Settings and the training model: the Electron profile under `~/.config/FaNotes/`. Earlier local profiles are taken over automatically on the first start
- Trash: deleted vault files are handed to the desktop environment's trash

For a backup, quit the app first and copy the vault plus the profile folder. With Syncthing, Git, or NAS sync, do not edit the same Markdown text on two devices at once; otherwise the sync tool decides the conflict files. The hidden `.fanotes` folder belongs in the vault backup.

The app sends neither notes nor training samples to a cloud service. An imported GlyphenWerk ZIP is read locally. The original file can afterwards be archived or removed separately.

## Troubleshooting

### The app reports a running instance, but none is open

Before every start, FaNotes checks the Electron files `SingletonLock`, `SingletonCookie`, and `SingletonSocket`. If the lock belongs to a local process that clearly no longer exists, only those three symlinks are removed. Active processes, ordinary files, and fresh locks that cannot be judged safely are left alone. Manually deleting files under `~/.config/FaNotes/` is normally no longer required from version 2.3.1.

### Chromium sandbox

The AppImage is deliberately shipped without a switch that disables the Chromium sandbox. If the AppImage or the portable build exits with a sandbox message on a specially hardened system, use the Pacman package. The `PKGBUILD` installs `chrome-sandbox` with the required owner and mode. Do not turn the sandbox off with a launch argument.

### Blank or flickering window

To narrow down a graphics-driver problem, start once with:

```bash
fanotes --disable-gpu
```

If that works, update the system, Mesa, and the graphics driver, then start again without the flag.

### The app does not start from the menu

In a terminal, check `command -v fanotes`. For a user install, `~/.local/bin` must be available to the desktop session, or the installed `.desktop` file must contain the absolute path as described above.
