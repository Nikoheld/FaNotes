# Schulnetz für Kanti+

Die Telefon-App Kanti+ (`ch.fasrv.kantiplus`) spricht mit dem bestehenden FaNotes-Server. Dieser Ordner beschreibt **jede** Änderung, die auf `fanotes.fasrv.ch` nötig ist. Der Code liegt im Repository und wird mit dem normalen Site-Deploy ausgeliefert:

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

Eine PHPSESSID ist an die IP gebunden. Wechselt das Telefon von WLAN auf Mobilfunk, antwortet Schulnetz mit «Ihre IP-Adresse wurde vom System zurückgewiesen». Dieselbe Seite erscheint nach etwa zehn Minuten Untätigkeit («Inaktivitätslimit»). Beides wird nur an diesen Sätzen, an der End-URL (`loginto.php`, Microsoft) oder an einer Seite ohne `pageid` erkannt. Links wie «Abmelden» im Menü einer normalen Seite zählen nicht. Die App lädt die Seiten im selben WebView, das die Anmeldung gehalten hat, und erneuert die Sitzung still höchstens einmal alle paar Minuten. Eine sichtbare Anmeldung wartet, solange eine Lesung läuft, und öffnet `index.php?pageid=1` ohne `id` nur nach einer bestätigten Abmeldung. Ist die Sitzung noch gültig, zeigt der Login-Knopf die Startseite mit der bestehenden `id` und sagt «Bereits bei Schulnetz angemeldet». `Logs teilen` enthält die HTML-Seiten der letzten Lesung.

Die Benachrichtigung «Absenzfrist» ist ein zusätzlicher Schalter `deadlines` in `PUT /settings`. Der Server speichert ihn mit den anderen Schaltern. Liegt in einem hochgeladenen Schnappschuss eine offene Absenz mit `excuseUntil` und die Frist ist heute, morgen oder übermorgen, entsteht genau eine Änderung `deadline:<id>:<datum>`. Dieselbe Id wird nicht erneut gepusht. Der Website-Poller liest die Absenzseite nicht selbst und behält deshalb die Absenzen aus dem letzten Schnappschuss des Telefons. Die erfassten Seiten enthalten keine offene Entschuldigungsfrist, deshalb gibt es dafür kein Beispiel aus echten Daten. Eigene Noten, Fachfarben, Abzeichen, ausgeblendete Lektionen (`.fanotes/schulnetz/hidden-lessons.json`) und die Darstellung (`.fanotes/schulnetz/desk.json`: Theme, Startseite, Stundenplan, Noten, Widget) liegen im E2E-Tresor, nicht im Schulnetz-Speicher. Es gibt keine öffentliche Rangliste. `loginto.php?mode=17` ist ein fehlgeschlagener OAuth-Handshake: die schon gelesenen Seiten bleiben sichtbar, danach folgt genau ein stiller Login und ein erneuter Versuch der fehlgeschlagenen Seite. Nur wenn Microsoft ein Passwort oder MFA verlangt, erscheint wieder die Anmeldung.

Der Server benutzt die PHPSESSID des Telefons nicht. Er speichert die Microsoft-Cookies verschlüsselt, entfernt `PHPSESSID` daraus und macht von seiner eigenen IP aus denselben stillen Login. Danach liest er die HTML-Seiten. Schlägt das fehl, setzt er `needsReauth` und schickt eine Meldung. Das Telefon lädt zusätzlich seinen eigenen Schnappschuss hoch (`PUT /snapshot`). Dieser Upload setzt `needsReauth` zurück, damit eine lebende Sitzung auf dem Telefon nicht vom Server-Login verdeckt wird.

`authorize.php` wird von der App nicht mehr geöffnet. Die REST-Routen bleiben im Code für andere Schulen, sind für `*.schulnetz-ag.ch` aber abgeschaltet.

