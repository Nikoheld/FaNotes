# Schulnetz für FaNotes Companion

Die Telefon-App `ch.fasrv.fanotes.companion` spricht mit dem bestehenden FaNotes-Server. Dieser Ordner beschreibt **jede** Änderung, die auf `fanotes.fasrv.ch` nötig ist. Der Code liegt im Repository und wird mit dem normalen Site-Deploy ausgeliefert:

- `fanotes-site/schulnetz-api.mjs` — HTTP, Verschlüsselung, Poller
- `fanotes-site/schulnetz-logic.mjs` — Parser, Notenrechnung, Diff, Lesesperre
- `fanotes-site/schulnetz-poller.mjs` — optionaler eigener Prozess
- `fanotes-site/schulnetz-logic.test.mjs` — `node --test fanotes-site/schulnetz-logic.test.mjs`
- `fanotes-site/server.mjs` — ruft `schulnetz.handle` auf und startet den Poller
- `fanotes-site/deploy/fanotes-site.service` — neue Umgebung und `ReadWritePaths`
- `fanotes-site/deploy/fanotes-schulnetz-poller.service` — nur falls der Poller **nicht** im Website-Prozess laufen soll

Nginx muss nicht angepasst werden. `location /` reicht `/api/v1/schulnetz` bereits an Node weiter.

## Was der Server tut

AKSA lässt den mobilen OAuth-Client nicht zu (`AADSTS50011`: `authorize.php` ist in der Entra-App nicht als Redirect eingetragen). Die Anmeldung läuft deshalb über die Website: `index.php?pageid=1`, Microsoft, zurück auf `https://www.schulnetz-ag.ch/aksa/`.

Eine PHPSESSID ist an die IP gebunden. Wechselt das Telefon von WLAN auf Mobilfunk, antwortet Schulnetz mit «Ihre IP-Adresse wurde vom System zurückgewiesen». Dieselbe Seite erscheint nach etwa zehn Minuten Untätigkeit («Inaktivitätslimit»). Beides wird erkannt. Die App lädt dann still `index.php?pageid=1` mit den Microsoft-SSO-Cookies. Nur wenn Microsoft ein Passwort oder MFA verlangt, erscheint wieder die Anmeldung.

Der Server benutzt die PHPSESSID des Telefons nicht. Er speichert die Microsoft-Cookies verschlüsselt und macht von seiner eigenen IP aus denselben stillen Login. Danach liest er die HTML-Seiten. Schlägt das fehl, setzt er `needsReauth` und schickt eine Meldung. Das Telefon lädt zusätzlich seinen eigenen Schnappschuss hoch (`PUT /snapshot`), damit die anderen Geräte Daten sehen, auch wenn der Server-Login gerade nicht klappt.

`authorize.php` wird von der App nicht mehr geöffnet. Die REST-Routen bleiben im Code für andere Schulen, sind für `*.schulnetz-ag.ch` aber abgeschaltet.

Der Poller liest alle 3 Minuten (änderbar) und vergleicht mit dem letzten Schnappschuss. Die erste erfolgreiche Lesung erzeugt keine Meldungen. Danach gehen Änderungen an ntfy und an eingetragene UnifiedPush-Endpunkte. Die App hält zusätzlich eine ntfy-Verbindung und prüft per WorkManager mindestens alle 15 Minuten `/changes`.

## Endpunkte

Alle Routen hängen unter `/api/v1/schulnetz` und verlangen denselben Sync-Login wie der Tresor: `Authorization: Bearer <token>` und `X-FaNotes-Account: <32 hex>`.

