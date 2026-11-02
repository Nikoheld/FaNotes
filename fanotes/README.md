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
- auf einer Notiz oder einem PDF eine Verlinkung setzen (Symbol oder Text); ein Tippen öffnet die neue Notiz, oben führt Zurück zurück
- unter Experimentell einen Backup-Knopf in der oberen Leiste einschalten: die aktuelle Notiz so sichern, wie sie ist, und später weitere Backups machen oder alte wiederherstellen
- einem Fach ein PDF-Buch zuordnen und die Ansicht oben einblenden (Links, Rechts, Oben, Unten oder auspoppen); die Seite bleibt gemerkt, Notizen liegen auf dem Buch-PDF
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
- unter Linux mit Ozone X11 starten, damit Stift und Trackpad denselben Seat teilen, und die native Fensterleiste nutzen, damit Hyprland Rahmen und Fensterdekoration beeinflussen kann
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

Die Notizen bleiben normale `.md`-Dateien. Gespeicherte Handschrift-Seiten liegen als PNG und als editierbare Strichdaten im geschützten Ordner `.fanotes/assets` des Vaults. Importierte Arbeitsblätter und ihre frei platzierten Textfelder liegen unter `.fanotes/worksheets`; eine unsichtbare Markierung verbindet sie mit der jeweiligen Markdown-Notiz. Dort befindet sich auch das unsichtbare lokale Suchtranskript der Handschrift; es verändert weder die Seite noch eine Markdown-Datei. Ordnerfarben werden in `.fanotes/folder-colors.json` gespeichert und ziehen beim Umbenennen eines Faches mit um. Über **Ordnerpfad** im Ordnermenü kann ein Fach zusätzlich einen oder mehrere Ordner außerhalb des Vaults anzeigen. Neue Notizen entstehen im ersten dieser Pfade. Die Zuordnung liegt im lokalen Profil (`folder-locations.json`) und wird nicht mit dem Vault synchronisiert. Dadurch lässt sich der komplette Vault mit Git, Syncthing, Nextcloud oder einem NAS sichern, ohne an FaNotes gebunden zu sein. Ältere interne Vaultdaten übernimmt FaNotes beim ersten Öffnen automatisch und atomar.

Die Anwendung hat keinen Cloud-Zwang. Vault-Zugriffe laufen über eine begrenzte Electron-Schnittstelle; der Editor besitzt weder freien Dateisystem- noch freien Netzwerkzugriff. Für lokale AI-Anbieter darf ausschließlich der abgesicherte Hauptprozess eine geprüfte `localhost`- oder private LAN-Adresse ansprechen. OpenAI, Gemini und Anthropic verwenden ausschließlich die fest hinterlegten offiziellen HTTPS-Endpunkte. Zugangsdaten werden im Desktop-Profil über Electrons sicheren Betriebssystemspeicher verschlüsselt und aus Backups ausgeschlossen. Externe HTTP(S)-Links werden nur nach einem Klick im Standardbrowser geöffnet.

Der Auto-Updater lädt das signierte Manifest und die Pakete per HTTPS von den GitHub-Releases dieses Projekts. Linux und Windows besitzen getrennte Plattformkanäle; die App akzeptiert ausschließlich den zum laufenden System passenden Kanal und ausschließlich Adressen von GitHub. Das Update-Manifest ist zusätzlich mit Ed25519 signiert; die App enthält nur den öffentlichen Prüfschlüssel. Paketadresse, Version, Größe und SHA-256-Wert sind Teil der Signatur. Downloads werden nach einer Unterbrechung fortgesetzt, nach dem Empfang vollständig geprüft und unmittelbar vor dem Neustart erneut gehasht. Eine ältere als die bereits bekannte Version wird blockiert. Unter **Einstellungen → Updates** lassen sich automatische Prüfung, Hintergrunddownload und Installation beim Beenden einzeln steuern. Der Notizabgleich bleibt auf `fanotes.fasrv.ch`.

Das ausgelieferte AppImage startet ohne unsicheren Sandbox-Schalter. Auf ungewöhnlich gehärteten Systemen ohne unprivilegierte User-Namespaces sollte deshalb das Pacman-Paket verwendet werden, anstatt die Chromium-Sandbox abzuschalten.

Unter Linux startet FaNotes mit Ozone X11, damit Stift und Trackpad denselben Seat teilen. Steht in der Hyprland-Config oder einer per `source =` eingebundenen Datei `force_zero_scaling = true`, übernimmt die App die Geräteskalierung selbst: sie liest die Skalierung des fokussierten Monitors über `hyprctl -j monitors` (1.25, 1.5, 2 …); `FANOTES_DEVICE_SCALE` überschreibt, `GDK_SCALE` (× `GDK_DPI_SCALE`) ist der Ersatz ohne `hyprctl`, sonst 2. Ohne `force_zero_scaling` skaliert Hyprland das XWayland-Fenster hoch, was auf HiDPI-Monitoren unscharf wirkt — die App vermerkt das im Startprotokoll. Vulkan-/ANGLE-Vulkan-Experimente bleiben im nativen Wayland-Pfad aus; Chromium wählt den kompatiblen GL-/EGL-Pfad. Eine ausdrücklich gesetzte Grafikoption bleibt davon unberührt. Vor dem Einzelinstanz-Lock entfernt die App außerdem ausschließlich nachweislich verwaiste Chromium-Start-Symlinks; ein aktiver oder nicht sicher zuordenbarer Prozess wird niemals beendet oder entsperrt.