Die Notenseite (`pageid=21311`) hat pro Fach eine Spalte bzw. Zeile «Notendurchschnitt» / «Aktueller Durchschnitt». Das ist der Fachschnitt, keine Einzelprüfung. Parser, Schnappschuss und Diff ignorieren diese Zeilen; gespeicherte Schnappschüsse mit einer künstlichen Note «Durchschnitt» werden still bereinigt und erzeugen keinen Push.

Der Poller liest standardmässig jede Minute (`FANOTES_SCHULNETZ_POLL_MS=60000`) und vergleicht mit dem letzten Schnappschuss. Eine Minute hält die Website-Sitzung lebendig (Schulnetz trennt nach etwa zehn Minuten Untätigkeit) und bringt eine neue Note oder einen Ausfall in der Regel in unter einer Minute aufs Telefon, sobald FCM zustellt. 30 Sekunden geht per Umgebungsvariable, belastet Schulnetz aber stärker; unter 30 Sekunden ist nicht vorgesehen. Die erste erfolgreiche Lesung erzeugt keine Meldungen. Danach schickt der Server eine Data-Message `{ event: "sync" }`, hochprior nur wenn die Änderung eine Note, Prüfung, Absenz, Frist oder Mitteilung ist. Ein reiner Stundenplan-Wechsel weckt das Telefon nicht. Das Telefon holt nur `/changes` und zeigt die Meldung selbst. Es hält keinen Vordergrunddienst. WorkManager prüft nur, wenn FCM fehlt oder 12 Stunden lang kein Push kam, dann etwa alle 6 Stunden. Ausgeblendete Lektionen liegen im Tresor und lösen auf dem Telefon keine Stundenplan-Pushs aus.

## Endpunkte

Schulnetz-Daten hängen an einer Kanti+-Identität. Ein FaNotes-Konto benutzt `Authorization: Bearer <token>` und `X-FaNotes-Account: <32 hex>`. Ohne FaNotes legt die App ein anonymes Gerätekonto an (`POST /guest`, kein E-Mail, kein Passwort) und schickt danach `Authorization: Bearer <token>` mit `X-Kanti-Guest: <32 hex>`. Die übrigen Routen sind für beide Identitäten dieselben. Adopt und Detach laufen nur mit einem FaNotes-Login und rufen weder Diff noch FCM auf, damit eine schon gemeldete Note nicht noch einmal gepusht wird.

