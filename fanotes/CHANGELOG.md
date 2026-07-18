# Änderungsverlauf

## 2026.7.4-beta.6

- Notizen lassen sich wieder zuverlässig über alle sichtbaren „Neue Notiz“-Aktionen erstellen; ein inzwischen gelöschter oder umbenannter Standardordner fällt sicher auf den Vault zurück, statt eine Fehlermeldung auszulösen
- Erstellen, Dateibaum aktualisieren und Editor öffnen sind getrennte Schritte: Ein späterer Darstellungsfehler löst keine zweite Dateierstellung mehr aus, und eine bereits angelegte Notiz bleibt direkt erreichbar
- Desktop-IPC und Browser-Vault normalisieren fehlende optionale Argumente gleich; unvollständige Dateien werden bei einem Schreibfehler geschlossen und entfernt, während eindeutige Dateinamen erhalten bleiben
- der Quellordner, die Browser-Schnittstelle, IPC-Kanäle, Trainingskennungen und internen Vaultpfade tragen jetzt durchgehend den Namen FaNotes; bestehende Vault- und Handschrift-Trainingsdaten werden automatisch, atomar und ohne Datenverlust übernommen
- ein neuer echter Electron-Regressionstest prüft die sichtbare Notizerstellung, fehlende Standardordner, leere IPC-Argumente und die Vaultmigration; der Web-End-to-End-Test betätigt ebenfalls den sichtbaren Button und verhindert doppelte Notizen
- das Startdokument enthält kein durch die Desktop-Sicherheitsrichtlinie blockiertes Inline-Skript mehr; Sprach- und Manifestwahl laufen über das gebündelte Startmodul, ohne CSP-Rendererfehler zu erzeugen

## 2026.7.4-beta.5

- Grunderkennung und persönliche GlyphenWerk-Daten bleiben jetzt als zwei unabhängige Evidenzquellen erhalten, selbst wenn für eine Zeichenklasse bereits eigene Beispiele existieren; FaNotes kann dadurch echte Zustimmung von einem Konflikt unterscheiden, statt das Grundmodell nach dem ersten Training vollständig auszublenden
- ein einzelnes widersprüchliches Trainingsbeispiel überschreibt keine sehr sichere Grund- oder Zeilenentscheidung mehr; stimmen Grundform und persönliche Form überein, kann bereits ein nahes Beispiel helfen, während mehrere wiederholt passende Beispiele weiterhin einen tatsächlich individuellen Schreibstil zuverlässig erlernen und gegenüber der Standardform durchsetzen
- Zeichen-, Wort-, Satz- und Segmentierungsentscheidungen verwenden dieselbe kalibrierte Konfliktlogik: schwaches Fehltraining zählt weder als Buchstabenstütze noch als Schutz einer falschen Ganzzeichen-Hypothese, wiederholte nahe Beispiele behalten dagegen ihre höhere persönliche Autorität
- Sprachkorrekturen, Zeichenhinweise und der persönliche Raster-Fallback übernehmen Basis- und Trainingswerte ausschließlich vom tatsächlich gewählten Zeichen; verworfene Buchstaben können ihre Beispielanzahl oder Konfidenz nicht länger an ein später ausgewähltes Zeichen vererben
- drei über die gebündelten Schreibstile verteilte Basisreferenzen pro trainierter Klasse halten die zusätzliche Prüfung kompakt; Typprüfung, sichtbarer GlyphenWerk-Pfad, reale IAM-OnDB-Zeile, verbundene Mehrzeilenschrift sowie 1.001 persönliche Text- und 216 Mathematikbeispiele bestehen unter festen RAM-, CPU- und Null-Swap-Limits

## 2026.7.4-beta.4

- die allgemeine Texterkennung trennt jetzt visuelle Sicherheit von Sprachkontext: eine unbekannte, aber sauber geschriebene Wortform gilt nicht länger als geometrisch fehlerhaft; dadurch bleiben insbesondere Eigennamen wie `Fabio` und bewusst gemischte Fach- oder Produktnamen wie `OpenCode` erhalten, während Satzkontext weiterhin echte Lesefehler korrigiert
- das kompakte Zeichenmodell und das kontextuelle Zeilenmodell werden über Struktur, Konfidenz, Wörterbuchbeleg und tatsächlichen Zeichenabstand gemeinsam ausgewählt; der Webpfad behält seine starke Kontextpriorität für normale Sätze, schützt aber visuell sichere einzelne Namen und Fachbegriffe vor radikalen Ersetzungen
- erfundene Abstände innerhalb eines Wortes werden mehrstufig und konservativ entfernt, wenn nur die verbundene Form ein bekanntes deutsches oder englisches Wort ergibt; echte Grenzen zwischen zwei gültigen Wörtern wie `in form` bleiben unangetastet
- bekannte Wörter mit versehentlichen internen Grossbuchstaben werden anhand ihrer ursprünglichen Anfangsform normalisiert, ohne Grossschreibung, Abkürzungen oder unbekannte CamelCase-Namen zu zerstören; die abschliessende Korrektur verbindet diese Fallprüfung mit dem gemeinsamen persönlichen Wörterbuch
- separat gesetzte Punkte sind nun eigenständige geometrische Evidenz: ein oberer Punkt unterscheidet `i`/`j` von `l`/`I`/`1`, zwei obere Punkte stützen deutsche Umlaute gegenüber ihrem Grundbuchstaben, auch wenn der Punkt oder Umlaut erst nach dem Wortkörper geschrieben wurde
- bei einem unsicheren einzelnen Wort prüft das CTC-Modell genau eine zweite, leicht anders skalierte Darstellung und übernimmt sie nur bei klar besserer Struktur oder Bewertung; sichere Wörter und ganze Sätze erhalten keine zusätzliche Inferenzlast
- die reale IAM-OnDB-Zeile bleibt mit 11,54 Prozent Zeichenfehlerrate deutlich unter der festgelegten 24-Prozent-Grenze; kontrollierte Wörter, zwei physische Zeilen, Namens-/CamelCase-Schutz, Kontextkorrektur, Text-/Mathematikkonflikte und die sichtbare GlyphenWerk-Erkennung werden zusätzlich als End-to-End-Regression geprüft

## 2026.7.4-beta.3

- FaNotes und das eingebettete GlyphenWerk verwenden jetzt dieselbe Text-/Mathematikentscheidung für die geometrische Basiserkennung, die neuronale Zeile und persönliche Trainingsbelege; widersprüchliche Teilentscheidungen zwischen Test-Tab, Notizseite und unsichtbarem Suchtranskript sind damit entfernt
- Text wird als vollständige Zeile statt als Folge isolierter Symbolstimmen bewertet: Buchstabenanteil, echte Wörter, Wortabstände, gemeinsame Grundlinie, mehrere physische Zeilen und eingemischte Zahlen stützen normale deutsche und englische Sätze, während bloss vorhandener Leerraum nicht mehr pauschal als Textbeleg zählt
- Brüche, Wurzeln, Gleichheits- und Relationszeichen, Hoch-/Tiefstellungen, Integrale, Summen und Produkte mit Grenzen sowie mehrzeilige Gleichungen erhalten explizite harte Strukturevidenz; eine plausible OCR-Textzeile darf diese mathematischen Anordnungen auch bei knappem Scoreabstand nicht überschreiben
- gekreuzte Plus-Striche und zwei parallele Gleichheitsstriche werden zwischen getrennten Operanden zusätzlich direkt aus der ursprünglichen Stiftgeometrie rekonstruiert; dadurch bleiben unter anderem `a + c` und `m = n` Mathematik, selbst wenn die erste Einzelglyphenliste den mittleren Operator nur als `l`, `e` oder `o` führt
- die erweiterte End-to-End-Matrix prüft Text in Deutsch und Englisch, Text mit Zahlen, mehrere Textzeilen, einzelne Ziffern, vier Grundoperatoren, Variablenformeln, Wurzeln, Brüche, Einzel-/Doppel-/Dreifachintegrale, Summen, Produkte, Grenzen, Indizes und mehrere Gleichungszeilen; Typprüfung, gemeinsame Konfliktregression und der sichtbare GlyphenWerk-Browserpfad bestehen mit 0 Byte Swap

## 2026.7.4-beta.2

- die Zwei-Buchstaben-Segmentierung behandelt den durchgehenden Hauptzug und später gesetzte Punkte, Querstriche, Diagonalen oder zweite Stämme getrennt: nur der echte Schreibkörper wird räumlich geteilt, während jeder abgesetzte Originalstrich vollständig einem der beiden Buchstaben gehört
- eine begrenzte Besitzer-Suche kombiniert räumliche Nähe, Strichanteil, lokale Anheftung und die tatsächliche Stiftreihenfolge; dadurch bleiben unter anderem `fF`, `Jt`, `Ij`, `kK`, `kN` und `x1` trennbar, ohne Teile des Nachbarbuchstabens zu stehlen oder einen Punkt beziehungsweise Balken zu zerschneiden
- Lücken zwischen später gesetzten Strichen und Übergänge im durchgehenden Schreibpfad werden vor allgemeinen Rastertälern geprüft; eine schmale interne Lücke in einem mehrstrichigen `k`, `K` oder `H` gilt nicht länger vorschnell als endgültige Buchstabengrenze, eindeutige normal breite Leerräume behalten jedoch den schnellen Pfad
- ein geometrisch eindeutig an einen Stamm gebundener, außergewöhnlich breiter `T`-Querstrich kann keiner Folgebuchstaben-Hypothese mehr zugeordnet werden; kurze tatsächlich mehrdeutige `f`-/`F`-Balken bleiben weiterhin durch persönliche Trainingsdaten entscheidbar
- die verpflichtende 60-Schreibenden-Regression erreicht für 3.720 Einzelzeichen, 33.480 getrennte Paare und 11.160 vollständig verbundene Paare jeweils 100 Prozent Pfad-, Vollständigkeits- und Besitzerkorrektheit; der produktive Browserpfad, 1.001 persönliche Textbeispiele und acht getrennte NAS-Holdouts mit 0 von 71 Zeichenfehlern bleiben grün

## 2026.7.4-beta.1

- der persönliche Rasterpfad kann innerhalb einer einzigen vollständig verbundenen Tintenkomponente jetzt bis zu 16 Buchstaben bilden; zuvor waren unabhängig von Wortlänge höchstens zwei Teile möglich, wodurch eng verbundene Schreibschrift trotz passender Einzelbuchstaben nicht vollständig gelesen werden konnte
- eine begrenzte Links-nach-rechts-Suche kombiniert niedrige Tintendichte, gleichmässige Ersatzgrenzen und die persönlichen GlyphenWerk-Prototypen; dadurch bleiben Anschlussstriche durchgängig sichtbar, ohne selbst als Buchstabe zu erscheinen oder Teile des Nachbarzeichens zu stehlen
- der bereits geprüfte Pfad für genau zwei berührende Buchstaben bleibt unverändert und wird getrennt von der neuen Mehrfachsegmentierung bewertet; leicht berührende Paare erhalten dadurch weiterhin ihre flexiblen natürlichen Zeichenbreiten
- die produktive Fusionsschranke akzeptiert die etwas höhere Rasterdistanz echter verbundener Schrift nur bei exakter Zeichenanzahl, bekanntem Wort, mindestens 75 Prozent visuell gestützten Zeichen, niedrigen persönlichen Durchschnittskosten und unverändert strenger Schnitt-Tintenbegrenzung
- eine neue Browserregression erzeugt `test` als eine einzige lückenlose Rasterkomponente, gibt absichtlich `tesl` als Zeilenmodellhinweis vor und prüft sowohl `test` als sichtbares persönliches Ergebnis als auch den tatsächlich akzeptierten produktiven Sicherheitsentscheid; die acht unabhängigen NAS-Bilder bleiben bei 0 von 71 Zeichenfehlern

## 2026.7.3

- der eingebettete GlyphenWerk-Test verwirft ein persönlich erkanntes Textzeichen oder Wort nicht länger, nur weil die allgemeine Zeilenerkennung dieselbe Tinte zuvor fälschlich als Integral, Doppelintegral oder anderes Mathematikzeichen eingeordnet hat
- die echte Frame-Brücke überträgt die fortlaufend gemessene Zeichenanzahl und einen vorhandenen stabilen Buchstabenhinweis an die persönliche Erkennung; dadurch bleibt eine bereits bestätigte Folge wie `t → te → tes → test` erhalten, wenn ein neu angefügter Buchstabe die Basiserkennung vorübergehend in den Mathematikmodus kippen lässt
- die persönliche Textfusion behandelt explizite Mathematikausgaben der OCR nicht länger als Text-Veto und kann für geeignete Einwortzeilen auf den bereits visuell gestützten Textkandidaten zurückfallen; reine neuronale oder untrainierte Vermutungen erhalten dieses zusätzliche Vertrauen ausdrücklich nicht
- ein neuer sichtbarer Chromium-Test zeichnet im echten eingebetteten GlyphenWerk-Canvas ein zweistrichiges `T`, führt das Ergebnis durch die reale `postMessage`-Brücke und prüft die tatsächlich gerenderte Textansicht; eine zweite Regression reproduziert `∫∫ → test` mit persönlichen verbundenen `t/e/s`-Formen
- die acht NAS-PNGs bleiben ein begrenzter direkter Raster-Modultest und gelten nicht mehr als End-to-End-Nachweis für den Live-Test; Stable 2026.7.3 wird stattdessen durch den produktiven Fusionspfad, die sichtbare Oberfläche, Typprüfung sowie Kontext- und Brückentests abgesichert

## 2026.7.2

- Stable- und Beta-Versionen folgen jetzt einem strikt aufsteigenden Zyklus: nach Stable `2026.7.2` beginnen Vorabversionen bei `2026.7.3-beta.1`, sodass eine Stable-Installation beim Wechsel in den Beta-Kanal niemals an einer semantisch älteren Vorabversion hängen bleibt
- der produktive persönliche Rasterpfad segmentiert eine handgeschriebene Zeile gemeinsam nach vollständigen Buchstabenkörpern, variablen Schnittpositionen, sichtbarer Tinte, persönlichen GlyphenWerk-Prototypen und deutschem beziehungsweise englischem Wortkontext; dadurch werden zwei Nachbarbuchstaben nicht länger als ein breites Zeichen zusammengezogen
- eine sichere Fusionsschranke übernimmt den persönlichen Rasterkandidaten nur bei enger visueller Übereinstimmung, passender Wortstruktur und höchstens drei Änderungen gegenüber dem allgemeinen Zeilenmodell; Modellvorhersagen werden weiterhin niemals automatisch als Trainingsdaten gespeichert
- der isolierte NAS-Holdout erkennt `Aufenthalt`, `Auftragsquote`, `Glykose`, `Leistung`, `Mappe`, `Prozessor`, `Rendevous` und `Zertifikat` mit 0 von 71 Zeichenfehlern; als Training dient ausschließlich der separate GlyphenWerk-Export, während alle acht PNG-Dateien nur einmalig und mit undurchsichtigen IDs ausgewertet werden
- die deutsch-englische Kontextsuche sortiert Wortlisten jetzt in exakt derselben Codepunktreihenfolge wie ihre Binärsuche; Wörter vor und nach Umlauten bleiben dadurch auffindbar und können die visuelle Erkennung zuverlässig absichern
- der neue Rasterpfad lädt erst bei einer tatsächlich geeigneten persönlichen Einwortzeile, begrenzt die Anzahl zwischengespeicherter Prototypen und verwendet vorallokierte Distanzberechnungen; normale Tastatur-, Mathematik- und untrainierte Erkennungspfade erhalten dadurch keine zusätzliche Startlast
- die ressourcenbegrenzten Regressionen bestehen mit 0 Byte Swap: verbundene Text- und Mathematikerkennung, 1.217 personalisierte Holdouts, echte IAM-OnDB-Handschrift, Wurzeln, Brüche, Mathe-Löser, Mathe-Korrigierer, signierte Delta-Updates und die Stable-Release-Policy bleiben grün