Einstellungen und das persönliche Erkennungsmodell gehören zum lokalen Electron-Profil und liegen deshalb nicht im Vault. Unter Linux befindet sich das Profil typischerweise unter `~/.config/FaNotes/`, unter Windows unter `%APPDATA%\FaNotes\`. Beim ersten Start übernimmt FaNotes automatisch eine vorhandene frühere Konfiguration und Handschrift-Datenbank, ohne bereits vorhandene FaNotes-Daten zu überschreiben. Für ein vollständiges Backup sollte die App beendet und sowohl der Vault als auch der Profilordner gesichert werden.

Unter **Einstellungen → Erweitert → App-Daten zurücksetzen** kann das komplette lokale Profil geleert werden. Dabei werden Einstellungen, persönliches Handschrifttraining, Browserdaten, Caches und Update-Downloads entfernt und FaNotes anschließend neu gestartet. Markdown-Dateien, Bilder, PDFs, Handschriftseiten und Zeichnungen im gewählten Vault bleiben ausdrücklich erhalten.

## Handschrift einrichten

Die Texterkennung läuft nur in der Desktop-App für Windows und Linux. Stiftstriche werden in Zeilen gruppiert, als festes Zeilenbild gezeichnet und lokal vom `fanotes-ocr`-Sidecar gelesen. Gruppierung, Darstellung und die sprachmodellgestützte Decodierung bleiben in der App. Web und Android führen diese Erkennung nicht aus. Mathematik bleibt der bisherige GlyphenWerk-Pfad.

1. Unter **Einstellungen → Experimentell** **Handschrift zu Text** einschalten.
2. Mit `Strg+D` auf derselben Notizseite zur Stifteingabe wechseln und frei auf der A4-Seite schreiben.
3. **Seite konvertieren** oder **Bereich konvertieren** wählen. **Automatisch** vergleicht Text und Mathematik; **Text** und **Mathematik** bleiben als manuelle Auswahl verfügbar. Die Textsprache steht unter **Einstellungen → Stift & Erkennung** (Deutsch oder Englisch).
4. Unsichere Zeichen über ihre Alternativen oder direkt im Korrekturfeld berichtigen. Beim Einfügen speichert FaNotes die bestätigte Zeile lokal: der Wortschatz wächst sofort, eine spätere unbekannte Schreibung innerhalb von zwei Buchstaben übernimmt das bestätigte Wort, und ab acht Zeilen lassen sich Stiftbreite, Neigung und Grösse unter **Persönliche Handschrift** anpassen. Die Anpassung bewertet die korrigierte Lesung, nicht nur die Rohausgabe des Decoders.
5. Für ein tieferes, weiterhin lokales Modell die Trainingszeilen exportieren, mit `fanotes/scripts/ink-model/personalize.py` ein persönliches Modell erzeugen und `personal-model.onnx` plus `personal-model.json` importieren. Diagnosezeilen in der Entwicklerkonsole schaltet derselbe Bereich ein.

GlyphenWerk bleibt der Weg für persönliche Mathematikzeichen und für Text → Handschrift:

1. In FaNotes links **GlyphenWerk** wählen oder `Strg+Umschalt+G` drücken.
2. Unter **Erfassen** ausreichend Beispiele für Buchstaben, Zahlen und Symbole schreiben. Für Hoch-/Tiefstellungen oder Grenzen von Integralen und Summen im mathematischen Test die erkannte räumliche Zuordnung bestätigen.
3. Unter **Erkennung testen** vollständige Gleichungen oder Terme schreiben und unsichere Ergebnisse korrigieren. Bestätigte Beispiele und Layouts werden sofort für Mathematik und Text → Handschrift aktiv; ein ZIP-Export ist nur noch für Backup oder Übertragung nötig. Normale Sätze liest die Desktop-Stifterkennung oben, nicht GlyphenWerk.

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
| Datum einfügen | `Strg+Umschalt+D` |
| Fokusmodus | `Strg+Umschalt+E` |
| Fett / kursiv / Link | `Strg+B` / `Strg+I` / `Strg+K` |
| Einstellungen | `Strg+,` |
| Zeichnung rückgängig/wiederholen | `Strg+Z` / `Strg+Y` |
| Notiz duplizieren | `Alt+Umschalt+D` |
| Aufgabe umschalten | `Strg+Enter` |

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

FaNotes hält Zeilengruppierung, GlyphenWerk-Daten, Text-/Mathematikentscheidung und Korrekturlogik im Renderer. Die Texterkennung selbst gibt es nur auf dem Desktop:

- Windows und Linux rendern jede Zeile in `fanotes-recog` (WebAssembly) und führen das FP32-Zeilenmodell im nativen `fanotes-ocr`-Sidecar aus (`crates/fanotes-ort`, ONNX Runtime). Die Decodierung mit Zeichen-Sprachmodell und Wörterbuch läuft wieder in WebAssembly. Deutsch nutzt das stärkere Sprachmodellgewicht; Englisch ein leichteres, damit seltene Schreibungen dem Stift folgen. Zwei in Großbuchstaben geschriebene Wörter werden verbunden, wenn der Stift dazwischen keine Lücke gezeichnet hat. Zwei Teile werden auch verbunden, wenn ein Stift-Token genau diese Buchstaben plus höchstens einen zusätzlichen Buchstaben enthält. Eine leichte Rückneigung wird nur übernommen, wenn sie genau zwei benachbarte Wörter neu liest und dabei sicherer ist. Eine etwas größere Darstellung ersetzt ein Wörterbuchwort nur, wenn das neue Wort genau einen Buchstaben länger ist und sonst nichts sich ändert (`Grad` → `Grund`). Wenn die Stiftbuchstaben plus ein weiterer Buchstabe mehrere Wörterbuchwörter ergeben, wählt das Zeichenmodell das deutlich wahrscheinlichere (`dauen` → `dauern`). Nach einem Artikel wird ein kleingeschriebenes Wörterbuchwort mit einer typischen Nomenendung großgeschrieben (`das mikrofon` → `Mikrofon`). Ein unbekanntes Wort wird zur einzigen Wörterbuchschreibung, die einen Umlaut setzt und einen weiteren Buchstaben ändert (`entlauscht` → `enttäuscht`). Ein Wort mit einem Großbuchstaben in der Mitte nimmt die einzige Wörterbuchschreibung an, die sich in genau zwei Buchstaben unterscheidet, und behält die unveränderten Großbuchstaben (`EwtopEan` → `EuropEan`). Besteht eine Zeile aus Dreiergruppen und eine davon ist kein wiederholter Buchstabe, übernimmt eine etwas kleinere Darstellung die Rohlesung, wenn diese Gruppe dort aus drei gleichen Buchstaben besteht (`TAF UUU` → `TTT UUU`). Ein Wörterbuchwort wird durch die Lesung seiner eigenen Striche ersetzt, wenn diese ein Wörterbuchwort mit genau einem Buchstaben mehr ist (`Watched` → `Wretched`). Zwei schmale Striche, die als 66 gelesen werden und vor einem Wort mit schließendem Anführungszeichen stehen, werden zum öffnenden Anführungszeichen (`66 Erdkunde"` → `"Erdkunde"`). Ein langes unbekanntes Wort wird durch die Lesung einer abgetrennten Strichgruppe ersetzt, wenn diese aus zwei Wörterbuchwörtern besteht (`Landschottensträsse` → `Landschaftsgeräte`). Ein Wort aus drei Buchstaben, das nicht am Zeilenanfang steht, wird kleingeschrieben, wenn eine nahe Lesung es bereits so hat (`Job` → `job`). Auf einer englischen Zeile wird der erste Buchstabe kleingeschrieben, wenn die beste Lesung noch mit diesem Großbuchstaben beginnt, eine nahe Lesung dieselbe Zeile bereits kleinschreibt, der Kleinbuchstabe sichtbar ist und das Wort im Wörterbuch steht (`Wretched` → `wretched`). Ein allein stehendes englisches `i` wird zu `I` (`i know` → `I know`). Ein Anführungszeichen direkt an einer schließenden Klammer rückt vor das folgende kleingeschriebene Wort (`(Tanis 6a)" if` → `(Tanis 6a) "if`). Eine Zahl vor einer kurzen Folge von Großbuchstaben bekommt einen Punkt (`1 FC` → `1. FC`). Eine schließende Klammer ohne öffnende Klammer vor einem Großbuchstaben wird ein Punkt (`genannt) Die` → `genannt. Die`). Zwei verschiedene Anführungszeichen direkt hintereinander bekommen ein Leerzeichen (`'Garz'"Such` → `'Garz' "Such`). Nach `einen` steht vor einem langen großgeschriebenen Wort `der` (`einen des Landschaftsgeräte` → `einen der`). Ein unbekanntes Wort behält den einen Endbuchstaben, den die Rohlesung angehängt hat (`Chudley` → `Chudleyh`). Ist die Rohlesung das gewählte Wort plus ein Buchstabe, und ein Tausch zweier Nachbarbuchstaben ergibt genau ein Wörterbuchwort, wird dieses genommen (`in` mit Rohlesung `ien` → `ein`). Ein bestätigtes persönliches Wort ersetzt eine spätere unbekannte Schreibung, die höchstens zwei Buchstaben daneben liegt (`Chudleyh` → `Chudleigh`). Ein Satzadverb am Zeilenanfang wird großgeschrieben (`manchmal` → `Manchmal`), und `Sein` mitten im Satz wird zum Verb `sein`, außer nach einem Artikel. Ein fast durchgängig großgeschriebenes Wort verliert seinen einzelnen Kleinbuchstaben (`JuDKINB` → `JUDKINB`). Steht am Ende eines solchen Wortes ein D, dessen Alternative B ist, wird das B als eigener Buchstabe geschrieben (`JuDKIND` → `JuDKIN B`). Wird eine andere Darstellung behalten, bleibt ein Buchstabe aus einer nahen aufrechten Lesung erhalten, wenn beide Schreibungen im Wörterbuch stehen (`Marie` → `Marine`). Ein großgeschriebenes Wörterbuchwort nimmt das folgende lange kleingeschriebene unbekannte Wort auf (`Marine luftstreitkraft` → `Marineluftstreitkraft`). Endet so ein unbekanntes Wort auf kraft und eine nahe Lesung hat bereits das Plural-e, wird daraus die Wörterbuchform kräfte (`Marineluftstreitkräfte`). Der Sidecar startet verzögert und verwendet höchstens vier Threads.
- Web und Android haben keinen Sidecar und führen diese Erkennung nicht aus. Mathematik, GlyphenWerk und Text → Handschrift bleiben dort verfügbar.
- Ein optionales persönliches Modell ersetzt nur die Textzeilen und liegt im lokalen Profil, nicht im Vault.