| Methode | Pfad | Bedeutung |
|---|---|---|
| POST | `/guest` | Legt ein anonymes Konto an und gibt `{ accountId, token }` einmal zurück. Höchstens 30 Anfragen pro Minute und Adresse. |
| DELETE | `/guest` | Nur mit `X-Kanti-Guest`. Löscht Schulnetz-Link, Token, Schnappschuss, Noten-Ledger und Push-Endpunkte dieser Identität. |
| POST | `/adopt` | FaNotes-Login. Body `{ guestAccountId, guestToken }`. Übernimmt die Schuldaten des Gasts. Hat FaNotes noch keinen Link, werden die Dateien kopiert. Hat FaNotes schon einen Link, werden nur Ledger und FCM-Tokens vereinigt, der Schnappschuss bleibt. Kein Push. |
| POST | `/detach` | FaNotes-Login. Body `{ guestAccountId, guestToken, fcmToken }`. Kopiert die Schuldaten auf den Gast und verschiebt nur das FCM-Token dieses Geräts. Bei `mode: web` behält FaNotes die PHP-Sitzung; der Gast öffnet beim nächsten Poll eine eigene aus denselben Microsoft-Cookies. Ein REST-Refresh-Token wird nicht mitkopiert, damit die Rotation nicht das FaNotes-Konto abmeldet. Andere Geräte bleiben am FaNotes-Konto. Kein Push. |
| GET | `/status` | Verbunden, Anzeigename, `needsReauth`, letzte Lesung, Schalter. Braucht dasselbe Bearer-Token wie die übrigen Routen. Ohne Token antwortet der Server mit 401. Kein Schulnetz-Token, kein Push-Thema. |
| PUT | `/link` | Website: `{ mode:"web", baseUrl, deviceId, userAgent, displayName, ssoCookies }`. Gespeichert werden nur `ESTSAUTH`, `ESTSAUTHPERSISTENT`, `ESTSAUTHLIGHT`, `SignInStateCookie` und `x-ms-RefreshTokenCredential` von `login.microsoftonline.com`, `login.microsoft.com`, `login.live.com` und `login.windows.net`. `PHPSESSID` und andere Cookies fallen weg. Die Cookies gelten 14 Tage, danach braucht es eine neue Verknüpfung. Höchstens 5 Verknüpfungen pro Konto und Stunde. Ältere REST-Verknüpfungen mit `refreshToken` bleiben für Nicht-AKSA möglich. |
| PUT | `/snapshot` | Normalisierter Schnappschuss vom Telefon. Der Server diff und pusht. Keine Cookies. Höchstens 60 pro Konto und Stunde. |
| DELETE | `/link` | Trennt Schulnetz. Bei einem FaNotes-Konto wird das Schulnetz-Verzeichnis gelöscht. Beim anonymen Konto bleiben `guest.json` und die Identität, damit die App neu verbinden kann. |
| GET | `/snapshot` | Normalisierter Schnappschuss (Noten, Stunden, Prüfungen, Absenzen, Aufgaben, Mitteilungen, Ferien, Kontoauszug, Startseite). |
| GET | `/changes?since=<revision>` | Änderungen seit dieser Revision. `device` ist optional und der 32-stellige Hash des Push-Tokens. Schulzeilen gelten für das ganze Konto. Eine `probe:`-Zeile kommt nur zurück, wenn `device` genau dieser Hash ist. Eine ältere Testzeile ohne `device` wird nicht ausgeliefert. Poll und Fallback fragen denselben Filter. |
| PUT | `/settings` | Booleans. `enabled` ist der Hauptschalter (standardmässig an). Die älteren Kategorien `grades`, `timetable`, `exams`, `absences`, `events`, `deadlines` bleiben. Feine Schalter: `gradeNew`, `gradeChanged`, `examNew`, `examMoved`, `examCancelled`, `examRoom`, `lessonCancelled`, `lessonChanged`, `appointmentNew`, `messageNew`. Fehlt ein feiner Schalter, gilt die ältere Kategorie. Geänderte oder abgesagte Termine erzeugt der Vergleich nicht, deshalb gibt es dafür keinen Schalter. `guessGrades` ist standardmässig aus. |
| PUT | `/push-token` | `{ token }` FCM-Registrierung, höchstens 8. Kein Notentext. |
| POST | `/push/test` | Schickt `{ event: "test" }`. Die App zeigt die Testmeldung selbst. Höchstens 5 pro Konto und Stunde. |
| POST | `/push/probe` | Zustelltest für das bereits registrierte Gerät. Body `{ token, scenario }`. `scenario` ist `standard` (Standard), `duplicate` oder `reorder`. Dasselbe Bearer-Token wie die übrigen Routen. Der Token muss schon in `fcmTokens` dieses Kontos stehen, sonst 400. Schreibt Teständerungen (`probe:`) mit Korrelation `probe:` plus Uhrzeit und dem Hash des Tokens, nicht dem Token selbst. Die Data-Message `{ event: "sync", probe: "1", serverAt, correlation }` geht nur an dieses Gerät. `reorder` dreht die Reihenfolge, ändert aber nicht die Uhrzeit. Der Schnappschuss, die Noten-Ledger und Schulnetz bleiben unberührt. Höchstens 5 pro Konto und Stunde. Die Antwort nennt `probeRemaining` und `clearRemaining`. Die 25 Sekunden Wartezeit plant das Telefon, nicht der Server. |
| POST | `/push/probe/clear` | Entfernt nur `probe:`-Zeilen dieses Geräte-Hashes aus `changes.jsonl`. Revision, Schnappschuss, Ledger und Baseline bleiben. Schlägt das Schreiben fehl, bleibt `ok` falsch und `failed` wahr; die App sagt das. Eigenes Limit, 5 pro Konto und Stunde, getrennt vom Senden. Dasselbe Bearer-Token und dieselbe Geräteprüfung wie `/push/probe`. |