## 2026.7.1

- der erste Stable-Release mit Kalender-Versionierung bündelt die vollständig geprüften Beta-1- und Beta-2-Änderungen; bestehende Installationen auf `2.50.3` erhalten dadurch zuerst die neue Stable-/Beta-Kanalwahl und können anschließend in den Einstellungen zuverlässig zwischen beiden Kanälen wechseln
- Stable und Beta verwenden getrennte signierte Manifeste, Downloads und differentielle Updatepfade; ein Kanalwechsel verwirft fremde vorgeladene Pakete, erzwingt niemals ein Downgrade und behält Ed25519-Signatur, SHA-256, exakte Delta-Basis, Range-Fortsetzung, atomaren Wechsel und Rollback-Schutz bei
- die Segmentierungsengine bewertet verbundene Handschrift als Sequenz vollständiger Buchstabenkörper: berührende oder durch Anschlussstriche verbundene Buchstaben bleiben getrennt, und ein Buchstabe darf keine Teilstriche seines rechten Nachbarn mehr übernehmen
- Punkte, Querstriche und nachträglich gesetzte Anschlussstriche werden anhand von Position, Grösse, zeitlicher Stiftreihenfolge und Körpernähe zugeordnet; der obere Strich eines `T` bleibt beim Stamm, während ein rechts abgesetzter Anschlussstrich nicht als zusätzlicher Buchstabe erscheint
- wiederholt trainierte breite oder mehrstrichige Einzelzeichen behalten eine starke Ganzzeichen-Hypothese und werden weder in scheinbare Wörter aufgeteilt noch zu Integralen umgedeutet; persönliche GlyphenWerk-Daten erhalten dabei mehr Gewicht, ohne sichere visuelle Evidenz des allgemeinen Modells zu verdrängen
- das lokale Zeilenmodell, persönliche Prototypen, unabhängig gemessene Zeichenanzahl, Abstände sowie deutsche und englische Wortfolgen werden gemeinsam bewertet; Gross-/Kleinschreibung, unbekannte Eigennamen, kurze gültige Wörter und mehrere physische Schreibzeilen bleiben geschützt
- der optimierte persönliche Erkennungspfad vermeidet unnötige Längenhypothesen und kurzlebige Distanzdaten; die geprüften realen UJI-Wörter benötigen typischerweise rund 1,5 bis 2,7 Sekunden statt 3,8 bis 10,4 Sekunden bei identischer Ausgabe
- die begrenzten Regressionen bestehen mit 0 Byte Swap: 128 persönliche Holdouts erreichen 128/128 Treffer, der 60-Schreibenden-Audit hält für 3.720 Einzelzeichen sowie 44.640 getrennte und vollständig verbundene Paare den korrekten Segmentierungspfad bereit, und Text, Mathematik, Mehrzeiligkeit, Wurzeln, Brüche, Indizes sowie Integrationsgrenzen bleiben grün
- Linux, Windows und die Web-App verwenden denselben Erkennungs-, Korrektur- und Trainingskern; die deutsche und englische Oberfläche einschließlich Beta-Versionsstatus, GlyphenWerk, PWA, Backup und Offline-Neustart wurde vor der Stable-Freigabe erneut vollständig geprüft

## 2026.7.1-beta.2

- die Segmentierungsengine bewertet verbundene Handschrift jetzt als Sequenz vollständiger Buchstabenkörper statt über überlappende Begrenzungsrahmen allein; zwei berührende oder über einen Anschlussstrich verbundene Buchstaben bleiben dadurch getrennt, und der vorherige Buchstabe darf keine Teile seines Nachbarn mehr übernehmen
- Punkte, Querstriche und nachträglich gesetzte Anschlussstriche werden über Position, Grösse, zeitliche Stiftreihenfolge und Körpernähe ihrem tatsächlichen Buchstaben zugeordnet; insbesondere bleibt der obere Strich eines `T` vollständig beim Stamm, während ein rechts abgesetzter Anschlussstrich nicht als zusätzlicher Buchstabe erscheint
- wiederholt trainierte breite oder mehrstrichige Einzelzeichen behalten nun eine starke Ganzzeichen-Hypothese: ein korrekt angelerntes `T`, `d` oder `n` wird weder in mehrere scheinbare Buchstaben zerlegt noch durch einen zufälligen Wörterbuchbonus zu einem Integral- oder Wortfragment umgedeutet
- persönliche GlyphenWerk-Prototypen, das lokale Zeilenmodell, die unabhängig gemessene Zeichenanzahl, echte Abstände sowie deutsche und englische Wortfolgen werden gemeinsam bewertet; sichere Gesamtwörter bleiben erhalten, während visuell gestützte persönliche Folgen fehlerhafte neuronale Wörter korrigieren können
- Gross- und Kleinschreibung sowie unbekannte Eigennamen werden stärker durch die tatsächliche Zeichenform geschützt; eine Sprachkorrektur darf nur innerhalb eines eng begrenzten visuellen Verlusts eingreifen und verändert kurze gültige Wörter oder Namen nicht aufgrund eines bloss häufigeren Wörterbuchtreffers
- mehrere physische Schreibzeilen werden anhand ihrer Tintenlage rekonstruiert, auch wenn ein Erkennungsanbieter flache Tokenmetadaten liefert; Zeilenumbrüche bleiben durch persönliche Segmentierung, Wortkontext und sichtbare Ausgabe erhalten, ohne lange normale Wörter als mathematische Trennstriche an die nächste Zeile zu hängen
- der persönliche Erkennungspfad vermeidet unnötige Längenhypothesen bei bereits sicheren bekannten Wörtern und verwendet vorallokierte numerische Distanzberechnungen statt kurzlebiger Maps und Sortierungen; die geprüften realen UJI-Wörter benötigen dadurch typischerweise rund 1,5 bis 2,7 Sekunden statt 3,8 bis 10,4 Sekunden bei identischer Ausgabe
- die ressourcenbegrenzten Regressionen bestehen mit 0 Byte Swap: 128 persönliche Holdouts erreichen im kontrollierten 39-Klassen-Audit 128/128 Treffer, der 60-Schreibenden-Paaraudit hält für 3.720 Einzelzeichen sowie 44.640 getrennte und vollständig verbundene Paare den korrekten Segmentierungspfad bereit, und die End-to-End-Prüfung umfasst Text, Mathematik, Mehrzeiligkeit, Wurzeln, Brüche, Indizes und Integrationsgrenzen

## 2026.7.1-beta.1

- FaNotes besitzt jetzt getrennte Stable- und Beta-Updatekanäle: Stable bündelt gründlich geprüfte Änderungen in zwei bis höchstens vier Veröffentlichungen pro Monat, während Beta einzelne Neuerungen früher als klar gekennzeichnete Vorabversion ausliefert
- der gewünschte Kanal lässt sich direkt unter Einstellungen → Updates wechseln; Kanalwechsel verwerfen fremde bereits vorgeladene Pakete, führen niemals ein erzwungenes Downgrade aus und bevorzugen automatisch den nächsten neueren Stable-Stand
- Linux- und Windows-Manifeste, Vollpakete und differentielle Updates verwenden kanalgebundene, separat validierte Pfade; Ed25519-Signatur, SHA-256, Delta-Basis, Range-Fortsetzung, atomarer Wechsel und Rollback-Schutz bleiben vollständig erhalten
- die neue Kalender-Versionierung verwendet Stable-Namen wie `2026.7.1` und Beta-Namen wie `2026.7.2-beta.1`; eine reproduzierbare Release-Richtlinie verhindert mehr als vier Stable-Ausgaben pro Monat und prüft fortlaufende Beta-Nummern gegen GitHub
- alle 62 bisherigen Versionen von 1.0.0 bis 2.50.3 sind als zweisprachige GitHub-Releases veröffentlicht; vorhandene Linux- und Windows-Pakete tragen eigene SHA-256-Dateien, und künftige Releases müssen vor der Serverfreigabe vollständig mit Installern, ASAR-Dateien, Deltas, Dokumentation und Lizenzen auf GitHub liegen
- das GitHub-Repository erhält eine vollständig neue zweisprachige README mit Produktüberblick, Bildern, Funktionen, Datenschutz, Entwicklung, Projektstruktur, Downloadwegen und der Stable-/Beta-Richtlinie

## 2.50.3

- die Zwei-Buchstaben-Segmentierung verwendet nun die echte zeitliche Stiftreihenfolge und hält vollständige Züge zusammen; dadurch bleiben schmale, überlappende oder nahezu deckungsgleiche Nachbarzeichen getrennt, ohne einen einzelnen mehrstrichigen Buchstaben künstlich aufzuteilen
- nur der tatsächliche Zubehörzug darf beim Schneiden eines Wortes als unteilbarer Punkt oder Querstrich geschützt werden; ein Buchstabenkörper kann deshalb nicht mehr vom Querstrich seines linken Nachbarn gestohlen werden, während der breite obere Strich eines `T` vollständig beim Stamm bleibt
- hoch oder seitlich gesetzte i-/j-Punkte, zweizügige `w` sowie aus zwei Stämmen und einem mittleren Querstrich gebildete `H` werden als jeweils ein Zeichen behandelt; Zubehörgröße, relative Körperhöhe, Position, Form und reale Stiftzeit verhindern zugleich falsche Zusammenführungen
- der vollständige UJI-Pen-Characters-v2-Audit prüft 3.720 echte Einzelzeichen und 33.480 echte Buchstabenpaare von 60 Schreibenden bei 4 Pixel Überlappung, direkter Berührung und 1 Pixel Abstand: Einzelzeichensicherheit und verfügbarer Zwei-Zeichen-Pfad erreichen in diesem begrenzten Datensatz jeweils 100 Prozent
- neue End-to-End-Regressionen sichern `t → te → tes → test`, enge `te`-/`st`-Paare und ein breites `T` direkt vor `e` punktgenau ab; Wurzel, Bruch, Indizes, echte Doppel-/Dreifachintegrale, 1.001 persönliche Text- und 216 Mathematikbeispiele bleiben grün, alle ressourcenbegrenzten Prüfungen liefen mit 0 Byte Swap

## 2.50.2

- visuell klar geschriebene, unbekannte Eigennamen mit Grossbuchstaben am Anfang bleiben erhalten: die gemeinsame GlyphenWerk-/FaNotes-Fusion darf `Fabio` nicht mehr durch einen mehrfach abweichenden Wörterbuch- oder Kontextvorschlag wie `taboo` ersetzen; dieselbe Absicherung gilt auf Deutsch und Englisch, während eindeutige Korrekturen mit nur einem falschen Buchstaben weiterhin möglich sind
- nahe nacheinander geschriebene Buchstaben werden zusätzlich über ihre voneinander getrennten vollständigen Stiftkörper segmentiert; dadurch bleiben etwa `te` und `st` zwei Zeichen, auch wenn der normale Abstandsschätzer sie bisher zu einem breiten Einzelzeichen zusammengezogen hat
- Punkte, Querstriche und abgesetzte Anschlussstriche werden dem passenden Buchstabenkörper zugeordnet, statt als eigener Buchstabe zu erscheinen; echte eng stehende Integralstriche erfüllen die neuen Textkriterien nicht und bleiben deshalb Doppelintegrale
- Wacom-Stifteingabe erfasst nur den primären Stiftkontakt, während Touch- und Trackpad-Gesten weiterhin der Seitennavigation gehören; verlorene Pointer-Captures und ein Fensterwechsel räumen den Zeichenzustand zuverlässig auf, sodass das Trackpad nach dem Zeichnen sofort weiter scrollt
- neue Regressionen reproduzieren `Fabio` gegen den neuronalen Vorschlag `taboo`, nahe Zweibuchstabenfolgen, ein unverändertes echtes Doppelintegral sowie Stiftzeichnen mit anschließendem Trackpad-Scrollen im realen Chromium; sämtliche ressourcenbegrenzten Prüfungen liefen mit 0 Byte Swap

## 2.50.1

- die Live-Erkennung behält bei einer append-only geschriebenen Buchstabenfolge die bereits stabilen Buchstaben und ihre unabhängig gemessene Zeichenanzahl bei; ein neu angefügter Buchstabe kann das gesamte Wort deshalb nicht mehr vorübergehend zu `∞`, `∬` oder einem anderen einzelnen Mathematiksymbol zusammenziehen
- mehrstrichige Buchstaben werden bis zu ihrer fertigen Form aus allen seit der letzten Wortposition hinzugekommenen Strichen neu erkannt, statt einen unfertigen ersten Teilstrich festzuschreiben; nach einem kurzzeitigen Mathematikmodus kann derselbe Wortanfang beim nächsten Strich wieder sicher in den Textmodus zurückkehren
- die Text-Hysterese greift ausschließlich bei einer geometrisch passenden Folge aus mindestens zwei Buchstaben und lernt daraus nicht automatisch; Gleichungen, Operatoren, Brüche, Relationen, Integrationsgrenzen und echte Doppel- beziehungsweise Dreifachintegrale behalten ihre mathematische Entscheidung
- mehrdeutige Wörterbuchreparaturen verändern ein unbekanntes Wort nicht mehr, wenn zwei gleich nahe sinnvolle Kandidaten ohne visuelle Zeichenevidenz praktisch gleichauf liegen; die gemessene Fusion verschlechtert dadurch den begrenzten realen UJI-Satztest nicht länger gegenüber der neuronalen Zeile
- neue Regressionen prüfen die wachsende Folge `t`, `te`, `tes`, `test`, die Rückkehr aus einem vorherigen Mathematikmodus sowie den unveränderten Erhalt eines echten Doppelintegrals; alle ressourcenbegrenzten Prüfungen liefen mit 0 Byte Swap

## 2.50.0

- die Web-App lädt für die allgemeine Zeilenerkennung nur noch das dynamisch quantisierte 5,49-MB-Q8-CTC-Modell und ein vollständig Q8-quantisiertes 63,4-MB-Kontextmodell über ONNX Runtime WASM; maximal zwei OCR-Threads, verzögertes Laden und die einstellbare Freigabezeit begrenzen CPU- und RAM-Spitzen
- Linux und Windows führen das 21,3-MB-FP32-Zeilenmodell über eine schlanke native ONNX-Runtime in einem separaten Worker aus; die CPU-Laufzeit verwendet optimierte SIMD-Pfade auf Intel einschließlich Core Ultra sowie kompatiblen AMD-Systemen, ist auf vier Threads begrenzt und wird beim App-Start nicht geladen
- in den Einstellungen kann zwischen dem kompakten nativen Zeilenmodell und der erweiterten Erkennung mit zusätzlichem Kontextmodell gewählt werden; OCR-Kerne, Modellhaltezeit, parallele Hintergrundaufgaben und das RAM-Limit pro Renderer sind ebenfalls einstellbar
- Web, Linux und Windows verwenden trotz verschiedener Laufzeiten unverändert dieselbe Zeilen- und Wortsegmentierung, persönlichen GlyphenWerk-Trainingsdaten, Text-/Mathematikentscheidung, Korrekturhistorie und deutsch-englische Wortprüfung
- Modellmanifeste binden jede Q8- und FP32-Datei an Größe und SHA-256-Prüfsumme; Desktop-Pakete enthalten weder die Web-Q8-Modelle noch CUDA-, TensorRT- oder DirectML-Ballast, während die native Runtime bei Beschädigung sicher auf den verifizierten WASM-Pfad zurückfällt
- die realen Laufzeittests bestehen mit 0 Byte Swap: der native Zwei-Thread-Worker benötigt rund 85 MB Peak-RAM, der vollständige Chromium-Q8-Test bleibt einschließlich Browser unter 1,3 GB und erkennt die kontrollierten verbundenen Wörter sowie Mehrzeiligkeit exakt

## 2.49.0

