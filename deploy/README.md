# Produktivbetrieb auf LXC 202

Geplanter öffentlicher App-Pfad: `https://zeche.duckdns.org:8095/kanndasnoch/`.
Der bestehende HTTPS-Port 8095 bleibt unverändert; Caddy routet ausschließlich diesen neuen
Pfad zum lokal gebundenen Node-Prozess. Der bisherige Netzkarte-Dienst bleibt der Fallback.

## Zielzustand

- Code: `/opt/kanndasnoch-publisher`, Eigentümer `root`, für den Dienst lesbar
- Laufzeitdaten: `/var/lib/kanndasnoch-publisher`, Eigentümer `kanndasnoch-publisher`, Modus `0700`
- Konfiguration: `/etc/kanndasnoch-publisher.env`, Eigentümer `root`, Modus `0600`
- Dienst: `/etc/systemd/system/kanndasnoch-publisher.service`
- Listener: ausschließlich `127.0.0.1:8787`
- Öffentlicher Zugang: ausschließlich über Caddy und HTTPS

## Verbindliche Reihenfolge

1. Composio-Projektschlüssel mit minimalem Umfang anlegen und ausschließlich in der Env-Datei speichern.
2. TikTok-Custom-Auth-Konfigurations-ID in derselben Env-Datei hinterlegen.
3. Dienstbenutzer, Verzeichnisse, Code und Abhängigkeiten installieren.
4. `npm run check` auf dem Zielsystem ausführen.
5. Systemd-Dienst starten und nur lokal Health/UI prüfen.
6. Bestehende Caddy-Konfiguration sichern, den Pfad aus `caddy-route.caddy` einfügen und `caddy validate` ausführen.
7. Caddy nur nach erfolgreicher Validierung neu laden.
8. Öffentliche Startseite, App, Datenschutz, Anmeldung, OAuth-Rückkehr und Nicht-Dublettierung prüfen.

Die TikTok-App wird erst nach einem echten privaten Sandbox-Ende-zu-Ende-Test und mit ausdrücklicher
Bestätigung zur Prüfung eingereicht.