`baseUrl` muss HTTPS sein. Erlaubt sind genau `www.schulnetz-ag.ch`, `schulnetz-ag.ch` und `schulnetz.web.app`, plus Hosts die auf `.schulnetz-ag.ch`, `.schulnetz.ch` oder `.schulnetz.com` enden. `schulnetz.evil.tld` und `evilschulnetz-ag.ch` sind nicht erlaubt. Weiterleitungen auf IP-Adressen werden verworfen. AKSA ist `https://www.schulnetz-ag.ch/aksa`.

Antwort `503` auf `PUT /link` heisst: der Token-Schlüssel fehlt. Die App speichert das Token dann nur im E2E-Tresor und genau ein Telefon mit gültigem Lease darf es erneuern. Sobald der Schlüssel steht und die App neu verbindet, übernimmt der Server und die lokale Kopie wird gelöscht.

## Umgebung

| Variable | Standard | Bedeutung |
|---|---|---|
| `FANOTES_SCHULNETZ_DIR` | `/var/lib/fanotes-schulnetz` | Datenverzeichnis, Modus `0700`, Besitzer `www-data` |
| `FANOTES_SCHULNETZ_TOKEN_KEY` | leer | 32 Byte, Base64 oder 64 Hex-Zeichen. Nicht ins Journal schreiben. |
| `FANOTES_SCHULNETZ_TOKEN_KEY_FILE` | systemd-Credential `schulnetz-token`, sonst `/etc/fanotes/schulnetz-token.key` | Datei mit demselben Schlüssel. Der Dienst liest sie über `LoadCredential=` und hat kein breites Leserecht auf `/etc/fanotes`. |
| `FANOTES_FCM_SERVICE_ACCOUNT` | systemd-Credential `fcm-service-account`, sonst `/etc/fanotes/fcm-service-account.json` | Dienstkonto für FCM HTTP v1. Fehlt die Datei, wird FCM übersprungen. |
| `FANOTES_SCHULNETZ_POLL_MS` | `60000` | Abstand zwischen zwei Lesungen. 60000 hält die Sitzung und liefert Noten/Ausfälle in unter einer Minute. |
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
  accounts/<identityId>/
    guest.json                        nur beim anonymen Konto: Version und SHA-256 des Tokens, nie der Token
    link.json                         verschlüsseltes Refresh- und Access-Token, Gerät, Schalter, Thema
    snapshot.json                     Schnappschuss ohne Geheimnisse
    notified-grades.json              gesehene Noten, damit ein Umzug keine zweite Meldung auslöst
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

Sofortige Meldungen laufen über Firebase Cloud Messaging (HTTP v1). Die App braucht dafür keine ntfy-App, keinen Vordergrunddienst, keinen eigenen WakeLock und keinen exakten Alarm. Solange der Dienstkontoschlüssel fehlt, überspringt der Server FCM und das Telefon prüft etwa alle 6 Stunden, nur mit Netz und nicht bei niedrigem Akku. Eine Note wird pro Konto genau einmal gemeldet.