- die gemeinsame Textfusion verwendet die unabhängig gemessene Zeichenanzahl jetzt auch für lange neuronale Wörter, kontrolliert zusammengezogene Wortfragmente und gleicht sie mit persönlichen Formen sowie einem sicheren deutsch-englischen Alltagswortschatz ab
- verbundene Buchstaben, abgesetzte Anschlussstriche und einzelne schwache Trennungen werden gemeinsam bewertet; vollständige visuell belegte persönliche Zeichenfolgen können ein falsches neuronales Wort ersetzen, während schwache Einmal-Trainingsdaten ein korrektes Gesamtwort nicht mehr verdrängen
- Wörterbuchreparaturen benötigen nun eindeutige Form-, Positions- und Abstandsevidenz und werden verworfen, sobald ein näherer sinnvoller Kandidat existiert; dadurch bleiben unbekannte Wörter erhalten und riskante Kontext-Halluzinationen werden verhindert
- tiefere Segmentierungsvarianten werden nur noch bei unbekannten neuronalen Wörtern mit grosser Abweichung zwischen gemessener und erkannter Zeichenanzahl berechnet; normale Zeilen behalten den schnellen einzelnen Segmentierungslauf
- der gemeinsame Wortschatz enthält zusätzliche häufige Begriffe aus Dokumenten, Schule, Studium und Mathematik, darunter `Datei`, `Papier`, `Abstand`, `Tabelle`, `Rechnen`, `Grenze`, `Funktion`, `Informatik`, `Physik`, `Chemie`, `Biologie`, `Wirtschaft`, `Aufgabe`, `Summe`, `Korrektur`, `Modell` und `Zeichnen`
- der reproduzierbare UJI-Audit prüft nun 60 unabhängige Schreibende auf 180 neuen Wörtern mit insgesamt 1.200 Zeichen: In diesem begrenzten Testsatz sinken 250 Zeichenfehler des reinen neuronalen Pfads nach sicherer persönlicher Fusion auf null, ohne Trainings- und Testsession zu vermischen
- die Regressionen sichern zusätzlich Gross- und Kleinschreibung, verbundene i-Punkte, echte sowie falsche Abstände, Mehrzeiligkeit, Korrekturen, Text-gegen-Mathematik-Modus, Integrale, Grenzen, Brüche und Wurzeln ab

## 2.48.0

- die persönliche Textfusion kombiniert das lokale Zeilenmodell, echte Stiftabstände, gemessene Zeichenanzahl und GlyphenWerk-Prototypen nun in einer gemeinsamen Kandidatenbewertung; eine plausible neuronale Wortform kann schwache persönliche Stellen ergänzen, ohne eine vollständige visuell belegte Folge pauschal zu überschreiben
- getrennte Tintengruppen einer verbundenen Zeile erhalten eine globale Zeichenverteilung: ein breiter Sechs-Zeichen-Körper mit zwei abgesetzten Zeichen wird bei einer Acht-Zeichen-Messung als `6+1+1` verarbeitet statt fälschlich als zehn Zeichen
- ein explizit längengeführter Segmentierungskandidat hält seine zugesagte Zeichenanzahl jetzt garantiert ein; der unbeschränkte Pfad läuft weiterhin parallel und schützt damit Eingaben, bei denen die unabhängige Strichmessung ungenau ist
- vollständige deutsche und englische Wörterbuchkandidaten werden erst bei einer tatsächlichen Erkennung geladen, schützen bereits korrekte Gesamtwörter vor verkürzenden Kontextkorrekturen und reparieren unbekannte Folgen nur bei ausreichend eindeutiger visueller Evidenz
- schwache Trennstriche und scheinbare Abstände innerhalb eines neuronalen Einzelwortes werden bei exakt passender gemessener Zeichenanzahl kontrolliert zusammengeführt; echte Wortgrenzen, Unterstriche, Bindestriche und mehrzeilige Eingaben bleiben räumlich erhalten
- ein korrektes neuronales Wörterbuchwort mit passender unabhängiger Zeichenanzahl darf nicht mehr durch eine zu kurze Einmal-Segmentierung ersetzt werden; wiederholt stark trainierte persönliche Formen behalten ihren eigenen Vorrang
- im reproduzierbaren UJI-Pen-Characters-v2-Audit mit 60 unabhängigen Schreibenden, 50 Einwortzeilen und 400 Zeichen sinkt die Zeichenfehlerrate der persönlichen Fusion in diesem begrenzten Testsatz von 23,75 Prozent beim reinen Zeilenmodell auf 0,00 Prozent; alle 95 neuronalen Zeichenfehler werden dort visuell und sprachlich aufgelöst
- die grosse verbundene Regression bleibt vollständig grün: 13 untrainierte Buchstaben, fünf verbundene Wörter, 18 Ziffern und Mathematiksymbole, Wurzel, Bruch, 1.001 persönliche Text- sowie 216 persönliche Mathematikbeispiele einschließlich mehrzeiliger Formeln, Integrale und Grenzen
- Schweizer Orthografie bleibt die einzige deutsche Erkennungsschreibweise: `ß` und `ẞ` sind weder Katalog- noch Trainingsklassen und erscheinen nicht in Erkennungsausgaben; alte importierte Inhalte werden kontrolliert zu `ss` beziehungsweise `SS` normalisiert

## 2.47.0

- verbundene persönliche Handschrift verwendet die Zeichenanzahl und Zeilenaufteilung des neuronalen Modells jetzt als exakte zusätzliche Segmentierungshypothese; die unbeschränkte persönliche Erkennung bleibt parallel erhalten, sodass ein falscher OCR-Zähler ein sicher trainiertes Zeichen nicht erzwingen kann
- der gemeinsame GlyphenWerk-/FaNotes-Fusionspfad verarbeitet mehrere physische Schreibzeilen einzeln, erhält Zeilenumbrüche und führt die gefundenen persönlichen Zeichen danach wieder mit der neuronalen Textzeile zusammen
- ein reproduzierbarer Grenzfall, der das verbundene Wort `test` ohne Führung als einzelnes `m` liest, wird nun über vier echte persönliche Tokens zu `test` aufgelöst; die Korrektur gilt sowohl im integrierten GlyphenWerk-Test als auch bei der Seitenkonvertierung
- ein sicher erkanntes bekanntes Einzelwort darf eine geometrische Integral-Fehlklassifikation nun auch im automatischen Modus korrigieren; unbekannte Variablenfolgen sowie Gleichungen, Brüche und Wurzeln bleiben ausdrücklich vor einem Text-Override geschützt
- die angezeigten GlyphenWerk-Korrekturtokens verwenden dieselbe neuronengeführte Segmentierung wie der sichtbare Ergebnistext, statt zwar das richtige Wort anzuzeigen, darunter aber falsch zusammengezogene Zeichen zur Korrektur anzubieten
- der leichte Wörterbuch- und Fusionspfad ist vom schweren ONNX/TrOCR-Lademodul getrennt; dadurch zieht eine persönliche oder kontextuelle Erkennung das neuronale Laufzeitpaket nicht unnötig in Arbeitsspeicher und Buildpfade
- ein neuer unabhängiger UJI-Pen-Characters-v2-Audit misst 7.440 echte alphanumerische Stiftproben von 60 Schreibenden und weist exakte, gross-/kleinschreibungsneutrale sowie Top-3-/Top-8-Ergebnisse getrennt aus, damit synthetische Holdouts die reale Generalisierung nicht mehr verdecken

## 2.46.0

- die allgemeine Offline-Zeilenerkennung verwendet jetzt ein zweisprachig feinabgestimmtes TrOCR-Modell mit FP32-Encoder und Q8-Decoder; im vollständigen unabhängigen deutschen ScaDS-Test erreicht die gewählte Browserausgabe 10,42 Prozent Zeichenfehler und 32,06 Prozent Wortfehler, während die echte ungesehene IAM-OnDB-Stiftzeile im Browser bei 3,85 Prozent Zeichenfehler liegt
- TrOCR dekodiert lokal mit einem begrenzten Beam von zwei Pfaden, lädt Modell und WASM erst bei einer tatsächlichen Konvertierung und gibt Speicher nach Inaktivität wieder frei; Web-App und Desktop senden dabei keine Handschrift an einen Erkennungsdienst
- GlyphenWerk-Test, Seitenkonvertierung und unsichtbare Suchtranskription verwenden nun denselben gemeinsamen Sequenzpfad: das neuronale Zeilenmodell liefert Kontext und Länge, wiederholt trainierte persönliche Zeichen behalten jedoch ihre visuell richtige Reihenfolge und werden nicht mehr durch ein scheinbar plausibles Wörterbuchwort überschrieben
- ein klassenbalancierter, bevorzugt sitzungsübergreifender Holdout entscheidet, ob adaptive Merkmalsgewichte die robuste Standardgewichtung tatsächlich schlagen; alle 1.001 persönlichen Beispiele bleiben erhalten, 624 diverse Laufzeitbeispiele und 13 Stilprototypen bestehen die verbundenen Holdout-Wörter `test`, `hallo`, `lernen`, `mathe` und `computer`
- Text- und Mathematikmodus werden gemeinsam bewertet: sinnvolle mehrwortige Sätze können falsche Integralhypothesen überstimmen, echte Gleichungen, Brüche, Wurzeln, Operatoren und räumliche Grenzen bleiben geschützt
- normale Hoch- und Tiefstellungen werden nicht mehr allein wegen ihrer Lage als Summengrenzen interpretiert; `2_{4}^{3}` bleibt eine Ziffernbasis, während die Zweibein-Geometrie von `∏`, Summen- und Integralgrenzen sowie Dreifachintegrale weiterhin korrekt gesetzt werden
- der persönliche Gesamtwortschutz und seine Herkunftsmetadaten sind konsistent: gewinnt eine mehrfach gelernte, visuell sichere Sequenz, werden weder einzelne Zeichen noch die angezeigte persönliche Evidenz nachträglich vom Sprachkontext verfälscht
- FaNotes verwendet durchgehend Schweizer Orthografie: `ß` und `ẞ` sind aus Katalog, Training, ZIP-Import, Erkennung und Text-zu-Handschrift entfernt; bestehende Texte werden für die Erkennung verlustarm zu `ss` beziehungsweise `SS` normalisiert
- Modell, WASM-Laufzeit und jedes einzelne Asset werden beim Build per SHA-256 geprüft; mitgelieferte NOTICE-Dateien dokumentieren TrOCR/UniLM, IAM, ScaDS.AI, Transformers.js und ONNX Runtime Web getrennt
- die Textauswahl erfasst beim Ziehen über den oberen oder unteren Papierrand die gesamte Editorfläche, einschließlich des Seiten-Paddings, und scrollt lange Notizen in beide Richtungen weiter

## 2.45.0

- die allgemeine Zeilenerkennung wurde nicht anhand weiterer synthetischer Formen bewertet, sondern auf allen 2.915 bisher ungesehenen Zeilen des unabhängigen IAM-Testsets: gegenüber dem bisherigen lokalen Modell sinkt die Zeichenfehlerrate von 15,06 auf 7,35 Prozent und die Wortfehlerrate von 51,21 auf 23,24 Prozent
- das auf beliebige Szenentexte ausgelegte PP-OCR-Modell wurde durch ein spezialisiertes PyLaia-IAM-CTC-Modell mit 5,3 Millionen Parametern ersetzt; das ONNX-Modell bleibt mit rund 21 MB praktisch gleich groß, wird weiterhin ausschließlich bei einer Handschriftkonvertierung geladen und benötigt im vollständigen Blindtest median 19,08 statt 15,59 Millisekunden pro Zeile
- ein begrenzter CTC-Strahl kombiniert die fünf visuell stärksten Zeichenpfade mit deutschen beziehungsweise englischen Buchstabenfolgen und den vorhandenen lokalen Rechtschreibfiltern; im vollständigen 2.915-Zeilen-Blindtest verbessert er das reine neuronale Ergebnis nochmals von 7,65 auf 7,35 Prozent Zeichenfehler, von 24,50 auf 23,24 Prozent Wortfehler und von 20,31 auf 22,16 Prozent vollständig richtige Zeilen
- der Browser-Laufzeittest verwendet nun zusätzlich eine echte, unveränderte IAM-OnDB-Stiftzeile mit 855 Punkten statt seine Aussage nur aus künstlich konstruierten Buchstaben abzuleiten; Wörterbuch und CTC-Evidenz holen dort die visuell plausible Namensalternative „Trevor“ statt „Frevor“ zurück
- persönliche GlyphenWerk-Kandidaten werden weiterhin zeichenweise mit dem Zeilenmodell fusioniert und mehrfach bestätigte persönliche Formen behalten Vorrang; das neue Modell ersetzt daher nicht die rund 1.000 trainierten Beispiele, sondern liefert ihnen eine wesentlich stärkere Erkennung verbundener Gesamtzeilen
- weil der spezialisierte Zeilensatz bewusst kompakt ist, schützt die Fusion starke geometrische beziehungsweise persönliche Evidenz für `ÄÖÜäöü` ausdrücklich vor einer Abflachung auf ASCII; eine eigene Regression prüft beispielsweise `ü` gegen ein neuronales `u`
- Modell, Zeichensatz, WASM-Laufzeit und Manifest werden weiterhin vollständig lokal und vor der ersten Verwendung per SHA-256 geprüft; das neue Manifest der Version 2 verweist nur noch auf die tatsächlich ausgelieferten PyLaia-Ressourcen und enthält deren MIT-Lizenz
- das neue reproduzierbare Benchmark-Werkzeug vergleicht beliebige ONNX-CTC-Modelle auf unabhängigen Parquet-Handschriftsätzen, trennt Groß-/Kleinschreibungsfehler, CER, WER, exakte Zeilen und Latenz und verhindert damit künftig irreführende Qualitätsaussagen aus zu kleinen In-House-Tests

## 2.44.0

- der strenge persönliche Holdout-Test steigt von 43,59 auf 100 Prozent: 39 Groß- und Kleinbuchstaben sowie Ziffern bleiben trotz Scherung, Größenänderung, umgekehrter Strichrichtung, veränderter Stiftbreite und zusätzlicher Stiftabhebungen korrekt
- wiederholt trainierte breite oder mehrstrichige Einzelzeichen werden nicht mehr in erfundene Wörter wie „ist“, „der“, „in“ oder „Es“ zerlegt; starke persönliche Evidenz für die vollständige Form schlägt nun einen zufälligen Wörterbuchbonus einer falschen Segmentierung
- ältere ähnliche Zeichenklassen werden nicht mehr allein wegen ihres Alters entwertet; legitime Paare wie `S/s`, `P/p` und `6/0` behalten ihre vollständigen Trainingsbeispiele, während bestätigte Korrekturen und eindeutig veraltete Fehl-Labels aus einer anderen Trainingssitzung weiterhin sicher Vorrang erhalten
- reine Textsätze mit i-Punkten und unterschiedlichen Buchstabenhöhen werden im automatischen GlyphenWerk-Test nicht mehr als `- \infty -` oder andere mathematische Formeln ausgegeben; lange beziehungsweise sinnvolle deutsche und englische Buchstabenfolgen dämpfen vereinzelte falsche Integral-, Unendlichkeits- und Indexhypothesen
- die neue Textabsicherung wird gegen „minimum ist neun“, „summe ist neun“, „mathe ist toll“, „hello math“ und „hello computer“ geprüft; eine echte Gleichung `1+2=3`, Brüche, Wurzeln, Integrale und Grenzen bleiben unverändert Mathematik
- einzelne trainierte Zeichen durchlaufen keinen sinnlosen Ein-Buchstaben-Sprachstrahl mehr; die persönliche Form entscheidet direkt und Groß-/Kleinschreibung wird nicht nachträglich ohne Wortkontext verändert
- alle 1.001 persönlichen Beispiele bleiben im Modell und in den Stilprototypen erhalten, während die Laufzeitklassifikation pro Klasse 48 zeitlich und stilistisch repräsentative Beispiele verwendet; die fünf verbundenen Wort-Holdouts sinken dadurch auf 0,92 bis 1,50 Sekunden statt bis zu rund 1,97 Sekunden
- der Feature-Cache bindet Einträge jetzt an Zeichenklasse, Stiftfingerabdruck und Bildlänge statt nur an die Beispiel-ID; erneut importierte GlyphenWerk-ZIPs mit aktualisierten Formen verwenden deshalb sofort die neuen Trainingsdaten