| Methode | Pfad | Bedeutung |
|---|---|---|
| GET | `/status` | Verbunden, Anzeigename, `needsReauth`, letzte Lesung, Push-Thema, Schalter. Kein Token. |
| PUT | `/link` | Website: `{ mode:"web", baseUrl, deviceId, userAgent, displayName, ssoCookies }`. `ssoCookies` sind nur Microsoft-Hosts, ohne `PHPSESSID`. Ältere REST-Verknüpfungen mit `refreshToken` bleiben für Nicht-AKSA möglich. |
| PUT | `/snapshot` | Normalisierter Schnappschuss vom Telefon. Der Server diff und pusht. Keine Cookies. |
| DELETE | `/link` | Löscht Token, Schnappschuss und Push-Endpunkte. |
| GET | `/snapshot` | Normalisierter Schnappschuss (Noten, Stunden, Prüfungen, Absenzen, Aufgaben, Mitteilungen, Ferien, Kontoauszug, Startseite). |
| GET | `/changes?since=<revision>` | Änderungen seit dieser Revision. |
| PUT | `/settings` | `{ grades, timetable, exams, absences, events }` als Booleans. |
| PUT | `/push-endpoint` | `{ endpoint }` HTTPS-URL eines UnifiedPush- oder ntfy-Ziels, höchstens 8. |
| DELETE | `/push-endpoint` | `{ endpoint }` entfernt eines davon. |
| POST | `/push/test` | Sendet eine Testmeldung. |

`baseUrl` muss HTTPS sein und nach Schulnetz aussehen (`*.schulnetz-ag.ch`, `*.schulnetz.ch`, `*.schulnetz.com`, `schulnetz.*`, `schulnetz.web.app`). AKSA ist `https://www.schulnetz-ag.ch/aksa`.

Antwort `503` auf `PUT /link` heisst: der Token-Schlüssel fehlt. Die App speichert das Token dann nur im E2E-Tresor und genau ein Telefon mit gültigem Lease darf es erneuern. Sobald der Schlüssel steht und die App neu verbindet, übernimmt der Server und die lokale Kopie wird gelöscht.

## Umgebung

| Variable | Standard | Bedeutung |
|---|---|---|
| `FANOTES_SCHULNETZ_DIR` | `/var/lib/fanotes-schulnetz` | Datenverzeichnis, Modus `0700`, Besitzer `www-data` |
| `FANOTES_SCHULNETZ_TOKEN_KEY` | leer | 32 Byte, Base64 oder 64 Hex-Zeichen. Nicht ins Journal schreiben. |
| `FANOTES_SCHULNETZ_TOKEN_KEY_FILE` | `/etc/fanotes/schulnetz-token.key` | Datei mit demselben Schlüssel, Modus `0600`, Besitzer `www-data`. Wird genutzt, wenn die Variable leer ist. |
| `FANOTES_NTFY_URL` | `https://ntfy.sh` | Server, an den Meldungen gehen. Eigenes ntfy ist möglich. |
| `FANOTES_NTFY_TOKEN` | leer | Optionaler Bearer, falls das ntfy-Thema geschützt ist. |
| `FANOTES_SCHULNETZ_POLL_MS` | `180000` | Abstand zwischen zwei Lesungen. |
| `FANOTES_SCHULNETZ_POLL` | an | `0` schaltet den Poller im Website-Prozess aus. Dann darf genau der eigene Dienst laufen. |

Schlüssel erzeugen, einmalig:

```bash
sudo install -d -o www-data -g www-data -m 0700 /var/lib/fanotes-schulnetz
sudo install -d -o root -g www-data -m 0750 /etc/fanotes
openssl rand -base64 32 | sudo tee /etc/fanotes/schulnetz-token.key >/dev/null
sudo chown root:www-data /etc/fanotes/schulnetz-token.key
sudo chmod 0640 /etc/fanotes/schulnetz-token.key
```

`www-data` muss die Datei lesen können. Der systemd-Dienst hat `/etc/fanotes` bereits als `ReadOnlyPaths`. Den Schlüssel nicht in die Unit-Datei und nicht in die Shell-History als Argument eines lang lebenden Prozesses stellen. Die Datei reicht.

Ein verlorener Schlüssel macht gespeicherte Tokens unlesbar. Die App muss Schulnetz dann neu verbinden. Es gibt keine Wiederherstellung.

## Speicher

```text
/var/lib/fanotes-schulnetz/
  poller.lock                         PID des einen Pollers
  accounts/<faNotesAccountId>/
    link.json                         verschlüsseltes Refresh- und Access-Token, Gerät, Schalter, Thema
    snapshot.json                     Schnappschuss ohne Geheimnisse
    changes.jsonl                     letzte 200 Änderungen ohne Geheimnisse
```