1. Die App registriert ihr FCM-Token mit `PUT /push-token`, sobald `google-services.json` im Build liegt und Schulnetz verbunden ist. Höchstens acht Tokens. Ohne die Datei startet die App normal.
2. Eine neue Note, Prüfung, Absenz, Frist oder Mitteilung sendet eine hochpriore Data-Message `{ event: "sync" }` mit `collapse_key` `kanti-sync` und TTL 6 Stunden. Ein reiner Stundenplan-Wechsel sendet nichts. Kein Notentext und kein Titel gehen an Google. Die App liest nur `/changes` (kurzes Timeout) und zeigt die Meldung selbst. Sie startet keinen vollen Sync.
3. Eine abgelaufene Anmeldung sendet `{ event: "reauth" }` (`kanti-reauth`). `POST /push/test` sendet `{ event: "test" }` (`kanti-test`). «Send a test notification» bleibt in den Einstellungen.
4. WorkManager läuft nicht, solange in den letzten 12 Stunden ein Push ankam. Danach, oder ohne Firebase, prüft ein Auftrag etwa alle 6 Stunden `/changes`. Kein 15-Minuten-Takt.
5. Ein Tipp öffnet das Element: Note → Noten, Stundenplan → Tag und Lektion, Prüfung → Prüfungsdetail, Termin → Termine, Absenzfrist → Absenz, Test → Einstellungen. `MainActivity` ist `singleTop`.
6. Das Stundenplan-Widget hat keinen 30-Minuten-Takt. Liegt es auf dem Homescreen, plant die App ein ungenaues `setWindow` auf die nächste Lektionsgrenze und liest dabei nur den lokalen Cache.

### Firebase einrichten

Das Firebase-Projekt legt Fabio an. Der Code läuft, sobald die beiden Dateien da sind.

1. Firebase-Projekt anlegen, Name zum Beispiel `Kanti+` (Projekt-ID zum Beispiel `kantiplus`).
2. Android-App hinzufügen. Paketname exakt `ch.fasrv.kantiplus`. Nicht `ch.fasrv.fanotes.companion` — das ist nur der Kotlin-Namespace.
3. `google-services.json` herunterladen und nicht ins Git legen. Den Dateiinhalt als GitHub-Secret `GOOGLE_SERVICES_JSON` im Repository Nikoheld/FaNotes speichern. CI schreibt `android/companion/google-services.json` nur, wenn das Secret gesetzt ist.
4. Projekteinstellungen → Dienstkonten → neuen privaten Schlüssel erzeugen (FCM HTTP v1).
5. Diese JSON auf dem Server nach `/etc/fanotes/fcm-service-account.json` legen, Modus `0600`, lesbar für `www-data`. Nicht ins Git und nicht ins Journal. Optionaler anderer Pfad: `FANOTES_FCM_SERVICE_ACCOUNT`. Der Standardpfad braucht keine Änderung der systemd-Unit.
6. `sudo systemctl restart fanotes-site.service`, nachdem die Datei liegt.
7. In der App: Einstellungen → Notifications → «Send a test notification».

Bis Schritt 5 fehlt, sendet der Server kein FCM und stürzt nicht ab.

`guessGrades` (Einstellungen → Notifications → Guess the grade, standardmässig aus) wertet die App aus, wenn sie die Meldung zeigt. Die Data-Message nennt die Note nicht. Mit dem Schalter lautet die Meldung «Neue Note in <Fach> – tippen zum Aufdecken» und nennt nur Fach und Prüfungstitel. «Hold to reveal» verlangt einen langen Druck. Schnitt und Pluspunkte auf dem Telefon rechnen unaufgedeckte Noten nicht mit, bis sie aufgedeckt sind. Der Hauptschalter schaltet `guessGrades` nicht um.

Die Schulschalter liegen auf dem Telefon in den privaten Einstellungen und auf dem Server in `link.settings`. Fehlt nach einem Update ein feiner Schalter, gilt die ältere Kategorie. `enabled` fehlt bei einem alten Stand und gilt dann als an. Der Vergleich filtert, bevor eine Zeile in `changes.jsonl` kommt und bevor FCM etwas sendet. Die Nachricht ist nur `data`, ohne `notification`, damit Android sie nicht vor der App anzeigt. Dieselbe Prüfung gilt für die offene App und für den seltenen Fallback. Ein ausgeschalteter Hinweis wird nicht erst gezeigt und danach versteckt. Der Schnappschuss wird trotzdem geschrieben. Die Android-Berechtigung bleibt davon getrennt: ohne sie zeigt das Telefon nichts und löscht die Schalter nicht.

