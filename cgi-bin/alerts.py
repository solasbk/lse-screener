#!/usr/bin/env python3
"""
CGI endpoint for managing alert email recipients.
GET  /cgi-bin/alerts.py         → returns alerts.json content
POST /cgi-bin/alerts.py         → adds an email to recipients
DELETE /cgi-bin/alerts.py?email=x → removes an email from recipients
"""
import json, os, sys
from pathlib import Path

ALERTS_FILE = Path("alerts.json")

def load_alerts():
    if ALERTS_FILE.exists():
        return json.loads(ALERTS_FILE.read_text())
    return {"email_recipients": [], "alerts": []}

def save_alerts(data):
    ALERTS_FILE.write_text(json.dumps(data, indent=2) + "\n")

method = os.environ.get("REQUEST_METHOD", "GET")
query = os.environ.get("QUERY_STRING", "")

print("Content-Type: application/json")
print()

if method == "GET":
    alerts = load_alerts()
    print(json.dumps(alerts))

elif method == "POST":
    body = json.loads(sys.stdin.read())
    email = body.get("email", "").strip().lower()
    if not email or "@" not in email:
        print(json.dumps({"error": "Invalid email"}))
    else:
        alerts = load_alerts()
        recipients = alerts.get("email_recipients", [])
        # Normalise existing for comparison
        existing_lower = [e.lower() for e in recipients]
        if email in existing_lower:
            print(json.dumps({"error": "Already exists", "email_recipients": recipients}))
        else:
            recipients.append(email)
            alerts["email_recipients"] = recipients
            save_alerts(alerts)
            print(json.dumps({"ok": True, "email_recipients": recipients}))

elif method == "DELETE":
    # Parse email from query string
    params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
    email = params.get("email", "").strip().lower()
    # URL decode
    import urllib.parse
    email = urllib.parse.unquote(email)
    if not email:
        print(json.dumps({"error": "No email specified"}))
    else:
        alerts = load_alerts()
        recipients = alerts.get("email_recipients", [])
        new_recipients = [e for e in recipients if e.lower() != email]
        if len(new_recipients) == len(recipients):
            print(json.dumps({"error": "Not found", "email_recipients": recipients}))
        else:
            alerts["email_recipients"] = new_recipients
            save_alerts(alerts)
            print(json.dumps({"ok": True, "email_recipients": new_recipients}))

else:
    print(json.dumps({"error": "Method not allowed"}))