Alle Modelldateien werden vor der Verwendung gegen die im Manifest hinterlegte Größe und SHA-256-Prüfsumme geprüft. Der Nachbau des Zeilenmodells steht in `fanotes/scripts/ink-model/README.md`; `npm run check:ink-recognition` prüft die Desktop-Pipeline an den Gold-Zeilen.

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
npm run check:ink-recognition
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

## English

## Web app

The full browser build runs at `https://fanotes.fasrv.ch/notes/`. It uses the same React interface and the same handwriting and mathematics engine as the desktop app. Notes, folders, drawings, worksheets, and settings are stored persistently in IndexedDB, separate from the program cache. After the first full load, a versioned service worker also makes the app available offline.

Desktop-specific actions have safe web equivalents: images and PDFs are imported through the browser file picker, Markdown notes can be downloaded, and updates are swapped through the PWA cache. The shared AI area supports LM Studio, Ollama, and OpenCode directly over `localhost`. OpenAI, Gemini, and Anthropic run in the web app through a tightly limited FaNotes proxy. Cloud keys are kept in memory only for the current call and are not stored in the browser, in a backup, or on the server. Local services must allow CORS for `https://fanotes.fasrv.ch`.

Under **Settings → Files & vault**, an extra server backup stays optional. The first activation needs the private setup code of the FaNotes server. After that, a personal recovery code authenticates every access. Notes, handwriting, worksheets, settings without AI credentials, and personal training are backed up automatically. Images and PDFs are scanned and rebuilt on the server, and active PDF content is blocked. Keep the recovery code outside the browser, because the server can neither read it nor reset it.

