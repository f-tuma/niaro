"""Provision only the configured local sandbox collection; never create an event."""
import base64
import json
from pathlib import Path
import urllib.error
import urllib.request

root = Path(__file__).resolve().parents[1]
config = json.loads((root / ".radicale/client.json").read_text())
url = config["target"]["collectionUrl"]
if url != "http://127.0.0.1:5232/agent-test/meetings/":
    raise SystemExit("This provisioning script is restricted to the local sandbox.")
auth = base64.b64encode((config["username"] + ":" + config["password"]).encode()).decode()
xml = b'''<?xml version="1.0" encoding="utf-8"?>
<C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop>
<D:displayname>Agent Client Test</D:displayname>
<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
</D:prop></D:set></C:mkcalendar>'''

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect)
try:
    with opener.open(urllib.request.Request(url, data=xml, method="MKCALENDAR", headers={
        "Authorization": "Basic " + auth, "Content-Type": "application/xml; charset=utf-8"
    }), timeout=10) as response:
        if response.status != 201:
            raise SystemExit("Unexpected calendar creation response.")
        print("Created local Agent Client Test calendar. No event created.")
except urllib.error.HTTPError as error:
    if error.code == 405:
        print("Collection already exists; existing events were preserved.")
    else:
        raise SystemExit(f"Calendar setup failed with HTTP {error.code}.") from None
