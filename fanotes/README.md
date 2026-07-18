# FaNotes

## Web-App

Die vollständige browserfähige Variante läuft unter `https://fanotes.fasrv.ch/notes/`. Sie verwendet dieselbe React-Oberfläche, Handschrift- und Mathematikengine wie die Desktop-App. Notizen, Ordner, Zeichnungen, Arbeitsblätter und Einstellungen werden getrennt vom Programmcache dauerhaft in IndexedDB gespeichert; ein versionsgebundener Service Worker stellt die App nach dem ersten vollständigen Laden auch offline bereit.

Desktop-spezifische Aktionen besitzen sichere Web-Entsprechungen: Bilder und PDFs werden über die Browser-Dateiauswahl importiert, Markdown-Notizen können heruntergeladen werden und Updates werden über den PWA-Cache ausgetauscht. Der gemeinsame AI-Bereich unterstützt LM Studio, Ollama und OpenCode direkt über `localhost`; OpenAI, Gemini und Anthropic laufen in der Web-App über einen eng begrenzten FaNotes-Proxy. Cloud-Schlüssel werden nur für den aktuellen Aufruf im Arbeitsspeicher gehalten und nicht in Browser, Backup oder Server gespeichert. Lokale Dienste müssen CORS für `https://fanotes.fasrv.ch` erlauben.

Unter **Einstellungen → Dateien & Vault** bleibt ein zusätzliches Server-Backup optional. Zur ersten Aktivierung wird der private Einrichtungs-Code des FaNotes-Servers benötigt; danach authentifiziert ein eigener Wiederherstellungscode jeden Zugriff. Notizen, Handschrift, Arbeitsblätter, Einstellungen ohne AI-Zugangsdaten und das persönliche Training werden automatisch gesichert. Bilder und PDFs werden serverseitig gescannt und neu aufgebaut, aktive PDF-Inhalte werden blockiert. Der Wiederherstellungscode muss außerhalb des Browsers aufbewahrt werden, weil er vom Server weder gelesen noch zurückgesetzt werden kann.

FaNotes ist eine lokale Desktop-App für Schule, UNI, Privatleben und Arbeit. Sie verbindet einen offenen Vault- und Markdown-Workflow mit einer gemeinsamen, papierartigen Seite für Tastatur und Grafiktablett sowie einer persönlich lernenden Handschrifterkennung.

## Was die App kann