`link.json` enthält `refresh` und `access` als `{ v, iv, tag, data }` (AES-256-GCM, 12-Byte-IV). Der Klartext steht nicht in der Datei. `snapshot.json` und `changes.jsonl` sind die Daten, die das Telefon anzeigt. Logs schreiben nur Kontopräfix, HTTP-Status und den Host eines fehlgeschlagenen Pushs. `redactSecrets` entfernt Bearer, `refresh_token`, `access_token` und `code_verifier`, falls doch ein Text protokolliert wird.

## Lesen, nichts bestätigen

Erlaubt sind GET auf die mobilen Lese-Routen (`/rest/v1/me`, `grades`, `events`, `exams`, `absences`, `absencenotices`, `vacations`, `notes/homework`, `notes/objectives`, `notifications/push`, `notifications/topics`, `courses`, `certificates/grades`, `lateness`, `config/settings`, `config/lists/absenceNoticeStatus`) plus GET der Webseiten `pageid` 1, 21311, 21111, 21411, 21200, 22202, 22206, 22108 und 21312 und POST an `token.php` nur mit `grant_type=authorization_code` oder `refresh_token`.

Gesperrt, auch wenn ein Client es schickt:

- eSchool und die Seiten 23118, 23100, 23104, 23102, 23182, 23150, 23156
- Abmelden (`pageid=9999`, `action=global_logout`)
- jede URL mit Bestätigen (`bestaetigen`, `isAlreadyConfirmed`, `action=confirm`)
- POST/DELETE von Absenzen
- `POST /rest/v1/me/notifications/token` (kein Firebase-Token an Schulnetz)
- Passwort-Grant und jedes andere Verb als GET/HEAD/POST

Der Poller prüft jede URL, bevor er sie aufruft, und folgt keinen Weiterleitungen auf einen anderen Host. Kontoauszug (`pageid=21411`) und Startseite (`pageid=1`) werden nur per GET gelesen. Liefert Schulnetz dafür eine Login-Seite, bleiben die Felder leer. Es wird keine PHP-Sitzung gespeichert und kein Formular abgeschickt.

## Push

Ohne Google Play und ohne `google-services.json`.

1. Beim Verbinden entsteht ein zufälliges ntfy-Thema. `GET /status` gibt `push.url` zurück, zum Beispiel `https://ntfy.sh/<32 hex>`.
2. Der Server sendet bei einer Änderung ein POST an dieses Thema und an bis zu acht weitere HTTPS-Endpunkte.
3. Die App liest `$FANOTES_NTFY_URL/<thema>/json` in einem Vordergrunddienst, solange «Sofort über ntfy» an ist. Die Meldung erscheint auf dem Kanal «Schulnetz» mit hoher Wichtigkeit.
4. Ist eine UnifiedPush-App installiert (ntfy, Nextcloud, …), trägt «UnifiedPush aktivieren» deren Endpunkt unter `/push-endpoint` ein. Der Server postet den Rohtext dorthin. Verteiler, die Web-Push-Verschlüsselung erzwingen, bekommen hier den Klartext; ntfy nimmt ihn direkt an.
5. WorkManager wiederholt den Abruf von `/snapshot` und `/changes` alle 15 Minuten, auch wenn der Dienst nicht läuft.

FCM ist bewusst nicht eingebaut. Es würde Play-Dienste und ein Firebase-Projekt erzwingen. ntfy kann selbst gehostet werden, indem `FANOTES_NTFY_URL` gesetzt wird. Die App übernimmt die Adresse aus `/status`.

Wer ein privates ntfy will, setzt `FANOTES_NTFY_TOKEN` und schützt das Thema serverseitig. Das Thema selbst ist das Leserecht für die Meldungstexte (Fach und Note, kein Schulnetz-Token). Es ist 128 Bit zufällig und nur mit einem gültigen FaNotes-Login abrufbar.

## Deploy

