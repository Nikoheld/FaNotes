# FaNotes unter Windows installieren

FaNotes unterstützt Windows 10 und Windows 11 auf `x64`. Installer und portable Ausgabe enthalten dieselben Funktionen wie die Linux-App: Markdown-Vault, Stifteingabe, lokale Handschrifterkennung, das vollständig integrierte GlyphenWerk mit Training und Live-Test, Arbeitsblattimport, Mathematikwerkzeuge, Text-zu-Handschrift, den AI-Bereich für LM Studio, Ollama, OpenAI, Gemini, Anthropic und OpenCode sowie den signierten Auto-Updater.

## Download prüfen

Die zu jeder Veröffentlichung angebotene Datei `SHA256SUMS` enthält die Prüfsummen aller Windows- und Linux-Pakete. In PowerShell lässt sich ein Download so prüfen:

```powershell
Get-FileHash .\FaNotes-Setup-2026.7.1-beta.2-x64.exe -Algorithm SHA256
Get-FileHash .\FaNotes-Portable-2026.7.1-beta.2-x64.exe -Algorithm SHA256
```

Die ausgegebenen Werte müssen exakt mit `SHA256SUMS` übereinstimmen.

## Variante 1: Installer

1. `FaNotes-Setup-2026.7.1-beta.2-x64.exe` herunterladen und öffnen.
2. Den Windows-Sicherheitsdialog bestätigen.
3. Nach der Installation FaNotes über Startmenü oder Desktop-Verknüpfung öffnen.

Der Installer arbeitet standardmäßig ohne Administratorrechte im aktuellen Benutzerkonto. Vault und Einstellungen bleiben bei späteren Aktualisierungen erhalten.

## Variante 2: Portable EXE

`FaNotes-Portable-2026.7.1-beta.2-x64.exe` kann in einen beliebigen beschreibbaren Ordner oder auf einen USB-Stick kopiert und direkt gestartet werden. Die App-Daten liegen weiterhin im normalen Windows-Benutzerprofil; „portable“ bezieht sich auf die Programmdatei, nicht auf den Vault oder das lokale Erkennungsmodell.

## Grafiktablett

FaNotes verarbeitet die von Chromium bereitgestellten Pointer Events einschließlich Stiftdruck und Radierer. Für die beste Unterstützung sollten der aktuelle Herstellertreiber und Windows Ink aktiviert sein. Im Stiftmodus lässt sich ein Wort oder Zeichenbereich durch mehrfaches Hin- und Herkritzeln direkt löschen; `Strg+Z` stellt ihn wieder her. Die sichtbare Handschrift, Erkennung und Mathematikfunktionen sind mit der Linux-Ausgabe identisch.

## Automatische Updates

Die installierte und die portable Windows-Ausgabe verwenden dieselben Ed25519-signierten Stable- und Beta-Kanäle wie Linux. Unter **Einstellungen → Updates → Update-Kanal** kann zwischen gebündelten Stable-Releases und früheren Beta-Vorabversionen gewechselt werden; zurück zu Stable wird niemals eine ältere Version erzwungen. Ist ein passendes Update verfügbar, überträgt FaNotes nur die gegenüber der installierten `app.asar` geänderten Binärblöcke, rekonstruiert die neue Komponente lokal und prüft sie vollständig per SHA-256. Abgebrochene Delta-Downloads werden per HTTP Range fortgesetzt; bei einem fehlgeschlagenen Gesundheitscheck stellt FaNotes automatisch den geprüften Rückfallstand wieder her. Der vollständige Installer bleibt als manueller Website-Download verfügbar.

## Deinstallation

FaNotes lässt sich unter **Einstellungen → Apps → Installierte Apps** entfernen. Der selbst gewählte Vault wird dabei nicht gelöscht. Ein vollständiges Entfernen der lokalen Konfiguration ist vorher über **FaNotes → Einstellungen → Erweitert → App-Daten zurücksetzen** möglich.

## Windows-Sicherheitshinweis

Das Release-Manifest ist kryptografisch signiert und jede EXE besitzt eine veröffentlichte SHA-256-Prüfsumme. Solange für die EXE selbst kein öffentlich vertrauenswürdiges Authenticode-Zertifikat hinterlegt ist, kann Microsoft Defender SmartScreen beim ersten Start zusätzlich nach einer Bestätigung fragen.