- Fächer und Unterordner als echte Verzeichnisse verwalten
- Fächer mit individuellen, direkt im Vault gespeicherten Ordnerfarben organisieren
- Markdown-Dateien in einer einzigen FaNotes-Live-Ansicht schreiben und automatisch speichern
- mögliche Tippfehler wie in Word rot gewellt markieren und Deutsch oder Englisch pro Textabschnitt automatisch erkennen – vollständig lokal und auch in gemischten Notizen
- Überschriften, Hervorhebungen, Links, Listen, Aufgaben, Tabellen, Code und Mathematik über eine Formatierungsleiste einfügen
- ganze Abschnitte unter einem Titel direkt im Live-Editor ein- und ausklappen
- Markdown direkt auf einer Word-artigen Papierseite bearbeiten, ohne getrennten Quell-, Split- oder Vorschaumodus
- GitHub-Flavored Markdown, Tabellen, Aufgabenlisten und Wikilinks wie `[[Mechanik]]` darstellen
- Markdown-Markierungen außerhalb der bearbeiteten Zeile automatisch ausblenden sowie Inline- und Blockmathematik direkt via KaTeX setzen
- Bilder sowie ein- oder mehrseitige PDFs als Arbeitsblätter in die aktuelle oder automatisch in eine neue Notiz importieren
- importierte Arbeitsblätter in derselben Papieransicht mit frei platzierbaren Textfeldern oder direkt per Grafiktablett ausfüllen
- den ganzen Vault durchsuchen, mehrere Notizen in Tabs öffnen und eine Gliederung anzeigen
- die Ordner-Seitenleiste direkt in ihrem Kopfbereich ein- und über Dateisymbol, Statusleiste oder Befehlspalette wieder ausklappen
- auf derselben Notizseite jederzeit zwischen Tastatur und Maus, Touch oder Grafiktablett wechseln, inklusive Druck, Radierer, Glättung und Undo/Redo
- ganze A4-Handschrift-Seiten ohne Markdown-Zwang schreiben und automatisch als editierbare, mit der Notiz verknüpfte Strichdaten speichern
- unkonvertierte Handschrift lokal und unsichtbar als Text und Mathematik indexieren, damit sie über die Vault-Suche auffindbar bleibt
- Handschrift automatisch als Text oder Mathematik einordnen, den zuletzt erkannten Modus merken und das Ergebnis vor dem Einfügen korrigieren
- unsichere Buchstaben anhand deutscher oder englischer Wortkandidaten auflösen, beispielsweise `Test` statt `Tost`
- nach jeder Schreibpause im Hintergrund aus sicheren Wortkontext-Entscheidungen lernen, ohne die sichtbare Handschrift zu verändern
- GlyphenWerk vollständig innerhalb von FaNotes öffnen: Zeichen und mathematische Anordnungen erfassen, ganze Gleichungen oder Sätze live testen, Beispiele verwalten und Backups exportieren
- neue GlyphenWerk-Beispiele, bestätigte Testkorrekturen, eigene Zeichen sowie Integral-, Summen- und Indexlayouts ohne Export-Umweg direkt in das aktive FaNotes-Modell übernehmen
- normalen Text über **Text → Handschrift** mit den eigenen GlyphenWerk-Strichen als natürlich variierte, verbundene und weiter editierbare Handschrift auf die Seite setzen
- wahlweise die gesamte Handschriftseite oder nur einen frei aufgezogenen Bereich per Schnellbutton konvertieren
- die Stift-Schnellleiste dauerhaft am unteren Fensterrand erreichen; der Trainingsimport verschwindet dort nach erfolgreicher Einrichtung automatisch
- ein geschriebenes Wort oder einen Zeichenbereich durch mehrfaches Hin- und Herkritzeln natürlich löschen und die gesamte Geste mit einem einzelnen `Strg+Z` rückgängig machen
- deutsche oder englische Sprachmodelle für normale handschriftliche Sätze wählen
- Brüche, Wurzeln, Hoch-/Tiefstellungen sowie Grenzen von Integralen und Summen räumlich in LaTeX überführen
- den lokalen **Mathe-Löser** in der Stiftleiste aktivieren, handschriftliche Terme oder Gleichungen doppeltippen und sie vereinfachen, lösen, ausmultiplizieren, faktorisieren oder ausrechnen
- den **Mathe-Korrigierer** in derselben Toolbar aktivieren, einen mehrzeiligen Rechenweg frei einrahmen und den ersten beweisbar falschen Übergang direkt auf der Seite markieren
- erkannte Rechenzeilen vor der Bewertung bearbeiten; unsichere Zeichen und Definitionslücken werden gelb zur Bestätigung gestellt, statt fälschlich als Fehler ausgegeben zu werden
- berechnete Schritte automatisch rechts oder darunter mit den eigenen GlyphenWerk-Zeichen als persönliche, weiter editierbare Handschrift fortsetzen
- bestätigte Korrekturen als neue persönliche Trainingsbeispiele verwenden
- Farben, Schriften, Größen, Layout, Papier, Stift und Animationen umfangreich anpassen
- sieben Designwelten, vier Arbeitsflächen-Hintergründe und einen ablenkungsfreien Fokusmodus verwenden
- unter Linux die native Fensterleiste nutzen, damit Hyprland Rahmen und Fensterdekoration beeinflussen kann
- denselben vollständigen Funktionsumfang unter Windows 10/11 x64 und Linux x86_64 verwenden, einschließlich Grafiktablett, Erkennung, Mathematik, Arbeitsblättern und AI-Anbietern
- LM Studio, Ollama, OpenAI, Gemini, Anthropic oder OpenCode direkt in einer geöffneten Markdown-Notiz verwenden
- mehrere KI-Aktionen gleichzeitig kombinieren: freier Auftrag, Rechtschreibung, Wikilinks, Faktenprüfung, Stil, Struktur, Wissensergänzung, Zusammenfassung und Lernfragen
- jedes KI-Ergebnis zuerst als schön gerenderte oder rohe Markdown-Vorschau prüfen und erst danach bewusst übernehmen
- neue Versionen automatisch über die signierte FaNotes-Update-API prüfen, fortsetzbar herunterladen und nach dem sicheren Speichern installieren
- die Oberfläche sofort öffnen, während NAS-Vault und schwere Editorbausteine sicher im Hintergrund nachgeladen werden
- bei gleicher Eingabereaktion CPU und Akku schonen: gebündelte Editor-Updates, inkrementelles Canvas-Rendering und Leerlauf-Transkription vermeiden redundante Arbeit
- unter **Einstellungen → Erweitert** sämtliche App-Daten zurücksetzen, ohne Dokumente im Vault zu löschen
- in FaNotes Web optional eine authentifizierte, automatisch aktualisierte und serverseitig malwaregeprüfte Wiederherstellungskopie anlegen