Auf dem Server, im Verzeichnis des ausgecheckten `fanotes-site`:

```bash
sudo systemctl stop fanotes-site.service
sudo rsync -a --delete --exclude public /opt/fanotes-site/ /opt/fanotes-site.bak/
sudo rsync -a \
  server.mjs schulnetz-api.mjs schulnetz-logic.mjs schulnetz-poller.mjs \
  /opt/fanotes-site/
sudo cp deploy/fanotes-site.service /etc/systemd/system/fanotes-site.service
sudo systemctl daemon-reload
sudo systemctl start fanotes-site.service
sudo systemctl status fanotes-site.service
```

Die Unit braucht danach die neuen `Environment=`-Zeilen und `ReadWritePaths=/var/lib/fanotes-schulnetz`. Ohne den Pfad verweigert systemd das Schreiben und der Poller läuft nicht.

Prüfen, ohne Token zu sehen:

```bash
# 401 ohne Sync-Sitzung ist richtig
curl -sI https://fanotes.fasrv.ch/api/v1/schulnetz/status | head -n 1
journalctl -u fanotes-site.service -n 50 --no-pager
```

Den eigenen Poller **nicht** zusätzlich starten. `fanotes-schulnetz-poller.service` ist nur die Alternative: in `fanotes-site.service` `FANOTES_SCHULNETZ_POLL=0` setzen, dann genau diesen Dienst aktivieren. Eine Sperrdatei lässt den zweiten Prozess aussteigen, aber zwei Schreiber dürfen nicht der Normalfall sein.

Tests vor dem Kopieren:

```bash
node --test fanotes-site/schulnetz-logic.test.mjs
```

## Sicherheit

- Tokens nie loggen, nie in Schnappschuss, Änderungen oder `/status` zurückgeben.
- Schlüsseldatei nicht ins Backup des Webroots und nicht ins Git.
- Der Sync-Bearer reicht, um die Verknüpfung zu ersetzen. Wer die FaNotes-Sitzung hat, kann Schulnetz neu verbinden. Das ist dieselbe Grenze wie beim Tresor-Login.
- Der Server sieht Schulnetz-Inhalte im Klartext, weil er sie vergleichen und zuschicken muss. Notizen bleiben Ende-zu-Ende-verschlüsselt und liegen nicht in diesem Speicher.
- Rate-Limits des Sync-Logins gelten weiter, weil jede Anfrage zuerst `authenticateSyncRequest` durchläuft.
- Ausgehende Verbindungen: `www.schulnetz-ag.ch` (oder die gewählte Schul-Basis) und der ntfy-Host. Beides HTTPS.

## Grenzen

Ein echtes AKSA-Login mit Microsoft-MFA kann hier nicht automatisch geprüft werden. Öffentlich geprüft: `authorize.php` leitet auf einen Redirect, den die Entra-App nicht kennt (`AADSTS50011`). `index.php?pageid=1` leitet auf denselben Microsoft-Login mit dem registrierten Redirect `https://www.schulnetz-ag.ch/aksa/`. Parser folgen der schulNetz-5.14-Struktur aus SchulwareAPI (Kurszeile mit verschachtelten Einzelprüfungen, Absenzen-Tabelle «Datum von», Scheduler-XML). Wenn eine Seite anders aussieht, zeigt die App «Seite konnte nicht gelesen werden» und bietet «HTML teilen».

Die Webseiten für Kontoauszug und Startseite akzeptieren den Bearer oft nicht. Dann zeigt die App den Hinweis statt erfundener Buchungen. Es wird dafür keine zweite Sitzung gebaut, weil die Website nach etwa zehn Minuten ausloggt und wir keine schreibenden Formulare abschicken.

`biometric_required` von `token.php` setzt `needsReauth`. Die App fordert eine neue Microsoft-Anmeldung. Es gibt keinen stillen Bypass.

Hypothetische Noten und der Wunschnoten-Rechner bleiben auf dem Gerät und im FaNotes-Tresor (`.fanotes/schulnetz/hypothetical.json`). Sie werden nicht an Schulnetz gesendet.