## 2.43.0

- das persönliche Handschriftmodell wird beim Linux-Start nicht mehr aus allen Trainingsbeispielen aufgebaut; Erkennungsdatenbank, Standardmodell, neuronale Laufzeit und KaTeX werden erst beim tatsächlichen Konvertieren, Testen oder nach einer neuen unkonvertierten Stifteingabe geladen
- die Entscheidung, ob der GlyphenWerk-Training-Button sichtbar sein muss, verwendet nur noch einen sehr kleinen IndexedDB-Zähler statt bis zu 1.024 vollständige Stiftbeispiele einzulesen und zu verarbeiten
- Desktop-Bootstrap und Sprachinitialisierung laufen parallel; vorhandene Zeichnungs- und Arbeitsblatt-Layer der ersten Notiz werden erst nach dem interaktiven Editor geladen, ohne Inhalt, Suche oder automatisches Speichern zu verändern
- im reproduzierbaren Linux-Stresstest mit 2.000 Notizen, 400 Stiftzügen und 1.000 Trainingsbeispielen sinkt die CPU-Arbeit während der ersten fünf Sekunden von 5,54 auf 0,84 CPU-Sekunden und die gemessene Lastspitze von 163 auf 22 Prozent
- der Electron-Build enthält nur noch die tatsächlich unterstützten deutschen und englischen Chromium-Sprachpakete; 53 ungenutzte Locale-Dateien entfallen und ihr entpackter Speicherbedarf sinkt von rund 46 auf 1,2 MB
- der Pfad zur gebündelten ONNX-WASM-Laufzeit wurde für installierte Linux- und Windows-Pakete korrigiert, sodass die weiterhin verzögert geladene neuronale Texterkennung bei der ersten echten Konvertierung zuverlässig startet
- die Startmessung kann realistische Stiftseiten und persönliche Trainingsdaten reproduzierbar vorbereiten; die visuelle Browserprüfung führt zusätzlich eine echte Seitenkonvertierung aus und sichert damit den neuen Lazy-Load-Pfad ab

## 2.42.0

- die persönliche Erkennung vergleicht nicht mehr nur kleine Rasterbilder, sondern fusioniert die visuelle Form mit 24 zeitlich geordneten Punkten pro Stiftstrich, Strichrichtung, Stiftabhebungen, Geometrie, Projektionen, HOG und Topologie; ähnliche Bilder mit unterschiedlichem Schreibablauf werden dadurch deutlich besser getrennt
- jede trainierte Zeichenklasse besitzt jetzt bis zu fünf unterschiedliche persönliche Stil-Prototypen sowie eine gemessene Streuung und Zuverlässigkeit; bis zu 1.024 Beispiele pro Zeichen fließen in diese Qualitätswerte ein, während höchstens 96 repräsentative Detailbeispiele die Erkennung schnell halten
- das generische lokale Zeilenmodell überschreibt GlyphenWerk nicht mehr bereits ab sehr niedriger Sicherheit, sondern wird zeichenweise mit den persönlichen Kandidaten fusioniert; mehrfach bestätigte persönliche Formen gewinnen gegen ein falsches OCR-Zeichen, ein einzelnes schwaches Beispiel darf ein sehr sicheres Zeilenmodell jedoch nicht blind verdrängen
- die erkannte Zeichenanzahl des Zeilenmodells dient bei sicheren einzeiligen Eingaben als zusätzliche Segmentierungshypothese; persönliche Stiftformen entscheiden weiterhin über die Zeichen selbst, wodurch verbundene unbekannte Wörter auch ohne Wörterbuchtreffer stabiler gelesen werden
- eine direkt angeklickte Zeichenalternative wird sofort als vertrauenswürdige Korrektur gelernt und baut das lokale Modell neu auf, ohne erst auf „Einfügen“ zu warten; zusammengezogene oder zu stark getrennte Wörter werden anhand der bestätigten Wortlängen neu segmentiert und erzeugen trotzdem wiederverwendbare Einzelzeichen
- exakt identische sowie sehr ähnliche alte Fehl-Labels werden gegenüber neueren oder ausdrücklich bestätigten Korrekturen unterdrückt; klassenweise Rauschmessung, vertrauensgewichtete Nachbarschaften und robuste lokale Mehrheitswerte verhindern, dass eine verunreinigte Trainingsklasse das gesamte Modell übernimmt
- verbundene Handschrift bewertet nun bis zu elf statt sieben plausible Trennungen, verwendet einen korrigierten physischen Breitenfaktor und bestraft winzige als Buchstaben missverstandene Anschlussfragmente; die früher reproduzierbaren Übersegmentierungen bei „hallo“ und Untersegmentierungen bei „computer“ sind damit behoben
- ein neuer Browser-Holdout-Benchmark prüft 1.001 persönliche Textbeispiele, 204 persönliche Mathematikbeispiele, verzerrte ungesehene Zeichen, verbundene Wörter, widersprüchliche T-/Doppelintegral-Korrekturen, verrauschte Klassen, Korrektur-Neusegmentierung und die Fusion gegen ein absichtlich falsches neuronales Wort
- der Linux-Build liefert vollständig gebündelte Renderer-Pakete nicht mehr ein zweites Mal als Laufzeit-node_modules aus; 6.667 unnötige Dateien einschließlich rund 61 MB nativer Canvas-Bibliotheken entfallen und app.asar schrumpft von rund 135 auf 54 MB
- das gehärtete AppImage verwendet startfreundliche Gzip- statt XZ-Kompression; im reproduzierbaren FUSE-losen Start mit 2.000 Notizen sinken Editorzeit von 13,90 auf 2,11 Sekunden und CPU-Arbeit von 13,89 auf 2,26 Sekunden, während die native Installation im Mittel nach 0,325 Sekunden editierbar ist

## 2.41.0

- der Linux-Startpfad deaktiviert ungenutzte Chromium-Hintergrunddienste wie Komponentenupdates, Übersetzung, Medienrouting, Synchronisierung und Optimierungshinweise; normale App- und AI-Netzwerkfunktionen bleiben davon unberührt
- CodeMirror wird beim Öffnen der ersten Notiz nur noch einmal konfiguriert, statt direkt nach seiner Erstellung alle Editor-Komponenten und die Rechtschreibprüfung ein zweites Mal aufzubauen
- der vollständige Vault-Abgleich, Auto-Updater, anonyme Startstatistik und die Pflege der Willkommensnotiz laufen nun deutlich später und voneinander getrennt; der lokale Baum-Cache und die erste Notiz bleiben sofort verfügbar
- verschlüsselte AI-Schlüssel wecken unter Linux nicht mehr während jedes normalen Starts den System-Keyring und D-Bus, sondern werden sicher erst beim tatsächlichen Öffnen des AI-Menüs entschlüsselt; andere Einstellungsänderungen bewahren die verschlüsselten Werte unverändert
- die deutsche Oberfläche überspringt die komplette DOM-Übersetzungsbeobachtung, während Englisch feste und dynamische Texte ohne den bisher sofort aufgebauten riesigen Ersatzindex übersetzt; ein vollständiger englischer Oberflächentest sichert alle Ansichten ab
- die erweiterte Linux-Messung erfasst nun auch die ersten zwölf Sekunden nach dem sichtbaren Start: Im reproduzierbaren Test mit 2.000 Notizen sinkt die gesamte CPU-Zeit um rund 19 Prozent und die CPU-Nachlaufspitze von 25 auf 12 Prozent

## 2.40.0

- eine in GlyphenWerk bestätigte Zeichenkorrektur besitzt nun sofort Vorrang für exakt dieselbe unveränderte Tinte; der durch das Speichern ausgelöste Modell-Neuaufbau darf die Auswahl nicht mehr automatisch erneut analysieren und auf das vorherige falsche Ergebnis zurücksetzen
- ein normales zweistrichiges großes `T` wird anhand einer breiten oberen Querlinie, eines mittig darunter verlängerten Stamms und der Kreuzungsposition als eindeutige T-Geometrie erkannt; Text- und Mathematikklassifikator bevorzugen dadurch `T` deutlich gegenüber `l`, `t`, Pluszeichen und allen Integralvarianten
- die automatische Moduswahl behandelt eine eindeutige einzelne T-Geometrie als starken Textnachweis, selbst wenn Mathematik der zuletzt verwendete Modus war; eine manuelle Korrektur auf einen einzelnen Buchstaben wechselt die aktuelle Vorschau ebenfalls unmittelbar und stabil auf Text
- das lokale Standardmodell wurde auf Version 5 angehoben und enthält jetzt zwei druckstärkenunabhängige handschriftliche Groß-T-Vorlagen, sodass die Korrektur bereits ohne persönliches Training greift und vorhandene persönliche Beispiele unverändert ergänzt werden
- echte Doppel- und Dreifachintegrale erhalten eine eigene Mehrstrichprüfung: Nur mehrere hohe, gekrümmte Integralzüge werden entsprechend bevorzugt, während parallele Geraden oder ein T mit Querstrich ausgeschlossen werden
- neue Regressionen prüfen dasselbe T im Textpfad, Mathematikpfad und automatischen Modus, ein bestätigtes persönliches T bei Mathematik als vorherigem Modus sowie den Erhalt eines echten Doppelintegrals

## 2.39.0

- kurze, getrennt gesetzte Auslauf- und Anschlussstriche rechts neben einem handschriftlichen Buchstaben werden anhand von Endpunkt, Grundlinienposition, Größe und Schreibrichtung wieder dem Buchstaben zugeordnet; die Kursivsegmentierung darf diesen geschützten Bereich anschließend nicht erneut als zweiten Buchstaben abtrennen
- für die Klassifikation wird neben der vollständigen Form kontrolliert auch der Buchstabenkörper ohne den als Anschluss erkannten Zierstrich bewertet, sodass beispielsweise ein `a` mit nachträglich gesetztem Verbindungsstrich weiterhin als einzelnes `a` statt als `am` gelesen wird
- Wortabstände verwenden jetzt pro Zeile eine adaptive Analyse aus Zeichenbreite, physischer x-Höhe, kompakter Schreibdichte, lokaler Streuung und getrennten Abstandsgruppen; gleichmäßig eng geschriebene Wörter erhalten dadurch keine erfundenen Leerzeichen, während ein echter lokaler Abstandssprung auch zwischen breiten Zeichen erhalten bleibt
- eine zusätzliche sprachliche Abstandsprüfung verbindet unbekannte Wortfragmente wieder, wenn ihre gemeinsame Form ein eindeutiges Wörterbuchwort ist, und kann mehrere fehlende Grenzen in einer zusammengezogenen Wortfolge zurückgewinnen; unbekannte Namen und Fachbegriffe werden nicht allein für das Wörterbuch zerlegt
- persönliche GlyphenWerk-Beispiele erhalten einen leicht erhöhten, weiterhin begrenzten Distanzvorteil, Ein-Beispiel-Prototypen bestehen jetzt zu 88 Prozent aus der persönlichen Form und die drei nächsten persönlichen Beispiele werden mit 72/20/8 Prozent gewichtet; das Standardmodell bleibt als geometrische Absicherung erhalten
- neue Regressionen prüfen den getrennten Anschlussstrich am `a` bis zum erkannten Ergebnis, gleichmäßige enge Zeichenabstände, einen einzelnen ungewöhnlichen Abstand innerhalb von `lernen`, kompakte echte Wortgrenzen und die kontrollierte Bevorzugung einer persönlichen Zeichenform

## 2.38.0

- beim Ziehen einer Tastatur-Textauswahl über den oberen oder unteren Rand scrollt die gemeinsame Papierseite jetzt stufenlos in beide Richtungen weiter und erweitert die Auswahl währenddessen
- getrennte Punkte und Akzente werden anhand von Größe, Abstand und horizontaler Position ihrem Buchstaben zugeordnet; insbesondere wird ein separat gesetzter i-Punkt nicht mehr als eigenes Zeichen oder als andere Zeile behandelt
- mögliche Trennungen verbundener Handschrift werden nicht mehr nur pro Tintenkomponente gewählt, sondern als begrenzter Suchraum im vollständigen Wort und in der vollständigen Zeile bewertet; dadurch bleiben breite Einzelbuchstaben geschützt, während zusammengezogene Buchstaben zuverlässiger getrennt werden
- Groß- und Kleinbuchstaben berücksichtigen jetzt Zeichenhöhe und Wortposition; horizontale Striche verwenden zusätzlich die Grundlinie, um Unterstrich und mittigen Binde-/Minusstrich auseinanderzuhalten
- die lokale Wortprüfung repariert nahe nicht sinnvolle Formen konservativ über bis zu zwei Durchläufe, berücksichtigt Wortfrequenz und Einfüge-/Löschfehler und schützt weiterhin Eigennamen, CamelCase sowie unbekannte Fachbegriffe
- Text in FaNotes und GlyphenWerk behält mehrere physische Schreibzeilen in korrekter Lesereihenfolge; kleine Punkte werden dabei anhand des nächstliegenden Buchstabens statt nur der groben Zeilenfläche zugeordnet
- mathematische Seiten werden in räumliche Rechenzeilen gegliedert, ohne Brüche, Wurzeln, Hoch-/Tiefstellungen oder Integral-, Summen- und Produktgrenzen auseinanderzureißen; mehrere Zeilen erscheinen als sauber ausgerichtete KaTeX-Formel
- Kreuzgeometrie stabilisiert Pluszeichen zwischen Operanden, eine strengere offene S-Kurve unterscheidet Integrale von Ziffern und Klammern, und erkannte Grenzwerte sind vor nachfolgenden Klammer-, Fakultäts- und Prozentheuristiken geschützt
- das untrainierte Standardmodell enthält einen eigenen Unterstrich und wurde auf Version 4 angehoben; bestehende persönliche GlyphenWerk-Daten bleiben vollständig kompatibel und erhalten automatisch die neuen Standardbeispiele
- neue Regressionen prüfen Auswahl-Autoscroll nach oben und unten, Groß-/Kleinschreibung, Unterstrichposition, i-Punkte, Wortkorrektur, verbundene Wörter, mehrere Text- und Mathematikzeilen sowie Integrale mit Ober- und Untergrenze

## 2.37.0

- GlyphenWerk übernimmt in der eingebetteten FaNotes-Ansicht jetzt das vollständig aufgelöste Theme einschließlich Hintergrund-, Panel- und Textfarben, beider Akzentfarben, UI-Schrift und der Einstellung für reduzierte Bewegung
- die Theme-Brücke reagiert ohne Neuladen auf System- und Einstellungswechsel, validiert ausschließlich bekannte CSS-Variablen und lässt die weiße Schreibfläche für stabile Trainings- und Erkennungseingaben unverändert
- der getrennte Text-/Mathematik-Schalter wurde durch eine gemeinsame automatische Erkennung ersetzt, die für jede Eingabe Wortstruktur, Zeichenkonfidenz und räumliches Formellayout zusammen bewertet
- Sätze, Terme und vollständige Gleichungen können auf derselben Testfläche geschrieben werden; der erkannte Modus, seine Sicherheit und der wichtigste Entscheidungsgrund werden unmittelbar angezeigt
- bei erkannten Formeln bleiben Brüche, Wurzeln, Hoch- und Tiefstellungen sowie Ober- und Untergrenzen korrigier- und trainierbar, während bestätigte Buchstaben und Symbole dasselbe persönliche Modell verbessern
- neue Integrations- und Browserprüfungen sichern die Theme-Palette, die sichere iframe-Kommunikation und die gemeinsame Text-/Mathematik-Oberfläche für Linux, Windows und Web ab

