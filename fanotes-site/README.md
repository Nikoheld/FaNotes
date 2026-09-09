# FaNotes Website

Öffentliche Download- und Produktseite für `fanotes.fasrv.ch`.

Unter `/notes/` wird zusätzlich die installierbare FaNotes-Web-App ausgeliefert. Das gebaute Bundle liegt in `public/notes`, speichert Benutzerdaten ausschließlich im Browser und besitzt eine eigene, eng begrenzte CSP für Blob-Arbeitsblätter, Web Worker, eingebettete Schriften sowie lokale AI-Dienste auf `localhost`. OpenAI, Gemini und Anthropic werden über `/api/v1/ai` an feste offizielle Endpunkte weitergeleitet; API-Schlüssel werden weder protokolliert noch gespeichert.

Der Node-Dienst erkennt den neuesten vollständigen FaNotes-Release bei jedem API- und Downloadaufruf automatisch im Ordner:

```text
/mnt/truenas/Fabio/FaNotes-Arch-x86_64
```

Sobald dort ein vollständiger Linux-Satz aus AppImage und portablem Archiv liegt, zeigt die Website ohne Neubau die neue Version, Dateigrößen, Prüfsummen und Änderungen an. Liegen zusätzlich Windows-Installer und portable Windows-App vor, werden sie als eigener Downloadkanal veröffentlicht. `SHA256SUMS`, `CHANGELOG.md` sowie die Installationsanleitungen für Linux und Windows werden gemeinsam ausgeliefert.

## Lokaler Test

```bash
FANOTES_PORT=18185 node server.mjs
curl http://127.0.0.1:18185/api/health
curl http://127.0.0.1:18185/api/release
```

Die Produktion läuft als `fanotes-site.service` unter `www-data` und ist nur an `127.0.0.1:18185` gebunden. Nginx übernimmt TLS, Cloudflare-Origin-Filter, Sicherheitsheader, Reverse Proxy und die effiziente Auslieferung der großen Release-Dateien per internem `X-Accel-Redirect`.

## Private Produktstatistik

Das kennwortgeschützte Dashboard unter `/stats/` zeigt Website-Sitzungen, Web-App- und Desktop-App-Starts sowie echte Paketdownloads. Herkunft wird ausschließlich als Cloudflare-Ländercode erfasst; zusätzlich sind Downloadart, Desktop-Plattform und App-Version verfügbar. Der Dienst schreibt nur tägliche Summen nach `/var/lib/fanotes-analytics/aggregates.json`. IP-Adressen, Cookies, Gerätekennungen und einzelne Rohereignisse werden nicht gespeichert. Öffentliche Zählereignisse sind größen- und ratenbegrenzt, während Dashboard und Summary-API durch Nginx Basic Auth geschützt bleiben.

## Optionales Web-Vault-Backup

FaNotes Web kann unter **Einstellungen → Dateien & Vault** eine zusätzliche Server-Kopie aktivieren. Neue Tresore benötigen einmalig den privaten Einrichtungs-Code aus `/etc/fanotes/backup-enrollment-token`; der Browser speichert diesen Code nicht. Jeder Tresor erhält danach einen eigenen hochentropischen Wiederherstellungscode. Auf dem Server liegt nur dessen Scrypt-Ableitung, nicht das verwendbare Geheimnis.

Die Daten liegen außerhalb des Webroots unter `/var/lib/fanotes-backups`, gehören ausschließlich `www-data` und werden nie als frei gewähltes Archiv entpackt. Die API akzeptiert nur begrenzte FaNotes-JSON-Strukturen sowie PNG, JPEG, WebP, GIF und PDF. Alle Medien durchlaufen ClamAV vor und nach der Verarbeitung. Bilder werden dekodiert, auf sichere Abmessungen geprüft und ohne Metadaten neu erzeugt. PDFs müssen qpdf bestehen, werden normalisiert und bei JavaScript, Formularen, eingebetteten Dateien oder externen Aktionen verworfen. Generierte SHA-256-Namen, Pfadnormalisierung, Herkunftsprüfung, Quoten und Ratenlimits begrenzen zusätzlich Traversal, Polyglots und Speichermissbrauch. Kann ein Scanner oder Konverter nicht sicher arbeiten, wird der Upload abgewiesen.

