"""Create missing local secret files, never replace existing credentials."""
from pathlib import Path
import os
import secrets

folder = Path(__file__).resolve().parent / '.secrets'
folder.mkdir(exist_ok=True, mode=0o700)
for name in ('api_token', 'bridge_token', 'freshrss_password', 'admin_password'):
    path = folder / name
    try:
        with path.open('x', encoding='utf-8') as handle:
            handle.write(secrets.token_urlsafe(36) + '\n')
        # Compose file secrets must be readable by the unprivileged API process.
        # Keep the parent directory private; never copy this directory into images.
        os.chmod(path, 0o444)
        print('Created ' + name)
    except FileExistsError:
        print('Kept existing ' + name)