## 2.36.0

- eine neue vollständig lokale neuronale Texterkennung liest ganze handschriftliche Zeilen und Wörter direkt, statt verbundene Schreibschrift künstlich in einzelne Glyphen zu zerlegen
- Deutsch und Englisch werden mit visueller CTC-Bewertung und konservativem Wortkontext kombiniert; ähnlich aussehende Buchstaben werden im Satzkontext aufgelöst, während Eigennamen und Fachbegriffe unverändert bleiben
- mehrere Schreibzeilen, natürliche Wortabstände und zusammenhängende Buchstaben funktionieren ohne vorheriges GlyphenWerk-Training; persönliche GlyphenWerk-Beispiele und die spezialisierte Mathematikerkennung bleiben als ergänzende Pfade erhalten
- die unsichtbare Transkription für die Suche verwendet dieselbe zeilenbasierte Engine, sodass noch nicht konvertierte handschriftliche Seiten deutlich zuverlässiger auffindbar sind
- Modell, Zeichensatz und Laufzeit werden ausschließlich lokal ausgeführt, vor der Nutzung per SHA-256 geprüft und erst beim ersten Erkennen geladen; Startzeit und initialer Web-Download bleiben dadurch unverändert
- neue Browser-Regressionen prüfen verbundene deutsche und englische Wörter, Wortabstände, mehrere Zeilen, Eigennamen-Schutz, Integrität sowie kalte und warme Erkennungslaufzeiten

## 2.35.0

- das vollständig lokale Standardmodell enthält jetzt drei eingebettete Handschriftstile sowie maßstabskorrekte Einlinienformen für häufige Kleinbuchstaben und funktioniert direkt ohne persönliches GlyphenWerk-Training
- kollidierende Standardbeispiel-IDs und eine falsche X/Y-Skalierung wurden behoben; ähnliche Schreibstile werden nun nach der nächstliegenden Form gewichtet, statt durch unpassende Druckvarianten verwässert zu werden
- verbundene Wörter erhalten mehr geometrisch begrenzte Segmentierungshypothesen, einen breiteren visuellen Kandidatenraum und deutsche beziehungsweise englische Präfixbewertung; breite Einzelzeichen bleiben gegen erfundene Worttrennungen geschützt
- alle Ziffern von 0 bis 9 besitzen zusätzliche handschriftliche Grundformen; Plus, Minus, Malzeichen, Gleichheitszeichen, Wurzel, Integral und Summe verwenden ebenfalls maßstabskorrekte Stiftvorlagen
- ein neuer Formtest unterscheidet den Wurzelhaken von Integral, Klammer und Ableitungsstrich, während berührende Serifen und Querstriche zusammenbleiben und Inhalte innerhalb einer Wurzel getrennt gruppiert werden
- eine echte Browser-Regression prüft die untrainierte Erkennung jetzt exakt mit 13 Einzelbuchstaben, fünf verbundenen Wörtern, 17 Ziffern und Mathematiksymbolen sowie `\sqrt{7}` und `\frac{2}{3}`

## 2.34.1

- der Updater prüft die lokal installierte Binärbasis vor dem Delta-Download und wechselt bei älteren, unter derselben Versionsnummer ausgelieferten Builds automatisch auf das vollständig signierte Vollpaket, statt mit „Die installierte FaNotes-Datei passt nicht zur Basis des differentiellen Updates“ abzubrechen
- die sichere Ausweichroute gilt unter Windows und Linux auch dann, wenn ein Delta nicht vollständig geladen oder nicht exakt rekonstruiert werden kann; das Vollpaket muss weiterhin Größe und SHA-256-Prüfsumme des signierten Manifests erfüllen
- Downloadgröße, Fortschritt und Installationsart wechseln sichtbar auf den tatsächlich verwendeten Vollupdate-Pfad, sodass anschließend unter Windows der Installer und unter Linux das geprüfte AppImage verwendet wird
- bei exakt passender Basis bleiben die kleinen differentiellen Updates unverändert der bevorzugte Normalfall

## 2.34.0

- der Textmodus erkennt jetzt auch Schreibschrift und Ligaturen, bei denen mehrere Buchstaben ohne Absetzen in einem einzigen durchgehenden Stiftstrich verbunden sind
- bis zu fünf streng begrenzte Segmentierungshypothesen suchen dünne, überwiegend horizontale Verbindungszüge; breite Einzelbuchstaben wie W bleiben vor falscher Auftrennung geschützt
- visuelle Form, Strichgeometrie, Buchstabenbreite sowie deutsche oder englische Wort- und Buchstabenfolgen bewerten jede mögliche Trennung gemeinsam statt Zeichen isoliert zu erraten
- das vollständig lokale Standardmodell enthält zusätzliche kursive Serifenvorlagen sowie synthetische Ein- und Ausgänge für verbundene Groß-, Klein- und Sonderbuchstaben und funktioniert weiterhin ohne vorheriges Training
- bereits ein persönliches Beispiel pro Buchstabe erzeugt einen gegen das Standardmodell stabilisierten Handschriftprototyp; echte Stiftgeometrie, Schräglagenvarianten und eine sichere persönliche Priorität reduzieren den nötigen Trainingsumfang
- erkannte Teilstücke behalten ihre echten Stiftpunkte, sodass eindeutige Kontextkorrekturen auch verbundene Buchstaben automatisch weiter personalisieren; Einzelzeichen, Mathematik, Brüche und räumliche Indizes verwenden unverändert ihre spezialisierten Pfade

## 2.33.0

- die Web-App wird auf der Produktwebsite jetzt als vollständige, sofort nutzbare FaNotes-Variante mit direktem Einstieg, Funktionsübersicht und eigener Browser-Vorschau präsentiert
- bestehende lokale Web-Vaults reparieren die betroffene Willkommensnotiz sicher, und isolierte Papier- sowie Markdown-Flächen verhindern die zuvor mögliche schwarze Darstellung
- ein ressourcenschonender Firefox/WebRender-Sicherheitsmodus reduziert auf der Website teure Transparenz-, Filter- und Animationskombinationen und verhindert Browser-Abstürze
- Windows- und Linux-Updatemanifeste werden für jede Sprache vollständig vor der Auslieferung signiert; ihre Ed25519-Prüfung bleibt bytegenau gültig und der Windows-Fehler zur ungültigen kryptografischen Signatur ist behoben
- der Auto-Updater lädt bei unterstützten Vorgängerversionen nur die geänderten Datenblöcke, rekonstruiert die neue App lokal und prüft sie vollständig mit SHA-256 sowie dem signierten Manifest

## 2.32.0

- die gesamte FaNotes-App, die integrierte GlyphenWerk-Oberfläche, die Web-App und die Produktwebsite wechseln anhand der System- beziehungsweise Browsersprache vollständig zwischen Deutsch und Englisch; in den Einstellungen kann die Sprache zusätzlich fest gewählt werden
- das erste Onboarding bietet die vier Einsatzprofile Schule, UNI, Privat und Arbeit und bereitet jeweils passende, frei anpassbare Startordner vor
- die Website positioniert FaNotes als ruhigen Denk- und Notizraum für alle Lebensbereiche, zeigt die vier Profile in einer eigenen responsiven Sektion und verwendet keine Produktvergleiche mehr
- GlyphenWerk-ZIP-Dateien lassen sich weiterhin in den Einstellungen und neu direkt im sichtbaren GlyphenWerk-Kopfbereich importieren
- native Wayland-Sitzungen entfernen Vulkan auch aus erzwungenen Chromium-Featurelisten und überschreiben versehentlich gesetztes ANGLE-Vulkan mit hardwarebeschleunigtem OpenGL/EGL; nur der ausdrückliche Diagnose-Schalter kann Vulkan noch aktivieren
- die Willkommensnotiz verwendet für Strg+Z kein fehleranfälliges Inline-Code-Markup mehr; vorhandene betroffene deutsche und englische Willkommensdateien werden ausschließlich an dieser exakten Stelle repariert
- Übersetzungs-, Onboarding-, Start-, Rendering-, Website-, GlyphenWerk- und Sicherheitsprüfungen sichern denselben Stand für Linux, Windows und Web ab

## 2.31.0

- das Einstellungsfenster ordnet sämtliche vorhandenen Optionen in die drei klaren Gruppen „Aussehen & Schreiben“, „Stift & Arbeitsbereich“ und „FaNotes & System“, ohne eine bisherige Anpassungsmöglichkeit zu entfernen
- eine sofortige lokale Suche findet Einstellungen über Namen, Synonyme und Funktionen und springt direkt zur passenden Karte; die grössere responsive Oberfläche bleibt auf kleinen Fenstern vollständig bedienbar
- die Darstellungskarte nutzt ihre Breite ohne Leerräume, alle sechs Themes behalten WCAG-AA-Kontrast und Einstellungen besitzen eine ruhigere Typografie, konsistente Abstände sowie eindeutige Fokuszustände
- Microsoft-OneNote-Notizbücher lassen sich als `.one`, `.onetoc2`, `.onepkg` oder OneDrive-ZIP direkt in den aktiven Vault importieren; Notizbuch-, Abschnittsgruppen-, Abschnitts-, Seiten- und Unterseitenhierarchie bleiben erhalten
- OneNote-Seiten bewahren Positionen, Formatierung, Tabellen, Listen, Bilder, Freihand-Ink, Mathematik und durchsuchbaren Text in einer isolierten originalgetreuen Papieransicht; jede Seite erhält zusätzlich eine normale Markdown-Notiz
- Originalquellen und Anlagen werden bytegenau mit SHA-256-Manifest gespeichert, aber mit inertem Dateityp niemals ausgeführt; Archivpfade, Symlinks, Dateisignaturen, Größen und Anzahl werden vor und nach dem Entpacken streng begrenzt
- die OneNote-Konverter werden erst nach einem ausdrücklich gestarteten Import geladen, aus dem signierten `app.asar` in einen hashgeprüften privaten Werkzeugcache entfaltet und dadurch auch mit reinen Delta-Updates vollständig ausgeliefert
- der Linux-Startpfad lädt keine native Chromium-Rechtschreibengine mehr, verschiebt Updateprüfung, Vault-Vollabgleich, Willkommen-Migration und lokale Wörterbuchanalyse bis deutlich nach dem interaktiven Editor und reduziert eingebettete Startschriften
- fünf reale Starts der nativen Arch-/Portable-Installation mit 10.000 Notizen erreichten im Mittel 353 ms bis zur Shell und 766 ms bis zum Editor; der langsamste Lauf blieb mit 827 ms weit unter dem 3-Sekunden-Ziel
- der gesamte Prozessbaum verbrauchte dabei im ersten 3-Sekunden-Fenster durchschnittlich 0,88 CPU-Sekunden; ein Langseitentest mit 2.000 Strichen hielt p95 bei 16,7 ms ohne Frame über 25 ms und 20 MiB Renderer-Heap
- Linux, Windows und Web verwenden denselben neuen Settings- und Inhaltscode; Import-, Sicherheits-, Menü-, Theme-, Rendering-, Delta-, Startzeit- und CPU-Regressionstests sichern die Veröffentlichung ab

## 2.30.0

- die gemeinsame Tastaturansicht unterstreicht mögliche Rechtschreibfehler wie in Word direkt mit einer klaren roten Wellenlinie
- Deutsch und Englisch werden lokal pro Textzeile automatisch erkannt; gemischte Notizen dürfen beide Sprachen gleichzeitig enthalten und zeigen den erkannten Modus in der Statusleiste
- Wörter, die in einer der beiden Sprachen korrekt sind, bleiben auch in gemischten Schulnotizen unmarkiert; Schweizer Schreibweisen mit `ss` und zusammengesetzte deutsche Wörter werden berücksichtigt
- Mathematik, LaTeX, Inline- und Blockcode, URLs, Mailadressen, HTML, Markdown-Linkziele, Hashtags, Abkürzungen und bekannte FaNotes-Fachbegriffe sind bewusst von der Textprüfung ausgenommen
- das gerade geschriebene Wort wird erst nach dem Verlassen oder einer kurzen Schreibpause bewertet, sodass die Wellenlinie beim Tippen nicht flackert
- beide Wörterbücher sind als rund 620 KiB große, integritätsgeprüfte Filter eingebettet, werden erst nach dem ersten Editor-Render geladen und benötigen weder Netzwerk noch AI
- derselbe Prüfpfad läuft unter Linux, Windows und in der installierbaren Web-App; Wörterbuchdateien werden im PWA-Cache auch offline bereitgehalten
- Logik-, Integritäts-, Sprach-, Markdown-, Desktop-Rendering- und Webtests sichern Tippfehler, Mischtext, Schweizer Orthografie, Ausnahmen, Statusanzeige und rote Darstellung ab

## 2.29.0

- der bisherige LM-Studio-Dialog ist ein gemeinsamer AI-Bereich mit klaren Anbieter-Karten für LM Studio, Ollama, OpenAI, Gemini, Anthropic und OpenCode
- jeder Anbieter besitzt eigene, verständlich beschriftete Verbindungs-, Zugangsdaten- und Modellfelder; Modelllisten werden direkt über die jeweilige offizielle Schnittstelle geladen
- alle neun bisherigen Notizaktionen, ihre Mehrfachauswahl sowie gerenderte und rohe Markdown-Vorschau funktionieren unverändert mit jedem Anbieter
- LM Studio, Ollama und OpenCode dürfen ausschließlich geprüfte localhost- oder private LAN-Adressen erreichen; Weiterleitungen, eingebettete Zugangsdaten und öffentliche benutzerdefinierte Ziele werden blockiert
- OpenAI, Gemini und Anthropic verwenden feste offizielle HTTPS-Endpunkte, begrenzte Anfragen und anbieterspezifische Antwortparser
- Desktop-Zugangsdaten werden mit Electrons Betriebssystemspeicher verschlüsselt, nie in Vault-Backups übernommen und im Browser für Cloud-Anbieter nach dem Schließen des AI-Bereichs vergessen
- die Web-App leitet Cloud-Anfragen über einen ursprungsgeprüften, ratebegrenzten Proxy weiter, der Schlüssel weder speichert noch protokolliert; lokale Anbieter bleiben direkte Verbindungen vom eigenen Browser
- OpenCode-Sitzungen werden für jede Vorschau isoliert angelegt und anschließend gelöscht; Datei-, Shell-, Such-, Web- und Unteragentenwerkzeuge sind im Notizkontext ausdrücklich deaktiviert
- neue Adapter-, Sicherheits-, Desktop- und Web-Renderingtests prüfen alle sechs Anbieter, Header, URL-Grenzen, Sitzungsbereinigung, geheime Einstellungen und die responsive Oberfläche

## 2.28.0

- die überladene Notiz-Toolbar konzentriert sich jetzt auf die drei häufigsten Aktionen; Ansicht und Datei liegen in einem klar beschrifteten, gruppierten Notizmenü
- Fokusmodus, Gliederung und Dateizugriff besitzen verständliche Beschreibungen, eindeutige aktive Zustände, Tastaturbedienung und Screenreader-Semantik
- das Zeichenstudio ist in die Bereiche Pinsel, Farben und Piktogramme gegliedert, sodass nie mehr alle umfangreichen Werkzeuggruppen gleichzeitig sichtbar sind
- eine gemeinsame, stets erreichbare Einstellungsleiste hält Breite, Deckkraft und Spezialoptionen beim Wechsel zwischen den Zeichenbereichen stabil
- Datei- und Ordner-Kontextmenüs zeigen nun Art und Namen des ausgewählten Elements und ordnen Aktionen unter Erstellen, Darstellung und Verwalten ein
- Abstände, Schatten, Radien, Hover-, Fokus- und Öffnungsanimationen wurden für eine ruhigere visuelle Hierarchie über alle sechs Themes hinweg vereinheitlicht
- kleine Fenster erhalten automatisch einspaltige Zeichenmenüs und sichere viewportgebundene Kontextmenüs ohne abgeschnittene Aktionen oder horizontales Scrollen
- reduzierte Bewegung, WCAG-AA-Kontraste, ARIA-Tabs und semantische Menürollen werden durch neue statische und echte Electron-Renderingtests abgesichert