FaNotes is a local desktop app for school, university, personal life, and work. It combines an open vault and Markdown workflow with one paper-like page for keyboard and graphics tablet, plus handwriting recognition that learns from you.

## What the app can do

- Manage subjects and subfolders as real directories
- Organize subjects with individual folder colors stored directly in the vault
- Write Markdown files in a single FaNotes live view and save them automatically
- Place a link on a note or a PDF (symbol or text); a tap opens the new note, and Back at the top returns
- Under Experimental, turn on a backup button in the top bar: save the current note as it is, then make further backups or restore older ones
- Attach a PDF book to a subject and show the view at the top (left, right, above, below, or popped out); the page is remembered, and notes sit on the book PDF
- Mark possible typos with a red wavy underline, as in Word, and detect German or English per text span automatically — fully local, including in mixed notes
- Insert headings, emphasis, links, lists, tasks, tables, code, and mathematics from a formatting bar
- Collapse and expand whole sections under a heading directly in the live editor
- Edit Markdown directly on a word-processor-style paper page, without a separate source, split, or preview mode
- Render GitHub-flavored Markdown, tables, task lists, and wiki links such as `[[Mechanics]]`
- Hide Markdown marks outside the line being edited, and set inline and block mathematics directly with KaTeX
- Import images and one- or multi-page PDFs as worksheets into the current note, or automatically into a new note
- Fill imported worksheets in the same paper view with freely placed text fields or directly with a graphics tablet
- Search the whole vault, open several notes in tabs, and show an outline
- Collapse the folder sidebar from its header and expand it again from the file icon, the status bar, or the command palette
- Switch on the same note page at any time between keyboard and mouse, touch, or graphics tablet, including pressure, eraser, smoothing, and undo/redo
- Write full A4 handwriting pages without being forced into Markdown, and automatically store them as editable stroke data linked to the note
- Index unconverted handwriting locally and invisibly as text and mathematics, so vault search can still find it
- Classify handwriting automatically as text or mathematics, remember the last recognized mode, and correct the result before inserting it
- Resolve uncertain letters with German or English word candidates, for example `Test` instead of `Tost`
- Learn in the background from confident word-context decisions after each writing pause, without changing the visible handwriting
- Open GlyphenWerk entirely inside FaNotes: capture characters and mathematical arrangements, live-test whole equations or sentences, manage samples, and export backups
- Take new GlyphenWerk samples, confirmed test corrections, custom characters, and integral, sum, and index layouts straight into the active FaNotes model, without an export detour
- Place ordinary text on the page as naturally varied, connected, still editable handwriting through **Text → Handwriting**, using your own GlyphenWerk strokes
- Convert the whole handwriting page, or only a freely drawn region, with a quick button
- Keep the pen quick bar permanently at the bottom edge of the window; the training import disappears there automatically after a successful setup
- Delete a written word or a drawn region naturally by scribbling back and forth, and undo the whole gesture with a single `Ctrl+Z`
- Choose German or English language models for ordinary handwritten sentences
- Turn fractions, roots, superscripts and subscripts, and the limits of integrals and sums into spatial LaTeX
- Enable the local **math solver** in the pen bar, double-tap handwritten terms or equations, and simplify, solve, expand, factor, or evaluate them
- Enable the **math checker** in the same toolbar, freely frame a multi-line calculation, and mark the first provably wrong step directly on the page
- Edit recognized calculation lines before they are judged; uncertain characters and gaps in the definition are shown in yellow for confirmation instead of being reported as errors
- Continue calculated steps automatically to the right or below, using your own GlyphenWerk characters as personal, still editable handwriting
- Use confirmed corrections as new personal training samples
- Adjust colors, fonts, sizes, layout, paper, pen, and animations extensively
- Use seven design worlds, four workspace backgrounds, and a distraction-free focus mode
- On Linux, start with Ozone X11 so pen and trackpad share the same seat, and use the native window bar so Hyprland can affect frames and window decoration
- Use the same full feature set on Windows 10/11 x64 and Linux x86_64, including graphics tablet, recognition, mathematics, worksheets, and AI providers
- Use LM Studio, Ollama, OpenAI, Gemini, Anthropic, or OpenCode directly in an open Markdown note
- Combine several AI actions at once: free instruction, spelling, wiki links, fact check, style, structure, added knowledge, summary, and study questions
- Review every AI result first as a rendered or raw Markdown preview, and apply it only when you choose to
- Check for new versions automatically through the signed FaNotes update API, download them resumable, and install them after a safe save
- Open the interface immediately while a NAS vault and heavy editor pieces load safely in the background
- Spare CPU and battery at the same input response: batched editor updates, incremental canvas rendering, and idle transcription avoid redundant work
- Under **Settings → Advanced**, reset all app data without deleting documents in the vault
- In FaNotes Web, optionally keep an authenticated, automatically updated recovery copy that is checked for malware on the server

