"""Create an isolated loopback CalDAV sandbox. Existing credentials/data are preserved."""
import json
import os
from pathlib import Path
import re
import secrets
import bcrypt

root = Path(__file__).resolve().parents[1]
calendar = root / ".radicale"
fixture = root / ".fixture-calendar"
os.umask(0o077)
calendar.mkdir(mode=0o700, exist_ok=True)
calendar.chmod(0o700)
(fixture / "auth").mkdir(mode=0o700, parents=True, exist_ok=True)
identity = fixture / "auth/server-id"
if not identity.exists():
    identity.write_text("fixture-" + secrets.token_hex(12))
server_id = identity.read_text()
if not re.fullmatch(r"fixture-[a-f0-9]{24}", server_id):
    raise SystemExit("Invalid fixture server identity; existing data was not reset.")
client = calendar / "client.json"
if not client.exists():
    password = secrets.token_urlsafe(32)
    config = {
        "scope": {"connectionId": "fixture-a", "serverId": server_id,
                  "userId": "calendar-user", "workspaceId": "a"},
        "target": {"integrationId": "radicale-local", "label": "Agent Client Test",
                   "collectionUrl": "http://127.0.0.1:5232/agent-test/meetings/",
                   "provider": "caldav", "invitations": "none"},
        "username": "agent-test", "password": password,
    }
    with client.open("x") as stream:
        json.dump(config, stream, indent=2)
    with (calendar / "users").open("x") as stream:
        stream.write("agent-test:" + bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode() + "\n")
if not (calendar / "config").exists():
    (calendar / "config").write_text(f"""[server]
hosts = 127.0.0.1:5232
max_content_length = 65536
[auth]
type = htpasswd
htpasswd_filename = {calendar / 'users'}
htpasswd_encryption = bcrypt
[rights]
type = owner_only
[storage]
filesystem_folder = {calendar / 'collections'}
[logging]
level = warning
""")
print("Radicale sandbox ready. Start npm run calendar:start, then npm run calendar:init.")
print("Credentials are owner-only in .radicale/client.json; never commit or paste that file.")
