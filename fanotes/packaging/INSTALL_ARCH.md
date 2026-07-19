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
chmod +x FaNotes-2026.7.4-beta.10-x86_64.AppImage
./FaNotes-2026.7.4-beta.10-x86_64.AppImage
```

Für eine dauerhafte Installation im Benutzerkonto:

```bash
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" \
  "$HOME/.local/share/icons/hicolor/scalable/apps"
install -m755 FaNotes-2026.7.4-beta.10-x86_64.AppImage \
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
./FaNotes-2026.7.4-beta.10-x86_64.AppImage --appimage-extract-and-run
```

## Variante 2: Portables tar.gz

Das portable Archiv besitzt genau einen Top-Level-Ordner. Es kann vollständig im Benutzerkonto installiert werden:

```bash
mkdir -p "$HOME/.local/opt" "$HOME/.local/bin"
tar -xzf FaNotes-2026.7.4-beta.10-x86_64.tar.gz -C "$HOME/.local/opt"
ln -sfn \
  "$HOME/.local/opt/FaNotes-2026.7.4-beta.10-x86_64/fanotes" \
  "$HOME/.local/bin/fanotes"
"$HOME/.local/bin/fanotes"
```

Die Desktop-Datei wird wie bei der AppImage-Variante installiert. Zum Entfernen genügt:

```bash
rm -f "$HOME/.local/bin/fanotes"
rm -f "$HOME/.local/share/applications/fanotes.desktop"
rm -rf "$HOME/.local/opt/FaNotes-2026.7.4-beta.10-x86_64"
```

Vault und Einstellungen werden dadurch absichtlich nicht gelöscht.

## Variante 3: Echtes Pacman-Paket bauen

Das mitgelieferte `PKGBUILD` verpackt exakt das portable tar.gz. Es lädt nichts aus dem Internet nach und baut Electron nicht erneut.

1. `FaNotes-2026.7.4-beta.10-x86_64.tar.gz`, `PKGBUILD`, `fanotes.desktop`, `fanotes.svg` und `LICENSE` gemeinsam in einen leeren Arbeitsordner kopieren.
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

### Wayland

Unter GNOME und KDE Plasma werden Monitorzuordnung, aktive Tablet-Fläche und Stifttasten in den jeweiligen Systemeinstellungen konfiguriert. Electron erkennt eine Wayland-Sitzung ab FaNotes 2.3.1 automatisch über `XDG_SESSION_TYPE`. FaNotes deaktiviert dort standardmäßig Vulkan und lässt Chromium den kompatiblen GL-/EGL-Pfad wählen, um Treiber- und ANGLE-Konflikte beim Start zu vermeiden:

```bash
fanotes
```

Wenn der Compositor noch Probleme mit Stift-Events hat, lässt sich zum Vergleich XWayland erzwingen:

```bash
fanotes --ozone-platform=x11
```

Unter Hyprland verwendet FaNotes die normale Linux-Fensterleiste und keine zusätzliche, fest gestaltete Titelleiste innerhalb der App. Dadurch greifen Hyprland-Rahmen, Rundungen, Schatten und andere Fensterregeln auf das Programmfenster.

Für einen bewussten Vulkan-Test kann der automatische Schutz einmalig ausgeschaltet werden. Diese Variante ist nicht die Standardempfehlung:

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