## Daten, Vault und Datenschutz

Beim ersten Start entsteht standardmäßig ein Vault namens `FaNotes` im Dokumente-Ordner. Darin legt die App einen Eingang, die Fächer Mathematik, Deutsch, Englisch, Physik, Chemie, Biologie, Geschichte und Informatik sowie eine Willkommensnotiz an. Unter **Einstellungen → Dateien & Vault** kann jederzeit ein anderer lokaler Ordner gewählt werden.

Die Notizen bleiben normale `.md`-Dateien. Gespeicherte Handschrift-Seiten liegen als PNG und als editierbare Strichdaten im geschützten Ordner `.fanotes/assets` des Vaults. Importierte Arbeitsblätter und ihre frei platzierten Textfelder liegen unter `.fanotes/worksheets`; eine unsichtbare Markierung verbindet sie mit der jeweiligen Markdown-Notiz. Dort befindet sich auch das unsichtbare lokale Suchtranskript der Handschrift; es verändert weder die Seite noch eine Markdown-Datei. Ordnerfarben werden in `.fanotes/folder-colors.json` gespeichert und ziehen beim Umbenennen eines Faches mit um. Dadurch lässt sich der komplette Vault mit Git, Syncthing, Nextcloud oder einem NAS sichern, ohne an FaNotes gebunden zu sein. Ältere interne Vaultdaten übernimmt FaNotes beim ersten Öffnen automatisch und atomar.

Die Anwendung hat keinen Cloud-Zwang. Vault-Zugriffe laufen über eine begrenzte Electron-Schnittstelle; der Editor besitzt weder freien Dateisystem- noch freien Netzwerkzugriff. Für lokale AI-Anbieter darf ausschließlich der abgesicherte Hauptprozess eine geprüfte `localhost`- oder private LAN-Adresse ansprechen. OpenAI, Gemini und Anthropic verwenden ausschließlich die fest hinterlegten offiziellen HTTPS-Endpunkte. Zugangsdaten werden im Desktop-Profil über Electrons sicheren Betriebssystemspeicher verschlüsselt und aus Backups ausgeschlossen. Externe HTTP(S)-Links werden nur nach einem Klick im Standardbrowser geöffnet.

Der Auto-Updater verbindet sich ausschließlich per HTTPS mit `fanotes.fasrv.ch`. Linux und Windows besitzen getrennte Plattformkanäle; die App akzeptiert ausschließlich den zum laufenden System passenden Kanal. Das Update-Manifest ist zusätzlich mit Ed25519 signiert; die App enthält nur den öffentlichen Prüfschlüssel. Paketadresse, Version, Größe und SHA-256-Wert sind Teil der Signatur. Downloads werden nach einer Unterbrechung fortgesetzt, nach dem Empfang vollständig geprüft und unmittelbar vor dem Neustart erneut gehasht. Eine ältere als die bereits bekannte Version wird blockiert. Unter **Einstellungen → Updates** lassen sich automatische Prüfung, Hintergrunddownload und Installation beim Beenden einzeln steuern.

Das ausgelieferte AppImage startet ohne unsicheren Sandbox-Schalter. Auf ungewöhnlich gehärteten Systemen ohne unprivilegierte User-Namespaces sollte deshalb das Pacman-Paket verwendet werden, anstatt die Chromium-Sandbox abzuschalten.

Unter einer nativen Wayland-Sitzung deaktiviert FaNotes standardmäßig Chromiums Vulkan-/ANGLE-Vulkan-Experimente und überlässt Chromium die Wahl des kompatiblen GL-/EGL-Pfads. Eine ausdrücklich gesetzte Grafikoption bleibt davon unberührt. Vor dem Einzelinstanz-Lock entfernt die App außerdem ausschließlich nachweislich verwaiste Chromium-Start-Symlinks; ein aktiver oder nicht sicher zuordenbarer Prozess wird niemals beendet oder entsperrt.