ClamAV benötigt für die erlaubte PDF-Größe `StreamMaxLength 100M` in `/etc/clamav/clamd.conf`. Nach einer Änderung wird `clamav-daemon.service` neu gestartet. Der systemd-Dienst darf nur `/var/lib/fanotes-backups` beschreiben; `/etc/fanotes` und das Release-Verzeichnis bleiben schreibgeschützt.

## Sync-API

`sync-api.mjs` bedient unter `/api/v1/sync` die Ende-zu-Ende-verschlüsselte Synchronisation der Desktop- und Web-App (Einstellungen → Sync). Der Server sieht nie ein Passwort und nie einen Dateinamen oder Inhalt: Der Client leitet aus dem Passwort per PBKDF2 einen Anmeldeschlüssel ab, den der Server zusätzlich mit Scrypt hasht, und einen Einpackschlüssel, der das Gerät nicht verlässt; der eigentliche Tresorschlüssel liegt nur eingepackt auf dem Server. Dateien kommen als AES-256-GCM-Chiffrate unter HMAC-Kennungen an, ihre Metadaten (Pfad, Größe, Änderungszeit) ebenfalls verschlüsselt in einem Header. Ein vergessenes Passwort kann deshalb nicht zurückgesetzt werden.

Die Daten liegen unter `/var/lib/fanotes-sync` (`FANOTES_SYNC_DIR`), gehören `www-data` und sind neben den anderen Datenverzeichnissen der einzige beschreibbare Pfad des systemd-Dienstes: `emails/<sha256(E-Mail)>` zeigt auf ein Konto, `accounts/<id>/account.json` hält Zugangsdaten, KDF-Parameter, eingepackten Schlüssel, Geräte und Sitzungen, `index.json` plus `changes.jsonl` die Dateitabelle mit Revisionen und Tombstones, `blobs/<fileId>` die Chiffrate. Schreibvorgänge sind atomar und je Konto serialisiert. Grenzen: 100 MB je Datei, 4 GB und 50 000 Dateien je Konto, 20 Geräte, Sitzungen verfallen nach 90 Tagen ohne Nutzung (`FANOTES_SYNC_MAX_FILE_BYTES`, `FANOTES_SYNC_QUOTA_BYTES`, `FANOTES_SYNC_MAX_FILES`). `prelogin`, `register`, `login`, Passwortwechsel und Kontolöschung sind je Adresse bzw. Konto ratenbegrenzt; unbekannte E-Mail-Adressen erhalten einen deterministischen Schein-Salt, damit der Endpunkt nicht verrät, welche Adressen ein Konto haben. Nginx reicht Bodies unter `/api/v1/sync/` ungepuffert mit 110 MB Limit an Node weiter (`deploy/fanotes-fasrv.conf`). Entwurf und Prüfungen: `fanotes/docs/SYNC.md`, `npm run check:sync` im App-Repository.

## Update-API

Die Apps fragen Stable oder Beta plattformspezifisch über folgende APIs ab:

```text
GET /api/v1/updates/linux-x64?current=2026.7.1&channel=stable
GET /api/v1/updates/windows-x64?current=2026.7.2-beta.1&channel=beta
```

Stable berücksichtigt ausschließlich vollständige Releases; Beta berücksichtigt zusätzlich neuere `-beta.N`-Vorabversionen. Kanalgebundene Paket- und Delta-Pfade verhindern, dass ein Manifest versehentlich Dateien des anderen Kanals lädt. Jedes Manifest enthält die aktuelle Version, Release Notes, Downloadgrößen und SHA-256-Prüfsummen. Es wird nach Sprache und Kanal serverseitig mit Ed25519 signiert; FaNotes enthält ausschließlich den zugehörigen öffentlichen Schlüssel und verwirft unsignierte, veränderte oder für eine andere Plattform beziehungsweise einen anderen Kanal ausgestellte Antworten.