Ein Server ohne diese Fassung ignoriert `enabled` und die feinen Schalter. Die älteren Kategorien `grades`, `timetable`, `exams`, `absences`, `events` und `deadlines` gelten weiter. Steht der Hauptschalter aus und die Kategorien bleiben an, sendet so ein Server weiter. Das Telefon filtert vor dem Anzeigen. Geänderte oder abgesagte Termine erzeugt der Vergleich nicht: eine verschobene oder entfernte Terminzeile bleibt ohne Meldung, und dafür gibt es keinen Schalter. Zustelltests (`probe:`) ignorieren die Schulschalter. Firebase kann eine Meldung nicht absichtlich zurückhalten. Vordergrund und Hintergrund laufen über denselben Weg; die Laufzeit auf einem Telefon misst dieses Repository nicht. 60 Hz und 120 Hz lassen sich hier nicht messen.

Der Stundenplan liest vier Wochen vor und nach der aktuellen Woche sofort, und danach höchstens vier weitere fällige Wochen pro Sync. Eine leere, lesbare Scheduler-Antwort markiert eine andere Woche als gelesen. Die aktuelle Woche wird dabei nur in `weekRead` gesetzt, damit der HTML-Fallback sie noch füllen kann. Ein iCal-Stempel allein gilt nicht als gelesener Stundenplan. Ein Tag innerhalb der bekannten Spanne ohne `weekRead` und ohne Lektion ist nicht frei. Die erste Lektion einer Woche, die vorher nur gestempelt und nie vom Scheduler gelesen wurde, bleibt einmal still. Eine spätere Änderung in einer schon gelesenen Woche meldet sich normal. Der Start-Eintrag der Diagnose ist die Dauer bis zum ersten Frame, nicht die Laufzeit des Prozesses. Eine Heap-Probe speichert den Verbrauch und den Anstieg seit der letzten Probe; der Anstieg ist kein Beweis für ein Leck.

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
- Ausgehende Verbindungen: `www.schulnetz-ag.ch` (oder die gewählte Schul-Basis), `oauth2.googleapis.com` und `fcm.googleapis.com`. Alles HTTPS. Ohne Dienstkonto gibt es keinen FCM-Aufruf.

## Grenzen

Ein echtes AKSA-Login mit Microsoft-MFA kann hier nicht automatisch geprüft werden. Öffentlich geprüft: `authorize.php` leitet auf einen Redirect, den die Entra-App nicht kennt (`AADSTS50011`). `index.php?pageid=1` leitet auf denselben Microsoft-Login mit dem registrierten Redirect `https://www.schulnetz-ag.ch/aksa/`. Parser folgen der schulNetz-5.14-Struktur aus SchulwareAPI (Kurszeile mit verschachtelten Einzelprüfungen, Absenzen-Tabelle «Datum von», Scheduler-XML). Wenn eine Seite anders aussieht, zeigt die App «Seite konnte nicht gelesen werden» und bietet «HTML teilen».

Die Webseiten für Kontoauszug und Startseite akzeptieren den Bearer oft nicht. Dann zeigt die App den Hinweis statt erfundener Buchungen. Es wird dafür keine zweite Sitzung gebaut, weil die Website nach etwa zehn Minuten ausloggt und wir keine schreibenden Formulare abschicken.

`biometric_required` von `token.php` setzt `needsReauth`. Die App fordert eine neue Microsoft-Anmeldung. Es gibt keinen stillen Bypass.

Hypothetische Noten und der Wunschnoten-Rechner bleiben auf dem Gerät und im FaNotes-Tresor (`.fanotes/schulnetz/hypothetical.json`). Sie werden nicht an Schulnetz gesendet.
