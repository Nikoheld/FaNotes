# FaNotes unter Windows installieren

FaNotes unterstützt Windows 10 und Windows 11 auf `x64`. Installer und portable Ausgabe enthalten dieselben Funktionen wie die Linux-App: Markdown-Vault, Stifteingabe, lokale Handschrifterkennung, das vollständig integrierte GlyphenWerk mit Training und Live-Test, Arbeitsblattimport, Mathematikwerkzeuge, Text-zu-Handschrift, den AI-Bereich für LM Studio, Ollama, OpenAI, Gemini, Anthropic und OpenCode sowie den signierten Auto-Updater.

## Download prüfen

Die zu jeder Veröffentlichung angebotene Datei `SHA256SUMS` enthält die Prüfsummen aller Windows- und Linux-Pakete. In PowerShell lässt sich ein Download so prüfen:

```powershell
Get-FileHash .\FaNotes-Setup-2026.10.2-x64.exe -Algorithm SHA256
Get-FileHash .\FaNotes-Portable-2026.10.2-x64.exe -Algorithm SHA256
```

Die ausgegebenen Werte müssen exakt mit `SHA256SUMS` übereinstimmen.

## Variante 1: Installer

1. `FaNotes-Setup-2026.10.2-x64.exe` herunterladen und öffnen.
2. Den Windows-Sicherheitsdialog bestätigen.
3. Nach der Installation FaNotes über Startmenü oder Desktop-Verknüpfung öffnen.

Der Installer arbeitet standardmäßig ohne Administratorrechte im aktuellen Benutzerkonto. Vault und Einstellungen bleiben bei späteren Aktualisierungen erhalten.

## Variante 2: Portable EXE

`FaNotes-Portable-2026.10.2-x64.exe` kann in einen beliebigen beschreibbaren Ordner oder auf einen USB-Stick kopiert und direkt gestartet werden. Die App-Daten liegen weiterhin im normalen Windows-Benutzerprofil; „portable“ bezieht sich auf die Programmdatei, nicht auf den Vault oder das lokale Erkennungsmodell.

## Grafiktablett

FaNotes verarbeitet die von Chromium bereitgestellten Pointer Events einschließlich Stiftdruck und Radierer. Für die beste Unterstützung sollten der aktuelle Herstellertreiber und Windows Ink aktiviert sein. Im Stiftmodus lässt sich ein Wort oder Zeichenbereich durch mehrfaches Hin- und Herkritzeln direkt löschen; `Strg+Z` stellt ihn wieder her. Die sichtbare Handschrift, Erkennung und Mathematikfunktionen sind mit der Linux-Ausgabe identisch.

## Automatische Updates

Die installierte und die portable Windows-Ausgabe verwenden dieselben Ed25519-signierten Stable- und Beta-Kanäle wie Linux. Unter **Einstellungen → Updates → Update-Kanal** kann zwischen gebündelten Stable-Releases und früheren Beta-Vorabversionen gewechselt werden; zurück zu Stable wird niemals eine ältere Version erzwungen. Ist ein passendes Update verfügbar, überträgt FaNotes nur die gegenüber der installierten `app.asar` geänderten Binärblöcke, rekonstruiert die neue Komponente lokal und prüft sie vollständig per SHA-256. Abgebrochene Delta-Downloads werden per HTTP Range fortgesetzt; bei einem fehlgeschlagenen Gesundheitscheck stellt FaNotes automatisch den geprüften Rückfallstand wieder her. Der vollständige Installer bleibt als manueller Website-Download verfügbar.

## Deinstallation

FaNotes lässt sich unter **Einstellungen → Apps → Installierte Apps** entfernen. Der selbst gewählte Vault wird dabei nicht gelöscht. Ein vollständiges Entfernen der lokalen Konfiguration ist vorher über **FaNotes → Einstellungen → Erweitert → App-Daten zurücksetzen** möglich.

## Windows-Sicherheitshinweis

Das Release-Manifest ist kryptografisch signiert und jede EXE besitzt eine veröffentlichte SHA-256-Prüfsumme. Solange für die EXE selbst kein öffentlich vertrauenswürdiges Authenticode-Zertifikat hinterlegt ist, kann Microsoft Defender SmartScreen beim ersten Start zusätzlich nach einer Bestätigung fragen.

## English

FaNotes supports Windows 10 and Windows 11 on `x64`. The installer and the portable build include the same features as the Linux app: a Markdown vault, pen input, local handwriting recognition, GlyphenWerk fully integrated with training and a live test, worksheet import, mathematics tools, text-to-handwriting, the AI area for LM Studio, Ollama, OpenAI, Gemini, Anthropic, and OpenCode, and the signed auto-updater.

## Check the download

The `SHA256SUMS` file published with each release contains the checksums of all Windows and Linux packages. In PowerShell, check a download like this:

```powershell
Get-FileHash .\FaNotes-Setup-2026.10.2-x64.exe -Algorithm SHA256
Get-FileHash .\FaNotes-Portable-2026.10.2-x64.exe -Algorithm SHA256
```

The printed values must match `SHA256SUMS` exactly.

## Option 1: Installer

1. Download `FaNotes-Setup-2026.10.2-x64.exe` and open it.
2. Confirm the Windows security dialog.
3. After installation, open FaNotes from the Start menu or the desktop shortcut.

By default the installer runs without administrator rights in the current user account. The vault and settings are kept across later updates.

## Option 2: Portable EXE

`FaNotes-Portable-2026.10.2-x64.exe` can be copied into any writable folder or onto a USB drive and started directly. App data still lives in the normal Windows user profile. “Portable” refers to the program file, not to the vault or the local recognition model.

## Graphics tablet

FaNotes handles the pointer events Chromium provides, including pen pressure and the eraser. For the best support, install the current vendor driver and enable Windows Ink. In pen mode, scribbling back and forth several times deletes a word or a drawn region directly; `Ctrl+Z` restores it. Visible handwriting, recognition, and mathematics match the Linux build.

## Automatic updates

The installed and the portable Windows builds use the same Ed25519-signed Stable and Beta channels as Linux. Under **Settings → Updates → Update channel** you can switch between bundled Stable releases and earlier Beta previews. Going back to Stable never forces an older version. When a matching update is available, FaNotes transfers only the binary blocks that changed from the installed `app.asar`, rebuilds the new component locally, and checks it completely with SHA-256. Interrupted delta downloads resume with HTTP Range. If a health check fails, FaNotes restores the verified fallback build. The full installer stays available as a manual download from the website.

## Uninstall

Remove FaNotes under **Settings → Apps → Installed apps**. The vault you chose is not deleted. To remove the local configuration completely first, use **FaNotes → Settings → Advanced → Reset app data**.

## Windows security notice

The release manifest is signed, and every EXE has a published SHA-256 checksum. Until the EXE itself carries a publicly trusted Authenticode certificate, Microsoft Defender SmartScreen may ask for an extra confirmation on the first launch.