## Data, vault, and privacy

On the first start, a vault named `FaNotes` is created in the Documents folder by default. The app adds an Inbox, the subjects Mathematics, German, English, Physics, Chemistry, Biology, History, and Computer science, and a welcome note. Under **Settings → Files & vault** you can choose another local folder at any time.

Notes stay ordinary `.md` files. Saved handwriting pages live as PNG and as editable stroke data in the vault's protected `.fanotes/assets` folder. Imported worksheets and their freely placed text fields live under `.fanotes/worksheets`. An invisible marker ties them to the matching Markdown note. The invisible local search transcript of the handwriting is stored there too; it changes neither the page nor a Markdown file. Folder colors are stored in `.fanotes/folder-colors.json` and move with a subject when it is renamed. The whole vault can therefore be backed up with Git, Syncthing, Nextcloud, or a NAS without being locked to FaNotes. FaNotes takes over older internal vault data automatically and atomically the first time it is opened.

The app does not require a cloud. Vault access goes through a limited Electron interface; the editor has neither free file-system access nor free network access. For local AI providers, only the protected main process may contact a checked `localhost` or private LAN address. OpenAI, Gemini, and Anthropic use only the fixed official HTTPS endpoints. Credentials are encrypted in the desktop profile through Electron's secure operating-system store and are excluded from backups. External HTTP(S) links open in the default browser only after a click.

The auto-updater downloads the signed manifest and the packages over HTTPS from this project's GitHub releases. Linux and Windows have separate platform channels; the app accepts only the channel that matches the running system, and only GitHub addresses. The update manifest is also signed with Ed25519; the app contains only the public verification key. Package address, version, size, and SHA-256 value are part of the signature. Downloads resume after an interruption, are checked in full after they arrive, and are hashed again immediately before restart. A version older than the one already known is blocked. Under **Settings → Updates**, automatic checking, background download, and install-on-quit can be controlled separately. Vault sync stays on `fanotes.fasrv.ch`.