Einstellungen und das persönliche Erkennungsmodell gehören zum lokalen Electron-Profil und liegen deshalb nicht im Vault. Unter Linux befindet sich das Profil typischerweise unter `~/.config/FaNotes/`, unter Windows unter `%APPDATA%\FaNotes\`. Beim ersten Start übernimmt FaNotes automatisch eine vorhandene frühere Konfiguration und Handschrift-Datenbank, ohne bereits vorhandene FaNotes-Daten zu überschreiben. Für ein vollständiges Backup sollte die App beendet und sowohl der Vault als auch der Profilordner gesichert werden.

Unter **Einstellungen → Erweitert → App-Daten zurücksetzen** kann das komplette lokale Profil geleert werden. Dabei werden Einstellungen, persönliches Handschrifttraining, Browserdaten, Caches und Update-Downloads entfernt und FaNotes anschließend neu gestartet. Markdown-Dateien, Bilder, PDFs, Handschriftseiten und Zeichnungen im gewählten Vault bleiben ausdrücklich erhalten.

## Handschrift einrichten

Die Erkennung ist absichtlich persönlich: Sie wird mit den Beispielen trainiert, die zur eigenen Handschrift passen.

1. In FaNotes links **GlyphenWerk** wählen oder `Strg+Umschalt+G` drücken.
2. Unter **Erfassen** ausreichend Beispiele für Buchstaben, Zahlen und Symbole schreiben. Für Hoch-/Tiefstellungen oder Grenzen von Integralen und Summen im mathematischen Test die erkannte räumliche Zuordnung bestätigen.
3. Unter **Erkennung testen** vollständige Gleichungen, Terme oder normale Sätze schreiben und unsichere Ergebnisse korrigieren. Bestätigte Beispiele und Layouts werden sofort in FaNotes aktiv; ein ZIP-Export ist nur noch für Backup oder Übertragung nötig.
4. Mit `Strg+D` auf derselben Notizseite zur Stifteingabe wechseln und frei auf der A4-Seite schreiben.
5. Nur wenn sichtbarer Text oder LaTeX gewünscht ist, **Seite konvertieren** oder **Bereich konvertieren** wählen. **Automatisch** vergleicht Text und Mathematik anhand der Zeichen und ihrer räumlichen Anordnung; **Text** und **Mathematik** bleiben als manuelle Auswahl verfügbar.
6. Unsichere Zeichen über ihre Alternativen oder direkt im Korrekturfeld berichtigen. Beim Einfügen lernt das lokale Modell aus bestätigten Korrekturen weiter.

Für den umgekehrten Weg im Stiftmodus **Text → Handschrift** wählen, Text einfügen und die Live-Vorschau anpassen. FaNotes wählt für jedes Zeichen eine persönliche Trainingsvorlage, variiert sie kontrolliert und verbindet geeignete Buchstaben innerhalb eines Wortes. Fehlende Trainingszeichen und Platzmangel werden vor dem Einfügen angezeigt. Das Ergebnis bleibt normale Stifttinte und kann deshalb radiert, ergänzt sowie rückgängig gemacht werden.

Zum Rechnen in derselben Ansicht den **Mathe-Löser** in der Stift-Toolbar aktivieren und einen vollständigen Term oder eine Gleichung doppeltippen. FaNotes erkennt auch räumlich geschriebene Brüche, Wurzeln und Indizes, zeigt den erkannten Ausdruck zur Kontrolle und bietet danach Vereinfachen, Lösen, Ausmultiplizieren, Faktorisieren oder Ausrechnen an. Die Ausgabe wird mit den persönlichen Trainingsstrichen als editierbare Tinte fortgesetzt. Unter **Fortsetzung** lässt sich die Position festlegen; **Automatisch gelernt** übernimmt Schriftgröße, Zeilenabstand und bevorzugte Anordnung aus bisherigen Lösungen.

Zum Kontrollieren eines eigenen Rechenwegs **Mathe-Korrigierer** wählen und einen Rahmen um mindestens zwei untereinander geschriebene Schritte ziehen. FaNotes trennt die Zeilen räumlich, hält Brüche und Indizes zusammen und prüft jeden Übergang lokal mit symbolischer Algebra. Der erste widerlegte Schritt wird rot markiert; wenn nur einzelne geänderte Zeichen verantwortlich sind, sitzt der Marker möglichst direkt auf dieser Stelle. Verlorene oder unzulässig ergänzte Lösungen markieren die ganze Zielzeile. Jede erkannte Zeile bleibt im Prüfpanel editierbar. Gelb bedeutet bewusst „nicht sicher entscheidbar“ – etwa bei mehrdeutiger Handschrift, Definitionslücken oder einer Umformung, für die die lokale Engine keinen vollständigen Beweis liefern kann.

GlyphenWerk und FaNotes speichern weiterhin in getrennten lokalen IndexedDB-Datenbanken; eine validierte interne Brücke übernimmt bestätigte Trainingsdaten direkt in das aktive FaNotes-Modell. Für bestehende Datensätze bleibt der ZIP-Import verfügbar. Er versteht `manifest.jsonl`, `labels.json` und, falls vorhanden, `layout_examples.jsonl` aus einem GlyphenWerk-Export. Die Erkennungsqualität hängt von Vielfalt, Menge und sauberer Beschriftung der Beispiele ab. Erkannte Inhalte bleiben deshalb vor dem Einfügen kontrollier- und korrigierbar.

## AI-Anbieter einrichten

1. Für einen lokalen Anbieter LM Studio, Ollama oder OpenCode samt Modell starten; für OpenAI, Gemini oder Anthropic einen API-Schlüssel bereithalten.
2. In FaNotes eine Markdown-Datei öffnen und `Strg+Umschalt+A` drücken.
3. Oben den gewünschten Anbieter wählen. FaNotes zeigt nur die dazu passenden Verbindungsfelder und lädt dessen Modelle automatisch. Lokale Adressen sind auf `localhost` oder private Netze begrenzt; Cloud-Anbieter verwenden feste offizielle Endpunkte.
4. Eine oder mehrere Aktionen markieren. Für **Freien Auftrag ausführen** zusätzlich die konkrete Anweisung schreiben.
5. **Vorschau erzeugen** wählen und das Ergebnis in der gerenderten oder der Markdown-Ansicht kontrollieren.
6. Nur bei einem passenden Ergebnis **Ergebnis übernehmen** wählen. Erst dann wird die geöffnete Notiz geändert und automatisch gespeichert.

Anbieter und Modellwahl bleiben lokal gespeichert. Desktop-Zugangsdaten werden verschlüsselt; in FaNotes Web werden Cloud-Schlüssel beim Schließen des AI-Bereichs vergessen. Die Faktenprüfung verwendet nur die Fähigkeiten des gewählten Modells; zeitabhängige oder unsichere Aussagen müssen deshalb weiterhin geprüft werden. FaNotes deaktiviert bei OpenCode alle Werkzeuge, damit eine Notizbearbeitung keine Dateien, Shell-Befehle oder Webzugriffe ausführen kann.

## Arbeitsblätter importieren

1. Eine vorhandene Notiz öffnen und oben **Arbeitsblatt** wählen oder `Strg+Umschalt+I` drücken.
2. **In aktuelle Notiz** oder **Als neue Notiz** wählen und anschließend eine PDF-, PNG-, JPEG-, WebP- oder GIF-Datei öffnen.
3. Für Tastatureingaben am importierten Blatt **Textfeld** wählen und auf die gewünschte Stelle klicken. Felder und Antworten speichern sich automatisch.
4. Für handschriftliche Antworten wie gewohnt auf **Stift** wechseln. Die gemeinsame Stiftebene deckt Markdown und alle importierten Seiten ab.

PDFs werden ausschließlich lokal gerendert. Originaldatei, Textfelder und Stiftstriche gehören zum Vault und sollten gemeinsam gesichert werden.

## Tastenkürzel

| Aktion | Tastenkürzel |
| --- | --- |
| Befehlspalette | `Strg+P` |
| Neue Notiz | `Strg+N` |
| Speichern | `Strg+S` |
| Vault durchsuchen | `Strg+Umschalt+F` |
| AI-Assistent | `Strg+Umschalt+A` |
| GlyphenWerk Training & Test | `Strg+Umschalt+G` |
| Bild oder PDF als Arbeitsblatt | `Strg+Umschalt+I` |
| Tastatur/Stift wechseln | `Strg+D` |
| Fokusmodus | `Strg+Umschalt+E` |
| Fett / kursiv / Link | `Strg+B` / `Strg+I` / `Strg+K` |
| Einstellungen | `Strg+,` |
| Zeichnung rückgängig/wiederholen | `Strg+Z` / `Strg+Y` |

## Windows und Arch Linux installieren

Für Windows 10/11 x64 stehen ein Benutzer-Installer und eine einzelne portable EXE bereit. Beide enthalten alle Funktionen der Linux-Ausgabe. Die vollständigen Schritte, Tablet-Hinweise, Updateinformationen und PowerShell-Prüfsummenbefehle stehen in [packaging/INSTALL_WINDOWS.md](packaging/INSTALL_WINDOWS.md).

Für Arch Linux stehen drei Wege bereit:

- **AppImage:** direkt ausführen, ohne Systeminstallation
- **Portable tar.gz:** in einen beliebigen Benutzerordner entpacken
- **Pacman-Paket:** das portable Archiv mit dem mitgelieferten `PKGBUILD` lokal als `.pkg.tar.zst` paketieren

Die vollständigen Schritte, Desktop-Integration und Tablet-Hinweise stehen in [packaging/INSTALL_ARCH.md](packaging/INSTALL_ARCH.md).

## Entwicklung

Vorausgesetzt werden Node.js 22 oder neuer und npm.

### Gemeinsame Erkennung, passende Laufzeit

FaNotes hält Segmentierung, persönliche GlyphenWerk-Daten, Text-/Mathematikentscheidung und Korrekturlogik in einem gemeinsamen Renderer-Pfad. Nur die lokale neuronale Inferenz ist plattformspezifisch:

- Die Web-App verwendet ein dynamisch quantisiertes Q8-Zeilenmodell und einen Q8-Encoder/Q8-Decoder über ONNX Runtime WASM. Sie nutzt höchstens zwei OCR-Threads und gibt die Worker nach der konfigurierten Inaktivitätszeit frei.
- Linux und Windows verwenden dasselbe FP32-Zeilenmodell über ONNX Runtime Node in einem verzögert gestarteten CPU-Worker. Die Runtime wählt die passenden SIMD-Instruktionen des Intel- oder AMD-Prozessors und verwendet höchstens vier Threads.
- Im Desktop-Modus kann optional das größere Kontextmodell ergänzt werden. Der kompakte Modus spart RAM; beide Modi greifen auf dieselben Trainingsbeispiele und anschließenden Korrekturen zu.

Die nativen Pakete enthalten ausschließlich die jeweilige x64-CPU-Bibliothek. Alle Modell- und Laufzeitdateien werden vor der Verwendung gegen ihre im Manifest hinterlegte Größe und SHA-256-Prüfsumme geprüft.

```bash
cd fanotes
npm ci
npm run dev
```

Nützliche Prüfungen und Builds:

```bash
npm run typecheck
npm run check:efficiency
npm run check:startup
npm run check:themes
npm run check:scribble-erase
npm run check:glyphenwerk
npm run check:math-corrector
npm run check:updater
npm run build
npm run dist:dir
npm run dist:windows
```

`dist:dir` erzeugt den unverpackten Linux-Build unter `release/linux-unpacked`. Das Arch-kompatible portable Archiv enthält einen einzelnen Top-Level-Ordner:

```text
FaNotes-2.50.1-x86_64/
├── fanotes
├── resources/
└── ...
```

Ein reproduzierbar sortiertes Archiv kann daraus mit GNU tar erzeugt werden:

```bash
version=2.50.1
stage="release/FaNotes-${version}-x86_64"
rm -rf "$stage"
cp -a release/linux-unpacked "$stage"
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='@0' \
  --mode='u+rwX,go+rX,go-w' \
  -czf "release/FaNotes-${version}-x86_64.tar.gz" \
  -C release "$(basename "$stage")"
```

## Lizenz

Der Anwendungscode steht unter der MIT-Lizenz. Abhängigkeiten und eingebettete Schriften behalten ihre jeweiligen Lizenzen; siehe deren Paketmetadaten im npm-Lockfile.