## 2.27.0

- das Zeichenstudio enthält jetzt eine integrierte Bibliothek mit 25 direkt einfügbaren Icons und Piktogrammen für Schule, Symbole und Alltag
- Buch, Rechner, Labor, Atom, Globus, Idee, Stift, Computer, Markierungen, Personen, Zeit, Medien und weitere häufige Motive sind kategorisiert und vollständig per Tastatur sowie Screenreader erreichbar
- ein ausgewähltes Piktogramm wird per Stift- oder Mausklick an der gewünschten Stelle der normalen Papierseite platziert; das Werkzeug bleibt für beliebig viele Wiederholungen aktiv
- Größe von 20 bis 180 Pixeln, freie Drehung, Deckkraft, 14 Vollfarben, eigene Farben und alle sieben Spezialtinten wirken auch auf Piktogramme
- die Symbole werden als auflösungsunabhängige Vektorpfade gerendert und bleiben dadurch beim Zoomen, Exportieren sowie auf Linux, Windows und im Web scharf
- Piktogramme verwenden denselben Undo-, Redo-, Autosave- und Löschpfad wie Zeichnungen; der Radierer berücksichtigt dabei ihre vollständige sichtbare Fläche
- gespeicherte Symbolkennung, Größe und Drehung werden beim Laden streng validiert, während ältere Zeichnungsdateien unverändert kompatibel bleiben
- Icons und Piktogramme sind von Handschrift getrennt und gelangen weder in die unsichtbare Suchtranskription noch in Text-, Mathematik- oder Rechenwegerkennung
- die responsive Bibliothek passt Anzahl und Anordnung der Symbole an kleine Fenster an und verwendet ausschließlich kontrastsichere Theme-Farben
- statische und echte Electron-Renderingtests prüfen alle 25 Motive, Kategorien, direkte Platzierung, Rotation, Autosave, JSON-Wiederöffnung und die Erkennungstrennung

## 2.26.0

- der bestehende Stiftmodus besitzt jetzt einen eigenen Zeichenmodus direkt auf derselben Papierseite; Tastaturtext, Handschrift und Zeichnungen bleiben gemeinsam sichtbar und editierbar
- acht eigenständig gerenderte Werkzeuge decken Fineliner, Bleistift, Marker, druckdynamischen Pinsel, Kalligrafiefeder, Textmarker, Aquarell und Spray ab
- 14 sofort verfügbare Vollfarben, eine freie Farbauswahl sowie Regenbogen-, Aurora-, Sonnenuntergang-, Ozean-, Gold-, Silber- und Neon-Spezialtinte ermöglichen deutlich vielseitigere Skizzen
- Breite und Deckkraft lassen sich fein einstellen; die zuletzt verwendete Kombination aus Pinsel, Farbe, Spezialtinte, Breite und Deckkraft wird lokal für die nächste Sitzung gemerkt
- Druck geeigneter Grafiktabletts beeinflusst Bleistift, Pinsel, Kalligrafie und Aquarell, während Marker, Fineliner, Textmarker und Spray bewusst gleichmässig bleiben
- Texturen und Spraypartikel verwenden eine pro Strich gespeicherte stabile Kennung, damit Zeichnungen nach Speichern, Neustart und Plattformwechsel exakt gleich aussehen
- vorhandene Zeichnungsdateien bleiben vollständig kompatibel; alle neuen Felder werden beim Laden streng validiert und auf sichere Werte begrenzt
- Kunststriche sind intern von Handschrift getrennt und gelangen weder in die unsichtbare Suchtranskription noch in Text-, Mathematik-, Bereichs- oder Rechenwegerkennung
- die einklappbare Zeichenpalette passt sich an kleine Fenster an, bleibt in der gemeinsamen Word-/Obsidian-artigen Seitenansicht und respektiert reduzierte Bewegung sowie sämtliche Themes
- der echte Electron-Renderingtest zeichnet einen Aurora-Spraystrich, wartet auf Autosave, öffnet die gespeicherte JSON-Zeichnung erneut und prüft Pinsel, Spezialfarbe, Textur-ID und die leere Handschrifttranskription

## 2.25.0

- der erste Start führt jetzt in drei kurzen, verständlichen Schritten durch FaNotes: Willkommen, gemeinsames Schreiben mit Tastatur und Stift sowie die persönliche Fächerauswahl
- eine animierte, echte FaNotes-Vorschau zeigt schon vor der Einrichtung, wie Ordner, Markdown, Handschrift und die Suche zusammenspielen
- die Schreibvorschau zeichnet Tinte schrittweise, erklärt die optionale Umwandlung und macht die unsichtbare Suchtranskription verständlich
- die Fortschrittsanzeige erlaubt das sichere Vor- und Zurückspringen; ein direkter Weg zur Fächerauswahl bleibt für erfahrene Nutzer erhalten
- gestaffelte Übergänge, gezeichnete SVG-Tinte und ruhige Tiefenbewegungen verwenden nur GPU-freundliche Eigenschaften und vergrössern den normalen Startpfad nicht, weil das Onboarding weiterhin separat geladen wird
- Systemeinstellung und FaNotes-Option „Bewegung reduzieren“ schalten alle dekorativen Bewegungen zuverlässig ab, ohne Inhalte zu verstecken
- Fokusführung, semantische Schrittanzeige, verständliche Beschriftungen und Live-Status machen die Einrichtung vollständig per Tastatur und Screenreader bedienbar
- kleine Fenster sowie alle sechs Themes besitzen eine eigene responsive, kontrastsichere Darstellung; der Webtest durchläuft alle drei Schritte und prüft Vorschau, Fächer und Abschluss

## 2.24.0

- das Suchfeld in der Seitenleiste ist jetzt wirklich direkt beschreibbar; Text, Dateinamen und die unsichtbare Handschrifttranskription werden in einer synchronisierten Vault-Suche zusammengeführt
- die Suche besitzt klarere Leerzustände, Trefferanzahl, Löschen per Knopfdruck, vollständige Tastaturnavigation und lässt sich zuverlässig mit Escape schließen
- Strg+S speichert nun auch ausserhalb des Markdown-Editors den gesamten aktuellen Arbeitsstand aus Text, Handschrift und Arbeitsblättern
- Strg+Tab und Strg+Umschalt+Tab wechseln zyklisch durch offene Notizen; Strg+W schließt nur den aktiven Notiz-Tab und niemals versehentlich das Electron-Fenster
- Notiz-Tabs sind vollständig per Tastatur und Screenreader bedienbar, zeigen ihren gesamten Pfad, scrollen beim Wechsel ins Blickfeld und lassen sich per Mittelklick schließen
- die linke Werkzeugleiste erklärt ihre Funktionen und Kürzel mit schnellen, theme-sicheren Tooltips; Toolbar-Schalter kommunizieren ihren Zustand zusätzlich semantisch
- Lade-, Fehler- und Leerzustände wurden ruhiger, verständlicher und handlungsorientierter gestaltet, ohne neue schwere Startabhängigkeiten einzuführen
- Statusleiste und Seitenleiste verwenden jetzt klare Aussagen wie „Schreibmodus“, „Gespeichert“ und „Lokal & privat“ statt technischer oder missverständlicher Statusbegriffe
- Meldungen bleiben bei Fehlern länger sichtbar, begrenzen sich auf vier Einträge, sind zugänglich angekündigt und können direkt geschlossen werden
- wichtige Navigations- und Dateibaumtexte sind besser lesbar; Abstände, Fokuszustände, kleine Fenster und alle sechs Themes wurden gemeinsam nachgeschärft
- der echte Electron-Renderingtest prüft zusätzlich direkte Vault-Suche, synchronisierte Suchwerte, Escape, Tabwechsel und sicheres Schließen einzelner Tabs

## 2.23.0

- der lokale, streng validierte Dateibaum-Cache öffnet die Oberfläche jetzt unabhängig von der Antwortzeit eines eingebundenen NAS; erst tatsächliches Lesen oder Schreiben einer Notiz wartet auf die vollständige Vault-Prüfung
- die einmalige Suche nach früheren App-Profilen läuft parallel zur Electron-Initialisierung und wird nach erfolgreichem Abschluss dauerhaft übersprungen
- unmittelbar aufeinanderfolgende Root-Prüfungen desselben sicheren Startvorgangs werden zusammengefasst, wodurch insbesondere SMB-/NFS-Vaults doppelte Netzwerk-Rundreisen vermeiden
- das Aktualisieren einer unveränderten alten Willkommensnotiz liegt nun außerhalb des interaktiven Startfensters
- der CodeMirror-Editor wird direkt nach dem ersten sichtbaren Frame parallel zu Cache- und Dateiarbeit vorgeladen; ein gemeinsames Modul-Promise verhindert doppelte Chunk-Anforderungen
- die nur einmal benötigte Fächerauswahl liegt in einem eigenen, bedarfsgeladenen Modul und vergrößert normale Folgestarts nicht mehr
- eingebettete Handschriftseiten und Arbeitsblätter rendern bei normaler Tastatureingabe nicht mehr unnötig erneut; stabile Referenzen halten ihre Canvas- und Dokumentzustände vollständig unabhängig
- Tab-Zeilen, Ordnersortierungen und LM-Studio-Kontextdaten werden wiederverwendet beziehungsweise nur noch bei tatsächlichem Bedarf berechnet
- die reproduzierbare Messung mit 2.000 Notizen verbessert den Mittelwert von 290 auf 272 ms bis zur Oberfläche und von 664 auf 634 ms bis zum interaktiven Editor; der robuste Median liegt bei 253/605 ms und der Langseitentest mit 2.000 Strichen hält p95 bei 16,7 ms ohne Frame über 25 ms

## 2.22.0

- die Stiftseite verwendet jetzt getrennte Ebenen für fertige und aktive Tinte; während eines Stiftzugs wird nur noch der neue Linienabschnitt gezeichnet, ohne die vollständige Seite pro Frame zu löschen, zu kopieren oder neu aufzubauen
- Undo und Redo teilen unveränderliche Strichdaten sicher zwischen Verlaufsschritten, statt bei jedem Aufsetzen sämtliche Punkte einer langen Seite tief zu kopieren
- Handschrift-Autosave schreibt die kompakte editierbare JSON-Seite im Browser-Leerlauf und erzeugt das hochauflösende PNG nur noch dann, wenn „Seite als Bild einfügen“ tatsächlich gewählt wird
- das Desktop-Dateiformat akzeptiert deshalb sichere JSON-only-Zwischenstände; vorhandene PNG-Vorschauen bleiben unangetastet und explizit eingefügte Markdown-Bilder werden weiterhin vollständig erzeugt und validiert
- grosse bestehende Handschriftseiten lösen beim Öffnen keine sofortige doppelte Vollseitenerkennung mehr aus; dadurch bleibt der Editor nach dem Laden ruhig und reaktionsfähig
- die unsichtbare Suchtranskription erkennt nach neuer Tinte nur den relevanten letzten Schreibkontext, arbeitet in begrenzten Blöcken und läuft automatisch im unfokussierten beziehungsweise minimierten Fenster
- jede neue Stiftberührung oder die Rückkehr zur App unterbricht laufende Hintergrundanalyse, sodass aktive Eingabe immer Vorrang vor Indexierung und lokalem Kontextlernen hat
- Radierer und Durchkritzelpfad verwerfen räumlich entfernte Striche über zwischengespeicherte Grenzen, bevor teure Segmentabstände berechnet werden
- der reproduzierbare Linux-Extremtest umfasst jetzt echten Pointer-Input, 2.000 Striche, Autosave, Suchindex, CPU-Zeit, Frametimes, Heap und den Nachweis, dass Autosave kein PNG neu berechnet
- Renderer, Speicherformat und Hintergrundsteuerung sind plattformneutral; Windows verwendet denselben effizienteren Stift- und Autosave-Code

## 2.21.0

- Linux öffnet grosse lokale und eingebundene Vaults über einen neuen schnellen Verzeichnisdurchlauf, der für reguläre Dateien nicht mehr je einen zusätzlichen Metadatenzugriff ausführt
- ein streng validierter, vaultgebundener Dateibaum-Cache macht Folgestarts sofort nutzbar; ein vollständiger Hintergrundabgleich übernimmt danach externe Änderungen ohne die erste Eingabe zu blockieren
- Updater, Delta-Kryptografie und Rechtschreibwörterbücher werden erst nach dem interaktiven Editor geladen und konkurrieren nicht mehr mit dem sichtbaren App-Start
- Mathematik-Renderer und aufwendige Markdown-Vorschauen werden bedarfsgerecht geladen; normale Notizen müssen diese Pakete beim Start nicht mehr parsen
- reproduzierbare Linux-Electron-Messung mit 2.000 Notizen verbessert die mittlere Zeit bis zur Shell von 316 auf 259 ms und bis zum Editor von 713 auf 629 ms; mit 10.000 Notizen sinkt der Editorstart von 868 auf 749 ms
- ein neuer echter Electron-Renderingtest prüft sechs Themes, Mathematik, Klappbereiche, Einstellungen, Stiftebene, GlyphenWerk und die Mindestgrösse 940 × 640 auf Rendererfehler, Überläufe und falsch positionierte Leisten
- alle Theme-Grundfarben bestehen weiterhin WCAG AA; die gleichen sicheren Ladegrenzen gelten auch im Windows-Build

## 2.20.0

- beim ersten Start erscheint jetzt eine eigene, theme-sichere Fächerauswahl statt ungefragt alle vorgefertigten Ordner anzulegen
- Mathematik, AMAT, Deutsch, Englisch, Physik, Chemie, Biologie, Geschichte, Informatik und Wirtschaft lassen sich einzeln oder gemeinsam auswählen
- AMAT und Wirtschaft sind als neue vorgefertigte Fächer mit eigener Farbe und verständlicher Beschreibung verfügbar
- der Ordner `Eingang` bleibt als klar gekennzeichnete, feste Schnellablage immer dabei; auch ein Start ausschließlich mit Eingang ist möglich
- die Auswahl wird im geschützten Main-Prozess validiert, atomar gespeichert und kann nach einem abgebrochenen Start ohne doppelte oder halbfertige Ordner fortgesetzt werden
- bestehende FaNotes-Vaults und Konfigurationen erhalten den Ersteinrichtungsbildschirm nicht rückwirkend und werden nicht automatisch verändert
- Linux- und Windows-App verwenden denselben Ersteinrichtungsablauf und dieselben Fächervorlagen

## 2.19.0

- die automatisch erzeugte `Willkommen.md` enthält jetzt eine vollständige, direkt ausführbare Einführung in den Handschrift-Workflow von FaNotes
- erklärt werden Schreiben auf der gemeinsamen Papieransicht, Druck- und Stifteinstellungen, automatisches Speichern sowie vollständig handschriftliche Seiten ohne Konvertierungszwang
- eigener Abschnitt für natürliches Löschen per Durchkritzeln, einstellbare Empfindlichkeit, präzisen Radierer und Wiederherstellung mit `Strg+Z`
- Bereichs- und Seitenkonvertierung, automatische Text-/Mathematik-Erkennung, lokale unsichtbare Suchtranskription und Personalisierung mit GlyphenWerk werden verständlich eingeführt
- Mathematik-Löser, Mathematik-Korrigierer und Text-zu-Handschrift erhalten kurze Anwendungshinweise sowie eine kleine Checklisten-Übung zum direkten Ausprobieren
- vorhandene `Willkommen.md`-Dateien werden nur aktualisiert, wenn sie bytegenau der früheren unveränderten FaNotes-Vorlage entsprechen; persönliche Ergänzungen bleiben unangetastet
- Desktop-App und Browser-Vorschau verwenden inhaltlich dieselbe neue Einführung