The shipped AppImage starts without an unsafe sandbox switch. On unusually hardened systems without unprivileged user namespaces, use the Pacman package instead of turning the Chromium sandbox off.

On Linux, FaNotes starts with Ozone X11 so pen and trackpad share the same seat. If `force_zero_scaling = true` is set in the Hyprland config or in a file included with `source =`, the app takes over device scaling itself: it reads the scale of the focused monitor through `hyprctl -j monitors` (1.25, 1.5, 2, …). `FANOTES_DEVICE_SCALE` overrides that. `GDK_SCALE` (times `GDK_DPI_SCALE`) is the fallback without `hyprctl`, otherwise 2. Without `force_zero_scaling`, Hyprland scales the XWayland window up, which looks soft on HiDPI monitors — the app notes that in the startup log. Vulkan and ANGLE-Vulkan experiments stay off on the native Wayland path; Chromium chooses the compatible GL/EGL path. An explicitly set graphics option is left untouched. Before the single-instance lock, the app also removes only Chromium startup symlinks that are demonstrably orphaned. An active process, or one that cannot be assigned safely, is never killed or unlocked.

Settings and the personal recognition model belong to the local Electron profile and therefore are not in the vault. On Linux the profile is typically under `~/.config/FaNotes/`, on Windows under `%APPDATA%\FaNotes\`. On the first start, FaNotes automatically takes over an existing earlier configuration and handwriting database without overwriting FaNotes data that is already present. For a complete backup, quit the app and save both the vault and the profile folder.

Under **Settings → Advanced → Reset app data**, the whole local profile can be cleared. That removes settings, personal handwriting training, browser data, caches, and update downloads, then restarts FaNotes. Markdown files, images, PDFs, handwriting pages, and drawings in the chosen vault are explicitly kept.

## Set up handwriting

Text recognition runs only in the desktop app for Windows and Linux. Pen strokes are grouped into lines, drawn as a fixed-height line image, and read locally by the `fanotes-ocr` sidecar. Grouping, rendering, and language-model decoding stay in the app. Web and Android do not run this recognition. Mathematics stays on the existing GlyphenWerk path.

1. Under **Settings → Experimental**, turn on **Handwriting to text**.
2. Press `Ctrl+D` on the same note page to switch to pen input and write freely on the A4 page.
3. Choose **Convert page** or **Convert region**. **Automatic** compares text and mathematics. **Text** and **Mathematics** remain available as a manual choice. The text language is under **Settings → Pen & recognition** (German or English).
4. Correct uncertain characters through their alternatives or directly in the correction field. On insert, FaNotes stores the confirmed line locally: the vocabulary grows immediately, a later unknown spelling within two letters takes the confirmed word, and from eight lines you can fit pen width, slant, and size under **Personal handwriting**. The fit scores the corrected reading, not only the decoder's raw text.
5. For a deeper model that still stays on this machine, export the training lines, build a personal model with `fanotes/scripts/ink-model/personalize.py`, and import `personal-model.onnx` together with `personal-model.json`. The same section turns on diagnostic lines in the developer console.

GlyphenWerk remains the path for personal mathematics characters and for text to handwriting:

1. In FaNotes, choose **GlyphenWerk** on the left or press `Ctrl+Shift+G`.
2. Under **Capture**, write enough samples for letters, digits, and symbols. For superscripts, subscripts, or the limits of integrals and sums, confirm the recognized spatial assignment in the mathematics test.
3. Under **Test recognition**, write complete equations or terms and correct uncertain results. Confirmed samples and layouts become active immediately for mathematics and text to handwriting. A ZIP export is only needed for backup or transfer. Ordinary sentences are read by the desktop ink recognizer above, not by GlyphenWerk.

For the reverse direction, in pen mode choose **Text → Handwriting**, paste text, and adjust the live preview. FaNotes picks a personal training template for each character, varies it in a controlled way, and connects suitable letters inside a word. Missing training characters and lack of space are shown before insert. The result stays ordinary pen ink, so it can be erased, extended, and undone.

To calculate in the same view, enable the **math solver** in the pen toolbar and double-tap a complete term or equation. FaNotes also recognizes spatially written fractions, roots, and indices, shows the recognized expression for review, and then offers simplify, solve, expand, factor, or evaluate. The output continues as editable ink using your personal training strokes. Under **Continuation** you can set the position. **Learned automatically** takes font size, line spacing, and the preferred arrangement from previous solutions.

To check your own working, choose **Math checker** and draw a frame around at least two steps written one under the other. FaNotes separates the lines spatially, keeps fractions and indices together, and checks each step locally with symbolic algebra. The first refuted step is marked in red. When only individual changed characters are responsible, the marker sits as close as possible to that spot. Lost or illegally added solutions mark the whole target line. Every recognized line stays editable in the review panel. Yellow means deliberately “not safely decidable” — for example ambiguous handwriting, a gap in the definition, or a transformation for which the local engine cannot give a complete proof.

GlyphenWerk and FaNotes still store in separate local IndexedDB databases. A validated internal bridge copies confirmed training data directly into the active FaNotes model. ZIP import remains available for existing datasets. It understands `manifest.jsonl`, `labels.json`, and, when present, `layout_examples.jsonl` from a GlyphenWerk export. Recognition quality depends on the variety, amount, and clean labeling of the samples. Recognized content therefore stays reviewable and correctable before it is inserted.

## Set up an AI provider

1. For a local provider, start LM Studio, Ollama, or OpenCode together with a model. For OpenAI, Gemini, or Anthropic, have an API key ready.
2. Open a Markdown file in FaNotes and press `Ctrl+Shift+A`.
3. Choose the provider at the top. FaNotes shows only the matching connection fields and loads that provider's models automatically. Local addresses are limited to `localhost` or private networks. Cloud providers use fixed official endpoints.
4. Mark one or more actions. For **Run a free instruction**, also write the concrete request.
5. Choose **Create preview** and check the result in the rendered view or the Markdown view.
6. Only when the result fits, choose **Apply result**. Only then is the open note changed and saved automatically.

The provider and model choice stay stored locally. Desktop credentials are encrypted. In FaNotes Web, cloud keys are forgotten when the AI area closes. The fact check uses only the capabilities of the chosen model, so time-dependent or uncertain statements still need to be checked. FaNotes disables every tool for OpenCode, so editing a note cannot run files, shell commands, or web access.

## Import worksheets

1. Open an existing note and choose **Worksheet** at the top, or press `Ctrl+Shift+I`.
2. Choose **Into the current note** or **As a new note**, then open a PDF, PNG, JPEG, WebP, or GIF file.
3. For keyboard input on the imported sheet, choose **Text field** and click the place you want. Fields and answers save automatically.
4. For handwritten answers, switch to **Pen** as usual. The shared pen layer covers Markdown and every imported page.

PDFs are rendered only locally. The original file, text fields, and pen strokes belong to the vault and should be backed up together.

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| Command palette | `Ctrl+P` |
| New note | `Ctrl+N` |
| Save | `Ctrl+S` |
| Search the vault | `Ctrl+Shift+F` |
| AI assistant | `Ctrl+Shift+A` |
| GlyphenWerk training and test | `Ctrl+Shift+G` |
| Image or PDF as a worksheet | `Ctrl+Shift+I` |
| Switch keyboard/pen | `Ctrl+D` |
| Focus mode | `Ctrl+Shift+E` |
| Bold / italic / link | `Ctrl+B` / `Ctrl+I` / `Ctrl+K` |
| Settings | `Ctrl+,` |
| Undo/redo drawing | `Ctrl+Z` / `Ctrl+Y` |

## Install on Windows and Arch Linux

For Windows 10/11 x64 there is a per-user installer and a single portable EXE. Both include every feature of the Linux build. The full steps, tablet notes, update information, and PowerShell checksum commands are in [packaging/INSTALL_WINDOWS.md](packaging/INSTALL_WINDOWS.md).

For Arch Linux there are three paths:

- **AppImage:** run it directly, without a system install
- **Portable tar.gz:** unpack it into any user folder
- **Pacman package:** package the portable archive locally as `.pkg.tar.zst` with the included `PKGBUILD`

The full steps, desktop integration, and tablet notes are in [packaging/INSTALL_ARCH.md](packaging/INSTALL_ARCH.md).

## Development

Node.js 22 or newer and npm are required.

### Shared recognition, matching runtime

FaNotes keeps line grouping, GlyphenWerk data, the text/mathematics decision, and the correction logic in the renderer. Text recognition itself exists only on the desktop:

- Windows and Linux render each line in `fanotes-recog` (WebAssembly) and run the FP32 line model in the native `fanotes-ocr` sidecar (`crates/fanotes-ort`, ONNX Runtime). Decoding with the character language model and the dictionary runs in WebAssembly again. The sidecar starts on demand and uses at most four threads. Two words written in capitals are joined when the pen trace has no space between them. Two pieces are also joined when one trace token is those letters plus at most one extra letter. A period becomes a closing quote when the pen drew that quote and the next character matches. A word-final letter becomes an apostrophe when that alternative is confident (`Soci` → `Soc'`). An `r` becomes `n` when that alternative is confident (`Perdyce` → `Pendyce`). A word-final `D` becomes `B` when that alternative is confident. On a word that is already mostly capitals, that `B` is written as its own letter (`JuDKIND` → `JuDKIN B`). A capital `F` becomes `f` when that alternative is confident (`Fifth` → `fifth`). An `a` becomes `ä` when that alternative is confident (`strasse` → `strässe`). When a different rendering is kept, one letter from a close upright reading is kept too if both spellings are dictionary words (`Marie` → `Marine`). A capital dictionary word then absorbs the following long lowercase unknown word (`Marine luftstreitkraft` → `Marineluftstreitkraft`). When a close reading has already added the plural e to an unknown word ending in kraft, that ending is spelled kräfte (`Marineluftstreitkräfte`). A slight back-slant is kept only when it rewrites exactly two neighboring words and scores higher. A slightly larger rendering replaces one dictionary word only when the new word is exactly one letter longer and nothing else changes (`Grad` → `Grund`). When the pen letters plus one extra letter spell several dictionary words, the character model keeps the one that is clearly more likely (`dauen` → `dauern`). After an article, a lowercase dictionary word with a noun ending is capitalized (`das mikrofon` → `Mikrofon`). An unknown word becomes the one dictionary spelling that adds an umlaut and changes one other letter (`entlauscht` → `enttäuscht`). A word with a capital after its first letter takes its one two-substitution dictionary neighbor and keeps the case of the unchanged letters (`EwtopEan` → `EuropEan`). A sentence adverb at the start of a line is capitalized (`manchmal` → `Manchmal`), and mid-sentence `Sein` becomes the verb `sein` unless an article precedes it. A word that is already almost all capitals loses its one lowercase letter (`JuDKINB` → `JUDKINB`). When a line still contains a word of ten or more letters that the dictionary does not know, the line is rendered again at nearby pen widths and at a slightly smaller size. A new reading is kept when that word becomes a dictionary word and every known word stays, when two words join into one longer word, or when one long unknown word is copied from the other rendering and every known word stays. A still smaller rendering is kept when it turns one unknown word into a dictionary word, or when every known word stays while a long word changes. When a line starts with a lowercase letter, that smaller rendering is also kept if the only change is capitalizing that letter. On a line of three-letter groups where one group is not a repeated letter, that smaller rendering is kept when its raw trace makes the odd group three copies of one letter (`TAF UUU` → `TTT UUU`). A dictionary word is replaced by the reading of its own strokes when that reading is a dictionary word exactly one letter longer (`Watched` → `Wretched`). Two narrow strokes read as 66 in front of a word that already ends with a closing quote become the opening quote (`66 Erdkunde"` → `"Erdkunde"`). A long unknown word is replaced by a separated stroke group's reading when that reading is two dictionary words (`Landschottensträsse` → `Landschaftsgeräte`). A three-letter word after the first word becomes lowercase when a close beam reading already has it lowercase (`Job` → `job`). On an English line, the first letter becomes lowercase when the best reading still starts with that capital, a close reading is the same line already lowercase, that lowercase letter is visible, and the word is in the dictionary (`Wretched` → `wretched`). A lone English `i` becomes `I` (`i know` → `I know`). A quote stuck to a closing parenthesis moves in front of the following lowercase word (`(Tanis 6a)" if` → `(Tanis 6a) "if`). A German number before a short run of capitals takes a period (`1 FC` → `1. FC`). A closing parenthesis with no opening one becomes a period before a capital (`genannt) Die` → `genannt. Die`). Two different quotation marks written against each other take a space (`'Garz'"Such` → `'Garz' "Such`). After `einen`, a long capital word takes `der` (`einen des Landschaftsgeräte` → `einen der`). An unknown word keeps the one final letter the raw trace added (`Chudley` → `Chudleyh`). When the raw trace is the chosen word plus one letter, and swapping one adjacent pair yields exactly one dictionary word, that word is kept (`in` with trace `ien` → `ein`). A confirmed personal word replaces a later unknown spelling within two letters (`Chudleyh` → `Chudleigh`). A period directly before a closing bracket becomes a comma when a slightly narrower rendering agrees on every other character. A long unknown word is also tried at a narrower width and kept when that reading scores much higher and every known word stays, apart from case. A close reading can change one letter of a long unknown word (`Kolbenningspannung` → `Kolbenringspannung`). After an adjective in `-ischen` or `-lichen`, an infinitive becomes the `-ung` noun when both are in the dictionary (`Erzeugen` → `Erzeugung`).
- Web and Android have no sidecar and do not run this recognition. Mathematics, GlyphenWerk, and text to handwriting stay available there.
- An optional personal model replaces only the text lines and lives in the local profile, not in the vault.

Every model file is checked against the size and SHA-256 checksum stored in the manifest before it is used. Rebuilding the line model is described in `fanotes/scripts/ink-model/README.md`. `npm run check:ink-recognition` checks the desktop pipeline on the golden lines.

```bash
cd fanotes
npm ci
npm run dev
```

Useful checks and builds:

```bash
npm run typecheck
npm run check:efficiency
npm run check:startup
npm run check:themes
npm run check:scribble-erase
npm run check:glyphenwerk
npm run check:ink-recognition
npm run check:math-corrector
npm run check:updater
npm run build
npm run dist:dir
npm run dist:windows
```

`dist:dir` produces the unpacked Linux build under `release/linux-unpacked`. The Arch-compatible portable archive contains a single top-level folder:

```text
FaNotes-2.50.1-x86_64/
├── fanotes
├── resources/
└── ...
```

A reproducibly sorted archive can be made from that with GNU tar:

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

## License

The application code is under the MIT license. Dependencies and embedded fonts keep their own licenses; see their package metadata in the npm lockfile.
