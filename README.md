# Kann das noch? Publisher

Einladungsbasierte Web-App für Retro-Tech-Creator, die eigene Videos über TikToks offiziellen OAuth- und Content-Posting-Weg veröffentlichen.

## Funktionsumfang

- einmal nutzbare Creator-Einladungen und sichere Serversitzungen
- getrennte Composio-/TikTok-Verbindung pro App-Benutzer
- aktuelle Creator-Info vor jedem Veröffentlichungsauftrag
- Auswahl nur aus den von TikTok gelieferten Sichtbarkeiten
- Interaktionen standardmäßig aus und nur aktivierbar, wenn TikTok sie aktuell erlaubt
- Prüfung der Videodauer gegen das aktuelle kontobezogene TikTok-Limit
- MP4-, MOV- und WebM-Upload mit Größenlimit und SHA-256-Dublettenschutz
- explizite Rechte-, KI- und Werbekennzeichnungen
- idempotente Veröffentlichungsaufträge und Statusnachweis
- responsive, tastaturbedienbare Oberfläche ohne TikTok-Passwortverarbeitung

## Lokal starten

Voraussetzungen: Node.js 22.22.3 oder neuer.

```powershell
npm ci
Copy-Item .env.example .env
npm start
```

Ohne `COMPOSIO_API_KEY` und `COMPOSIO_TIKTOK_AUTH_CONFIG_ID` startet die App im Einrichtungsmodus. Die Oberfläche ist prüfbar, externe TikTok-Funktionen bleiben jedoch bewusst gesperrt.

Ein Creator-Zugang wird serverseitig angelegt:

```powershell
npm run invite -- --email creator@example.com --label "Creator-Name" --days 7
```

Der ausgegebene Code ist ein Geheimnis, wird nur als SHA-256-Prüfsumme gespeichert und darf nicht in Repository, Protokoll oder Chat kopiert werden.

Der Betrieb unter einem HTTPS-Unterpfad wird unterstützt. Die geprüfte LXC-/Caddy-Vorlage liegt unter [`deploy/`](deploy/README.md).

## Serverkonfiguration

| Variable | Zweck |
|---|---|
| `PORT` / `HOST` | lokale Bindung des Node-Servers |
| `PUBLIC_BASE_URL` | öffentliche HTTPS-Basisadresse der App |
| `ALLOWED_ORIGINS` | kommagetrennte erlaubte Browser-Ursprünge |
| `COMPOSIO_API_KEY` | serverseitiger, eng berechtigter Composio-Projektschlüssel |
| `COMPOSIO_TIKTOK_AUTH_CONFIG_ID` | TikTok Custom-Auth-Konfiguration des Projekts |
| `SESSION_TTL_DAYS` | Laufzeit der App-Sitzung, maximal 90 Tage |
| `MAX_UPLOAD_BYTES` | maximales Dateilimit, standardmäßig 500 MB |
| `DATA_DIR` | nicht öffentliches Verzeichnis für SQLite und Uploads |

## Sicherheitsmodell

- API-Schlüssel und OAuth-Client-Secret liegen ausschließlich serverseitig.
- Der Browser erhält nur einen `HttpOnly`-/`SameSite=Lax`-Sitzungscookie.
- Mutation Requests werden gegen erlaubte Origins und Ratenlimits geprüft.
- Uploads werden auf MIME-Typ, deklarierte und tatsächlich empfangene Größe geprüft.
- Composio darf lokale Dateien ausschließlich aus dem Upload-Verzeichnis lesen.
- Ein Benutzer kann pro identischer Datei genau einen Veröffentlichungsauftrag erzeugen.
- Ein wiederholter Request mit gleichem `Idempotency-Key` liefert den vorhandenen Auftrag und startet keinen neuen TikTok-Upload.
- Der Server akzeptiert ausschließlich fest im Code zugelassene TikTok-Tools.

## Qualitätsprüfung

```powershell
npm run check
```

Der Befehl prüft JavaScript-Syntax und führt alle Node-Tests aus. Die öffentliche API ist zusätzlich in [`openapi.yaml`](openapi.yaml) beschrieben.

## TikTok-Review

Die App darf erst zur TikTok-Prüfung eingereicht werden, wenn alle Punkte in [`review/REVIEW-CHECKLIST.md`](review/REVIEW-CHECKLIST.md) mit einer echten Sandbox-Aufzeichnung belegt sind. Ein Folienvideo oder eine simulierte Oberfläche reicht nicht aus.