## 2.18.0

- die Empfindlichkeit der Durchkritzel-Löschung lässt sich unter „Stift & Erkennung“ stufenlos von 0 bis 100 Prozent einstellen
- eine niedrige Empfindlichkeit verlangt längere Gesten mit mehr Richtungswechseln und Tintenüberschneidungen; eine hohe Empfindlichkeit löscht bereits nach einem kürzeren, weiterhin eindeutigen Durchkritzeln
- die gewählte Stufe wird dauerhaft gespeichert und gilt identisch für Stift-, Windows-Ink-, Wayland- und Mauseingaben
- einzelne Durchstreichungen, normale Buchstaben, Wurzelzeichen, vertikale Kratzer und Gesten auf leerem Papier bleiben unabhängig von der Empfindlichkeit geschützt

## 2.17.0

- der automatische Updater überträgt nicht mehr das vollständige Programm, sondern ausschließlich die gegenüber der installierten Version neuen oder geänderten Binärblöcke
- inhaltsabhängige Blockgrenzen erkennen unveränderte Daten auch dann wieder, wenn sich ihre Position innerhalb eines AppImage oder einer App-Komponente verschoben hat
- Linux rekonstruiert das neue AppImage aus lokalen Blöcken und dem kleinen Delta-Paket; erst die vollständige SHA-256-Prüfung gibt den atomaren Austausch frei
- Windows aktualisiert die installierte `app.asar`-Komponente differentiell, ohne den kompletten NSIS-Installer erneut herunterzuladen
- jedes Delta ist exakt an Plattform, Basisversion, Zielversion, Quellhash und Zielhash gebunden und zusätzlich über das Ed25519-signierte Update-Manifest abgesichert
- abgebrochene Delta-Downloads werden per HTTP Range fortgesetzt; eine fehlerhafte lokale Basis, ein manipuliertes Paket oder ein unvollständiger Operationsplan werden vor jeder Installation verworfen
- Linux und Windows behalten einen geprüften Rückfallstand und starten nach dem Wechsel ein achtsekündiges Gesundheitsfenster; bei einem frühen Absturz wird automatisch zurückgerollt
- die Update-Oberfläche zeigt nun die tatsächlich übertragene Delta-Größe und erklärt, dass unveränderte Programmdaten direkt aus der lokalen Installation stammen
- wenn für eine ungewöhnliche oder übersprungene Basisversion noch kein passendes Delta existiert, lädt FaNotes nicht stillschweigend das gesamte Programm neu; der vollständige Installer bleibt ausschließlich als manueller Website-Download verfügbar

## 2.16.0

- Text- und Mathematikerkennung funktionieren jetzt sofort nach der Installation, auch wenn noch kein einziges persönliches GlyphenWerk-Beispiel vorhanden ist
- das vollständig lokale Standardmodell deckt 162 Zeichenklassen ab: Groß- und Kleinbuchstaben, Zahlen, Umlaute, griechische Zeichen, Satzzeichen sowie den gesamten FaNotes-Mathematikkatalog
- kombinierte Referenzen aus eingebetteten Druckformen, einlinigen Roman-Simplex-Zeichen und speziell konstruierten Mathematikpfaden erkennen sowohl originale Symbolformen als auch typische Stiftformen
- robuste Standardvorlagen für unter anderem `0`, `7`, `+`, `=`, Brüche, `√`, `∫`, `∑`, Produkte, Mengenoperatoren, Logikzeichen und Pfeile
- automatische Moduswahl, deutscher beziehungsweise englischer Wortkontext, unsichtbares Suchtranskript, Mathematik-Löser und Mathematik-Korrektur verwenden das Standardmodell auch bei leerem Training
- persönliche GlyphenWerk-Beispiele bleiben getrennt gespeichert und erhalten bei passenden Formen Vorrang; das Standardmodell wird dabei schrittweise durch die eigene Handschrift ergänzt statt ersetzt
- GlyphenWerk-Test und FaNotes-Konvertierungsdialog kennzeichnen klar, ob nur das Standardmodell oder zusätzlich persönliche Beispiele aktiv sind; Training ist nun ausdrücklich optional
- der Standardzeichensatz wird erst beim Öffnen der Handschriftfunktionen geladen, erzeugt keine IndexedDB-Daten und nutzt für schnelle Modellstarts keine unnötige Datenaugmentation
- Lizenzhinweise und vorgeschriebene Anerkennungen für die verwendeten Hershey-Roman-Simplex-Vektordaten liegen den App-Paketen bei

## 2.15.0

- GlyphenWerk ist jetzt als eigener, vollständig sichtbarer Bereich in die FaNotes-Seitenleiste integriert
- Training, Live-Test, Sammlung und ZIP-Export lassen sich direkt in der Seitenleiste wechseln; der aktive Bereich bleibt in Breadcrumb und Statusleiste sichtbar
- FaNotes und das eingebettete GlyphenWerk synchronisieren die aktive Ansicht über eine validierte lokale Nachrichtenbrücke, ohne den Arbeitsbereich neu zu laden
- Trainingsstand und persönlicher Modellfortschritt erscheinen unmittelbar in der Seitenleiste und aktualisieren sich nach jedem gespeicherten oder entfernten Beispiel
- die doppelte GlyphenWerk-Navigation im Arbeitsbereich wurde entfernt, sodass die gesamte Seitenbreite für Zeichenfläche, Erkennungsergebnis und Datensatzverwaltung verfügbar bleibt
- das Seitenleisten-Layout funktioniert mit allen FaNotes-Themes, an der minimalen Fenstergröße sowie mit ein- und ausgeklappter Leiste ohne horizontale Überläufe
- Linux- und Windows-Ausgabe verwenden denselben neuen GlyphenWerk-Arbeitsbereich und dieselbe lokale Erkennungsdatenbank

## 2.14.0

- GlyphenWerk ist jetzt vollständig in FaNotes eingebettet: **Erfassen**, **Erkennung testen**, **Sammlung** und **Exportieren** öffnen sich als eigener Arbeitsbereich ohne separate Website oder App
- ein neuer GlyphenWerk-Button in Seitenleiste und Befehlspalette sowie `Strg+Umschalt+G` öffnen Training und Live-Test direkt aus jeder Notiz
- bestätigte Zeichen, Korrekturen, eigene Symbolklassen und trainierte Hoch-/Tiefstellungen beziehungsweise Integral- und Summengrenzen werden unmittelbar in die FaNotes-Erkennungsdatenbank synchronisiert
- die Synchronisierung ist lokal, fortlaufend und abgesichert: Nachrichten werden an das eingebettete FaNotes-Fenster gebunden, Datensätze streng validiert und nur von GlyphenWerk verwaltete Beispiele automatisch entfernt
- der Stiftmodus führt bei fehlendem Training direkt zu GlyphenWerk; der bisherige ZIP-Import und vollständige ZIP-Export bleiben für Backups und bestehende Datensätze verfügbar
- responsive Einbettung ohne horizontale Überläufe sowie eine gezielte Electron-CSP-Freigabe ausschließlich für das mitgelieferte lokale GlyphenWerk
- reale Electron-Browsertests prüfen alle vier Tabs, die direkte Datenübernahme in IndexedDB, das Entfernen synchronisierter Beispiele und die Layoutbreite
- neue natürliche Löschgeste im Stiftmodus: vorhandene Handschrift mehrfach durchkritzeln und der abgedeckte Wortbereich verschwindet unmittelbar
- identische Geometrie-Erkennung für Windows Ink, Wayland, X11 und Maus durch plattformneutrale Auswertung in Seitenkoordinaten
- robuste Absichtserkennung kombiniert horizontale Richtungswechsel, Pfaddichte, Selbstkreuzungen und echte Berührungen mit bereits vorhandener Tinte
- normale Buchstaben, einzelne Durchstreichungen, Wurzelzeichen, vertikale Gesten und Kritzeleien auf leerem Papier bleiben unverändert als Zeichnung erhalten
- getrennt geschriebene Buchstaben, Punkte und Querstriche sowie vollständig verbunden geschriebene Wörter werden gemeinsam als abgedeckter Wortbereich entfernt
- jedes Durchkritzeln ist ein einzelner Undo-/Redo-Schritt; Erkennungsresultat, unsichtbares Suchtranskript, Autospeicherung und Canvas-Cache werden anschließend korrekt aktualisiert
- neue deterministische Gestentests schützen Wortgrenzen, benachbarte Zeilen, verbundene Schrift und die wichtigsten Fehlaktivierungsfälle

## 2.13.0

- vollständige Windows-10/11-x64-Ausgabe mit derselben Oberfläche und demselben Funktionsumfang wie Linux: Markdown-Vault, gemeinsame Tastatur-/Stiftseite, Handschrifterkennung, Arbeitsblätter, Mathematik, Text-zu-Handschrift und LM Studio
- nativer Windows-Benutzerinstaller mit Startmenü- und Desktop-Verknüpfung sowie eine einzelne portable Windows-EXE ohne Installationspflicht
- plattformneutraler Updatekern wählt strikt den passenden Linux- oder Windows-Kanal, validiert Dateiname und Downloadadresse und blockiert plattformfremde Manifeste
- Windows-Updates werden per Ed25519-signiertem Manifest angeboten, unterbrechbar heruntergeladen und vor dem lautlosen NSIS-Upgrade vollständig über Größe und SHA-256 geprüft
- Linux-AppImage-Updates behalten ihren atomaren Austausch und Rückfallpfad unverändert; Update-Einstellungen beschreiben nun das aktuelle Betriebssystem korrekt
- Website mit automatisch vorausgewähltem Windows-/Linux-Download, sichtbarem Plattformumschalter, getrennten Installer-/Portable-Karten und plattformspezifischen Installationsanleitungen
- Release-API erkennt vollständige Windows- und Linux-Paketsätze unabhängig, liefert getrennte signierte Plattformmanifeste und unterstützt Range-Downloads für alle vier Formate
- Windows-spezifische Regressionstests prüfen Manifestbindung, manipulierte Plattformdaten, Paketnamen, URLs, fortsetzbare Downloads, EXE-Hash und Installerstartargumente

## 2.12.0

- Editor-Eingaben werden in kurzen, verlustfreien Paketen an React und die Autospeicherung übergeben; Speichern, Tabwechsel und Beenden schreiben den letzten Stand weiterhin sofort synchron fest
- die Stiftansicht hält alle abgeschlossenen Striche in einem separaten Canvas-Cache und zeichnet pro Eingabeframe nur den gerade aktiven Strich neu
- zwischengespeicherte Zeigergeometrie und gemeinsam verarbeitete Radierer-Punkte vermeiden Layout-Abfragen und wiederholtes Filtern für jedes einzelne Coalesced Pointer Event
- PNG-Exportdaten werden zwischen Autospeicherung und unsichtbarer Suchtranskription wiederverwendet, statt dieselbe hochauflösende Seite mehrfach zu rendern und zu codieren
- automatische Handschrifttranskription startet nur nach echten Tintenänderungen im Browser-Leerlauf, pausiert in verborgenen Fenstern und verändert die aktive Eingabereaktion nicht
- Dateibaum, Formatierungsleiste, Zeichenfläche, Wortzählung und Theme-Farbvariablen vermeiden unnötige React-Neuberechnungen beim Schreiben
- Chromium drosselt Hintergrundfenster; dekorative Animationen pausieren ohne Fokus und die native Rechtschreibprüfung wird bei deaktivierter Option tatsächlich abgeschaltet
- ein neuer Effizienz-Regressionscheck bündelt 1.000 simulierte Editor-Ereignisse auf einen React-Snapshot und weist im Langseitenmodell 94,9 % weniger wiederholte Strichdurchläufe nach
- reale Browserprüfungen decken schnelle Tastatureingabe, Autospeicherung, lange Stiftbewegungen und die Fokus-/Energiedrosselung ohne Laufzeitfehler ab

## 2.11.0

- neuer **Mathe-Korrigierer** direkt in der Stift-Toolbar mit frei aufziehbarer Auswahl für komplette mehrzeilige Gleichungs- und Termumformungen
- räumliche Zeilensegmentierung hält Brüche, Wurzeln sowie Hoch- und Tiefstellungen in ihrem jeweiligen Rechenschritt zusammen
- lokale symbolische Prüfung vergleicht Terme, Gleichungsreste und vollständige Lösungsmenge und stoppt sichtbar beim ersten beweisbaren Fehler
- präzise Markierung der veränderten Handschriftstelle; verlorene oder unzulässig hinzugefügte Lösungen werden als fehlerhafte ganze Zielzeile hervorgehoben
- erkannte Rechenzeilen, Erkennungssicherheit und Begründung jedes Übergangs erscheinen in einem theme-sicheren Prüfpanel und lassen sich vor einer erneuten Analyse korrigieren
- dreistufige Sicherheitslogik: Grün für bewiesene Äquivalenz, Rot nur für widerlegte Schritte und Gelb für unsichere Erkennung, Definitionslücken oder lokal nicht entscheidbare Umformungen
- vollständige Rechnungen bleiben auf dem Gerät; die Algebra läuft mit Zeitlimit in einem separaten Worker und blockiert die Oberfläche nicht
- Regressionstests decken lineare und quadratische Gleichungen, verlorenes ±, Brüche, Wurzeln, Termumformungen, Mehrvariablen-Sicherheit, Parser-Schutz, Zeilentrennung und Fehlermarker ab

## 2.10.0

- neuer ein- und ausschaltbarer **Mathe-Löser** direkt in der Stift-Toolbar; ein Doppeltipp auf handschriftliche Mathematik öffnet die passenden Aktionen
- räumliche Ausdrucksauswahl hält normale Terme, Hoch- und Tiefstellungen, Wurzeln sowie gestapelte Zähler, Bruchstrich und Nenner zuverlässig zusammen
- vollständig lokale symbolische Rechenengine zum Vereinfachen und Ausrechnen von Termen, Lösen von Gleichungen, Ausmultiplizieren und Faktorisieren
- lineare und quadratische Gleichungen erzeugen verständliche Zwischen- und Ergebniszeilen; Variablen lassen sich bei Ausdrücken mit mehreren Unbekannten gezielt auswählen
- erkannter Ausdruck, Handschriftsicherheit und mathematische Vorschau werden vor dem Rechnen angezeigt; Fehlinterpretationen können direkt korrigiert werden
- abgesicherter Mathematikparser mit Zeichen- und Funktionsfreigabe, Längen-, Verschachtelungs- und Exponentengrenzen sowie hartem Zeitlimit in einem isolierten Worker
- Lösungen werden automatisch mit der persönlichen Text-zu-Handschrift-Engine als normale editierbare Stifttinte rechts oder in der nächsten Zeile fortgesetzt
- automatische Ausgabeanordnung übernimmt Schriftgröße, Zeilenabstand und bevorzugte Fortsetzungsposition aus bisherigen Lösungen – auch über Notizen hinweg
- klare Rückmeldung bei fehlenden persönlichen Trainingszeichen oder zu wenig Seitenplatz; Undo/Redo, Radierer, Autospeicherung und Suchtranskript bleiben vollständig integriert
- die große Algebra-Engine bleibt aus dem Startpfad ausgelagert; Regressionstests prüfen Brüche, Wurzeln, Gleichungen, Transformationen, Parser-Schutz, Auswahl und Handschriftpositionierung

## 2.9.0

