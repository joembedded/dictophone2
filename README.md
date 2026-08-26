# DictoPhone AI

Portable PHP-Web-App zum Diktieren, KI-Aufbereiten, Vorlesen, Kopieren und Teilen von Nachrichten.

## Funktionsumfang

- Aufnahme mit `MediaRecorder`, mehreren Browser-Audioformaten und automatischem Stopp nach 60 Sekunden
- automatische Beendigung etwa zwei Sekunden nach einer auf Sprache folgenden Sprechpause
- Neonrahmen am Textfeld, dessen Leuchtbreite den geglätteten Mikrofonpegel visualisiert
- serverseitige Transkription mit `gpt-4o-mini-transcribe`
- Aufbereitung über die Responses API mit `gpt-5.6-terra`, `reasoning.effort: low` und Structured Outputs
- Umsetzung gesprochener Anweisungen zu Sprache, Ton, Duzen/Siezen, Kürze, Emojis, Einfügen und Anhängen
- schnelle Tastaturbearbeitung, Rückgängig-Verlauf, Löschen, Kopieren und Web Share/WhatsApp
- Vorlesen mit `gpt-4o-mini-tts`
- große Schrift bei Viewports unter 1000 Pixel
- installierbare Web-App mit Manifest und App-Shell-Service-Worker

Die Spracherkennung im Browser lässt sich in `assets/vad.js` über Konstanten anpassen. Relevant sind vor allem `SPEECH_RMS_THRESHOLD` für den Sprachpegel und `SILENCE_STOP_MS` für die erlaubte Sprechpause in Millisekunden. Anfangsstille beendet die Aufnahme nicht; der Pausen-Timer startet erst nach erkannter Sprache.

## OpenAI-Key

Die App verwendet ausschließlich die lokale Datei `secret/keys.inc.php`. Sie enthält den echten Schlüssel und wird von `.gitignore` ausgeschlossen.

Für eine neue Installation:

1. `secret/_dummy_keys.inc.php` nach `secret/keys.inc.php` kopieren.
2. Den Platzhalter in `OPENAI_API_KEY` durch den echten Schlüssel ersetzen.
3. Sicherstellen, dass PHP die Datei lesen kann.

Der Ordner `secret` ist für Apache zusätzlich per `.htaccess` gegen HTTP-Zugriffe gesperrt. Bei Nginx oder einem anderen Webserver muss der HTTP-Zugriff auf `/secret/` in dessen Serverkonfiguration ebenfalls verweigert werden.

## Deployment als einzelnes Verzeichnis

Der gesamte Projektordner kann an eine beliebige Stelle innerhalb des Webroots kopiert werden. Es gibt keine absoluten Dateipfade und keine Includes aus anderen Projekten. Mitkopiert werden müssen insbesondere:

- `api/`, `assets/`, `secret/` und `logs/`
- `index.html`, `manifest.webmanifest`, `service-worker.js` und `.htaccess`
- die nicht versionierte Datei `secret/keys.inc.php`

Benötigt werden PHP mit cURL und mbstring, Schreibrechte auf `logs/` sowie HTTPS für Mikrofon-, Zwischenablage- und PWA-Funktionen. `localhost` genügt für die lokale Entwicklung.

## Externe Netzwerkziele

Zur Laufzeit werden nur diese externen Dienste angesprochen:

- `https://api.openai.com` für Transkription, Textaufbereitung und Vorlesen
- `https://wa.me` ausschließlich als WhatsApp-Fallback, falls Web Share nicht verfügbar ist

Alle JavaScript-, CSS-, Icon- und PWA-Ressourcen liegen lokal; es werden keine CDNs, Schriftarten oder Bibliotheken nachgeladen.

## Diagnose-Log

Das JSONL-Log liegt unter `logs/app.log`. Jeder PHP-Request erhält eine gemeinsame `request_id`, die bei einem Browserfehler als Diagnose-ID angezeigt wird.

Pro OpenAI-Anfrage werden mindestens diese Ereignisse geschrieben:

1. `openai_call_started` vor dem Aufruf: Stufe, Endpunkt, Modell, Größenangaben und Timeout
2. `openai_call_completed` nach Erfolg: HTTP-Status, Laufzeit, OpenAI-Request-ID, Response-ID und Tokenverbrauch
3. `openai_call_failed` bei Fehler: cURL-Fehler oder OpenAI-Fehlertyp, Fehlercode, Fehlermeldung und HTTP-Status

API-Schlüssel, Diktat, Entwurf, Transkript und Audioinhalt werden nicht protokolliert. Sobald `app.log` größer als 100 KiB ist, wird ein vorhandenes `app.log.old` gelöscht, `app.log` nach `app.log.old` verschoben und ein neues `app.log` begonnen. Der Logordner ist per `.htaccess` gegen HTTP-Zugriffe gesperrt.

Log unter PowerShell beobachten:

```powershell
Get-Content .\logs\app.log -Wait
```

Nach einer Diagnose-ID suchen:

```powershell
Select-String -Path .\logs\app.log* -Pattern 'DIAGNOSE_ID'
```