- neuer **Text → Handschrift**-Modus direkt in der gemeinsamen Papier- und Stiftansicht
- eingegebener oder eingefügter Text wird aus den persönlichen GlyphenWerk-Strichdaten aufgebaut und nicht durch eine generische Handschrift-Schriftart ersetzt
- jeder Buchstabe variiert behutsam durch wechselnde persönliche Vorlagen, Form, Breite, Höhe, Neigung, Grundlinie, Druck und Strichstärke
- wiederholte Zeichen sehen dadurch individuell aus; **Neu variieren** erzeugt kontrolliert eine weitere natürliche Fassung
- kursive Übergänge verbinden geeignete Buchstaben innerhalb eines Wortes anhand ihrer tatsächlichen Ein- und Austrittsrichtung; Leerzeichen und Zeilenumbrüche trennen zuverlässig
- Live-Seitenvorschau mit Schriftgröße, Zeilenabstand, Variationsstärke, Verbindungsmodus, Einfügeposition und optionaler automatischer Anpassung an den freien Seitenplatz
- sicherer Wort- und Zeilenumbruch, Umlaut-Fallback aus persönlichen Grundglyphen, Schutz vor Seitenüberlauf sowie klare Anzeige noch nicht trainierter Zeichen
- erzeugte Handschrift bleibt normale editierbare Stifttinte mit Undo/Redo, Radierer, Autospeicherung und bekanntem Text im lokalen Suchtranskript
- neue deterministische Regressionstests für Zeichenvariation, Vorlagenwechsel, Verbindungen, Wortgrenzen, Umbruch, fehlende Zeichen, Auto-Fit und unveränderte Trainingsdaten

## 2.8.0

- deutsches und englisches Wortkontext-Modell bewertet Zeichenalternativen gemeinsam statt jeden Buchstaben ausschließlich isoliert zu wählen
- häufige Wörter lösen visuell ähnliche Zeichen auf, beispielsweise `Test` statt `Tost`, sofern beide Zeichenformen optisch plausibel sind
- Zeichen, die der Wortkontext geändert hat, werden in der Konvertierungsansicht sichtbar mit **Kontext** markiert
- automatische lokale Verbesserung 1,8 Sekunden nach der letzten Stifteingabe, ohne sichtbare Handschrift oder Markdown ungefragt zu verändern
- sichere Kontextentscheidungen und sehr eindeutige Zeichen aus bekannten Wörtern werden als persönliche Trainingsbeispiele übernommen
- Schutz vor Selbstverstärkung falscher Vermutungen durch Mindestabstand zum zweitbesten Wort, visuelle Plausibilitätsgrenze und exakte Wörterbuchprüfung
- automatisch erzeugte Beispiele werden dedupliziert, global begrenzt und auf höchstens 16 Beispiele je Zeichenklasse beschränkt
- GlyphenWerk-Beispiele und manuell bestätigte Korrekturen haben beim Modellbau immer Vorrang vor automatisch erzeugten Kontextbeispielen
- Regressionstests für `Test`/`Tost`, Deutsch und Englisch, unplausible Alternativen, unbekannte Wörter sowie echte IndexedDB-Persistenz

## 2.7.0

- einklappbare Markdown-Bereiche mit `<details>` und `<summary>` funktionieren direkt in der einzigen Obsidian-artigen Live-Ansicht
- neuer Formatierungsbutton **Einklappbarer Bereich** fügt einen vollständigen, sofort nutzbaren Klappbereich ein
- Inhalte in Klappbereichen unterstützen weiterhin Markdown, Tabellen, Aufgabenlisten, Links, Wikilinks und KaTeX-Mathematik
- Standard-Markdown, GitHub-Flavored Markdown und sichere HTML-Klappbereiche werden gemeinsam gerendert; Skripte und gefährliche Attribute bleiben gefiltert
- automatisierte Markdown-Prüfung deckt Überschriften, Textformatierung, Links, Listen, Aufgaben, Tabellen, Zitate, Mathematik und Klappbereiche ab
- sichtbarer Einklapp-Button direkt in der Ordner-Seitenleiste; erneutes Öffnen bleibt über Dateisymbol, Statusleiste und Befehlspalette möglich
- die Stift-Schnellleiste bleibt im Schreibmodus fest am unteren Fensterrand und bewegt sich nicht mehr mit dem Seiteninhalt
- **GlyphenWerk-Training** erscheint in der Stift-Schnellleiste ausschließlich, solange noch keine Trainingsbeispiele importiert wurden

## 2.6.0

- Startfenster erscheint sofort mit einer leichten FaNotes-Startfläche statt erst nach dem vollständigen Electron-Rendern
- lokales Profil wird ohne blockierende NAS-Zugriffe geladen; die sichere Vault-Prüfung läuft erst bei der eigentlichen Dateiabfrage
- ein nicht erreichbarer NAS-Vault blockiert die Oberfläche und die Vault-Auswahl nicht mehr
- Markdown-Editor, KaTeX und Browser-Vorschau werden nicht länger in den kritischen ersten Startmoment gedrückt
- Auto-Updater startet zeitversetzt, damit Oberfläche, Vault und Eingabe beim Start Vorrang haben
- V8-Codecache wird bereits ab dem ersten erfolgreichen Lauf ohne Aufwärmwartezeit verwendet
- neuer zweistufig bestätigter **App-Daten zurücksetzen**-Button unter **Einstellungen → Erweitert**
- Reset löscht Einstellungen, persönliches Handschrifttraining, Browserdaten, Caches und Update-Downloads vollständig und startet FaNotes neu
- Markdown-Notizen, Bilder, PDFs, Zeichnungen und Handschriftseiten im Vault bleiben bei einem App-Reset ausdrücklich erhalten
- offene Notizen, Handschrift und Arbeitsblätter werden vor dem Reset sicher gespeichert; bei einem Speicherfehler wird der Reset abgebrochen
- isolierter Reset-Test verhindert, dass alte App-Profile nach einem bewussten Reset ungewollt wieder importiert werden

## 2.5.0

- vollständiger Linux-Auto-Updater über die neue API auf `fanotes.fasrv.ch`
- automatische Prüfung kurz nach dem Start und anschließend alle sechs Stunden
- fortsetzbare Hintergrunddownloads mit sichtbarem Fortschritt und manueller Schnellaktion
- Ed25519-signierte Update-Manifeste sowie SHA-256-Prüfung nach dem Download und unmittelbar vor der Installation
- Schutz vor manipulierten Metadaten, fremden Downloadhosts, Downgrades und wieder eingespielten älteren Releases
- atomarer AppImage-Austausch mit Rückfall auf die bisherige Version, falls die neue App während des Starttests unerwartet endet
- sichere verwaltete Benutzerinstallation unter `~/.local/opt/FaNotes`, falls die gestartete App nicht direkt aktualisiert werden kann
- Installation beim Beenden erst nach erfolgreichem Speichern von Markdown, Handschrift, Arbeitsblättern und Einstellungen
- neuer Update-Bereich mit Status, Release Notes, Sicherheitsdetails und frei wählbarer Automatik

## 2.4.0

- **Training importieren** in den Einstellungen öffnet unmittelbar den nativen ZIP-Dateiwähler, ohne Umweg über die Stiftansicht
- importierte GlyphenWerk-Daten werden sofort in das aktive lokale Erkennungsmodell und eine bereits geöffnete Handschriftseite übernommen
- neue Schnellaktion **Seite konvertieren** für die komplette Handschrift einer Notizseite
- neue Schnellaktion **Bereich konvertieren** mit frei aufziehbarem Auswahlrahmen direkt auf dem Papier
- nur Striche innerhalb des ausgewählten Bereichs werden erkannt; Auswahl und Strichanzahl bleiben während der Ergebnisprüfung sichtbar
- Bereichsauswahl lässt sich per `Esc` abbrechen und meldet leere beziehungsweise zu kleine Auswahlflächen verständlich

## 2.3.1

- native Wayland-Sitzungen deaktivieren standardmäßig Vulkan; Chromium darf danach selbst den kompatiblen GL-/EGL-Pfad wählen
- Chromium-Features `Vulkan`, `DefaultANGLEVulkan` und `VulkanFromANGLE` werden im sicheren Wayland-Standardpfad deaktiviert
- explizite X11-, GPU- und Vulkan-Optionen bleiben als Diagnose- beziehungsweise Expertenauswahl erhalten
- verwaiste Electron-`SingletonLock`-, `SingletonCookie`- und `SingletonSocket`-Symlinks werden vor dem Einzelinstanz-Lock sicher erkannt und entfernt
- aktive Prozesse, normale Dateien, geänderte Locks und nicht eindeutig verwaiste Fremdhost-Locks bleiben unangetastet
- automatisierte Startup-Preflight-Tests für tote, aktive, ungültige und manuell konfigurierte Startzustände

## 2.3.0

- PDF-, PNG-, JPEG-, WebP- und GIF-Dateien als ausfüllbare Arbeitsblätter importieren
- Import wahlweise direkt in die geöffnete Notiz oder automatisch als neue, passend benannte Notiz
- ein- und mehrseitige PDFs lokal und bedarfsgeladen mit PDF.js in der gemeinsamen Papieransicht darstellen
- frei positionierbare, automatisch gespeicherte Textfelder direkt über Bildern und PDF-Seiten
- durchgängige Stiftebene über Markdown und sämtliche Arbeitsblattseiten für handschriftliches Ausfüllen per Grafiktablett
- Originaldateien und validierte Textfeld-Metadaten sicher und atomar unter `.fanotes/worksheets` im Vault speichern
- Antworten vor Notiz-, Vault- und App-Wechsel zusammen mit der Handschrift zuverlässig leeren beziehungsweise persistieren
- Tastenkürzel `Strg+Umschalt+I`, Befehlspaletteneintrag und schneller Importdialog für beide Zielarten

## 2.2.0

- eine einzige Word-artige Papierseite für Tastatur, Maus, Touch und Grafiktablett; kein Wechsel mehr in ein separates Zeichenstudio
- Obsidian-artige Markdown-Live-Ansicht ohne Quell-, Split- oder separaten Lesemodus
- direkte Darstellung von Überschriften, Fett, Kursiv, Code, Links, Aufgaben und KaTeX-Mathematik während der Bearbeitung
- Stiftebenen werden unsichtbar mit der jeweiligen Markdown-Datei verknüpft, beim Notizwechsel sicher gespeichert und beim Wiederöffnen automatisch geladen
- optionale Konvertierung und unsichtbare Hintergrundtranskription bleiben direkt auf derselben Seite verfügbar
- Zeichen- und Editorzustand werden vor Notiz-, Vault- und App-Wechsel zuverlässig geleert beziehungsweise persistiert
- Start-CSS und initiales JavaScript weiter verkleinert; Schriften, KaTeX, Editor, Handschrift, Suche, Einstellungen, Inspektor und LM Studio werden gestaffelt geladen
- alte Zeichenbibliothek, Zeichenstudio-Styles und sämtliche Editoransichts-Schalter entfernt

## 2.1.2

- alle sechs konkreten Farbschemata vollständig auf lesbare Text-, Status- und Flächenkontraste abgestimmt
- Klar- und Studierzimmer-Akzente überarbeitet; schwache Rahmen, Sekundärtexte und Zustandsfarben verstärkt
- frei wählbare Akzentfarben werden automatisch gegen sämtliche Theme-Flächen auf WCAG-AA-Lesbarkeit korrigiert
- kontrastsichere Beschriftungen auf Akzent-Schaltflächen, Farbfeldern, Fokusrahmen und Auswahlen
- themefeste Darstellung für Markdown-Editor, LM Studio, Zeichnungsbereich, Theme-Vorschau, Scrollleisten und Wissensgraph
- neue automatisierte Theme-Prüfung verhindert künftig Textkontraste unter 4,5:1

## 2.1.1

- Startfenster wird nicht mehr durch Profilübernahme und Vault-Vorbereitung blockiert
- initiales JavaScript-Bundle durch bedarfsgeladenen Editor, Markdown-Renderer, KaTeX und Zusatzbereiche um knapp 80 Prozent verkleinert
- Vault-Verzeichnisse werden mit begrenzter paralleler Dateisystemabfrage deutlich schneller eingelesen, besonders auf einem NAS
- kurzfristig gültige Vault-Prüfungen vermeiden redundante Netzwerkzugriffe, ohne die Pfadsicherheitskontrollen der Dateioperationen zu entfernen
- die Gliederung startet geschlossen, damit die Seiten-Scrollleiste am rechten Fensterrand liegt; sie bleibt über die Toolbar erreichbar
- breitere und stabil reservierte Scrollleiste ohne springende Inhaltsbreite

## 2.1.0

- neuer persistenter Automatikmodus für die Handschrifterkennung
- parallele Text- und Mathematikanalyse mit Auswahl anhand von Wortstruktur, Symbolen und räumlichen Formellayouts
- Brüche, Wurzeln, Operatoren, Hoch-/Tiefstellungen sowie Integral- und Summengrenzen beeinflussen die Modusentscheidung
- erkannter Modus, Entscheidungssicherheit und Grund werden direkt im Konvertierungsbereich angezeigt
- zuletzt erkannter Modus wird für mehrdeutige Eingaben gespeichert; Text und Mathematik bleiben manuell auswählbar
- bestehende Installationen wechseln einmalig auf Automatik und behalten ihren bisherigen Modus als sicheren Kontext

## 2.0.0

- vollständiges Rebranding zu FaNotes
- neue App-, Paket-, Launcher-, Binary- und Artefaktnamen für Arch Linux
- automatische, überschreibungsfreie Übernahme vorhandener Konfiguration und persönlicher Handschrift-Datenbanken
- vorhandene Vaults und der frühere interne Kompatibilitätsordner bleiben durch automatische Migration weiter nutzbar

## 1.3.0

- lokale LM-Studio-Integration mit automatischer Modellliste und optionalem API-Token
- Mehrfachauswahl für freien Auftrag, Rechtschreibung, Obsidian-Wikilinks, Faktenprüfung, Stil, Markdown-Struktur, Wissensergänzungen, Zusammenfassungen und Lernfragen
- sichere Verbindung ausschließlich zu `localhost` und privaten LAN-Adressen
- vollständige gerenderte und rohe Markdown-Vorschau vor jeder Übernahme
- bestehende Vault-Notizen als begrenzter Kontext für verlässliche Wikilinks
- klare Warnung zu Faktenprüfungen ohne Live-Internetzugriff sowie robuste Größen-, Zeit- und Antwortvalidierung

## 1.2.0

- frische oder leere Vaults öffnen sofort eine beschreibbare erste Notiz
- neue A4-Handschrift-Seiten im Hochformat für vollständige handschriftliche Notizen
- Tablet-Seiten speichern sich nach einer kurzen Schreibpause automatisch als PNG und editierbare Strichdaten
- Konvertierung bleibt vollständig optional und öffnet sich nicht mehr automatisch beim Schreiben
- lokale Hintergrundtranskription für Text und Mathematik, ohne die sichtbare Handschrift oder Markdown zu verändern
- Vault-Suche findet auch noch nicht konvertierte Handschrift-Seiten und öffnet den passenden Eintrag direkt
- robuste Pointer-Fläche für Maus, Stift, Druckwerte und Grafiktabletts
- native Linux-Fensterleiste statt einer zusätzlichen App-Leiste, damit Hyprland die Fensterdekoration steuern kann

## 1.1.0

- individuelle Ordnerfarben mit sicherer Speicherung im Vault
- Farben bleiben beim Umbenennen von Fächern und Unterordnern erhalten
- sieben vollständige Designwelten: System, Graphit, Klar, Mitternacht, Wald, Aurora und Studierzimmer
- vier Arbeitsflächen: Klar, Verlauf, Aurora und Papier
- neue Markdown-Leiste für Überschriften, Fett, Kursiv, Durchstreichen, Code, Links, Listen, Aufgaben, Zitate, Tabellen, Mathematik und Trennlinien
- Tastenkürzel für Fett, Kursiv und Links
- Fokusmodus zum Ausblenden der Seitenleisten
- verbesserte responsive Darstellung und neue farbige Fachnavigation
- zusätzliche IPC-Validierung und atomare Metadaten-Schreibvorgänge

## 1.0.0

- erste Arch-Linux-Version mit Markdown-Vault, Grafiktablett und lokaler Handschrifterkennung
