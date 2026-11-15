"""Run real pinned FreshRSS + BFF against a local TLS feed in Docker.

Requires Docker Compose and openssl. Uses a unique project and volumes; leaves
stopped containers/volumes and evidence intact, never runs `down -v` or prune.
"""
from pathlib import Path
import json
import os
import secrets
import shutil
import socket
import subprocess
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import uuid


ROOT = Path(__file__).resolve().parents[1]
RUN = ROOT / 'tests' / '.integration-artifacts' / ('run-' + uuid.uuid4().hex[:12])
RUN.mkdir(parents=True)
PROJECT = 'news-ci-' + uuid.uuid4().hex[:12]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def command(args, **kwargs):
    return subprocess.run(args, check=True, cwd=ROOT, **kwargs)


for name in ('api_token', 'bridge_token', 'freshrss_password', 'admin_password'):
    path = RUN / name
    path.write_text(secrets.token_urlsafe(36), encoding='utf-8')
    path.chmod(0o444)
token = (RUN / 'api_token').read_text()
command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(RUN / 'key.pem'),
         '-out', str(RUN / 'cert.pem'), '-days', '2', '-subj', '/CN=feeds.example.com',
         '-addext', 'subjectAltName=DNS:feeds.example.com', '-addext', 'basicConstraints=critical,CA:TRUE'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
shutil.copyfile(ROOT / 'tests' / 'fixture_server.py', RUN / 'fixture_server.py')
override = {
    'services': {
        'fixture': {'image': 'python:3.13-slim', 'command': ['python', '/fixture/fixture_server.py'],
                    'volumes': [str(RUN) + ':/fixture:ro'],
                    'networks': {'collector': {'aliases': ['feeds.example.com']}}},
        'freshrss': {
            'environment': {'INTERNAL_HOST_ALLOWLIST': 'feeds.example.com:443', 'CRON_MIN': ''},
            'entrypoint': ['/bin/sh', '-c', 'update-ca-certificates >/dev/null && exec ./Docker/entrypoint.sh /news/run.sh'],
            'volumes': [str(RUN / 'cert.pem') + ':/usr/local/share/ca-certificates/news-test.crt:ro'],
        },
    },
    'secrets': {name: {'file': str(RUN / name)} for name in ('api_token', 'bridge_token', 'freshrss_password', 'admin_password')},
}
override_file = RUN / 'compose.integration.json'
override_file.write_text(json.dumps(override), encoding='utf-8')
env = {**os.environ, 'NEWS_API_PORT': str(free_port()), 'FRESHRSS_ADMIN_PORT': str(free_port()),
       'NEWS_BIND_ADDRESS': '127.0.0.1', 'FRESHRSS_PUBLIC_URL': 'https://rss.example.com',
       'NEWS_ALLOWED_ORIGINS': 'https://daily.example.com', 'NEWS_FRESHRSS_USER': 'news'}
compose = ['docker', 'compose', '-p', PROJECT, '-f', str(ROOT / 'compose.yaml'), '-f', str(override_file)]
base = 'http://127.0.0.1:' + env['NEWS_API_PORT']


def api(path, body=None, *, expected=200, auth=True, origin=None):
    headers = {'Content-Type': 'application/json'}
    if auth:
        headers['Authorization'] = 'Bearer ' + token
    if origin:
        headers['Origin'] = origin
    data = json.dumps(body).encode() if body is not None else None
    try:
        response = urlopen(Request(base + '/api/news/' + path, data=data, headers=headers), timeout=50)
    except HTTPError as error:
        response = error
    with response:
        content = json.load(response)
        assert response.status == expected, (path, response.status, content)
        assert response.headers.get('Cache-Control') == 'no-store'
        return content


def feed(action, **kwargs):
    return api('feeds', {'server_id': server_id, 'operation_id': str(uuid.uuid4()), 'action': action, **kwargs})


try:
    command(compose + ['up', '-d', '--build'], env=env)
    deadline = time.monotonic() + 180
    while True:
        try:
            snapshot = api('snapshot')
            break
        except Exception:
            if time.monotonic() > deadline:
                raise
            time.sleep(2)
    server_id = snapshot['server_id']
    assert snapshot['items'] == []
    assert api('info', auth=False)['mode'] == 'news'
    api('snapshot', auth=False, expected=401)
    api('snapshot', origin='https://untrusted.example.com', expected=403)
    for url in ('http://example.com/rss', 'https://127.0.0.1/rss', 'https://user:pass@example.com/rss'):
        api('feeds', {'server_id': server_id, 'operation_id': str(uuid.uuid4()), 'action': 'add', 'url': url}, expected=422)
    for path in ('doctype.xml', 'malformed.xml', 'html', 'redirect-private', 'redirect-http', 'slow.xml'):
        api('feeds', {'server_id': server_id, 'operation_id': str(uuid.uuid4()), 'action': 'add',
                      'url': 'https://feeds.example.com/' + path}, expected=422)
    feed('add', url='https://feeds.example.com/rss.xml', category='総合')
    snapshot = api('snapshot')
    assert len(snapshot['items']) == 2, snapshot
    assert len(snapshot['feeds']) == 1
    assert snapshot['feeds'][0]['last_success_at']
    fid = snapshot['feeds'][0]['id']
    ids = [item['id'] for item in snapshot['items']]
    first = {'operation_id': str(uuid.uuid4()), 'server_id': server_id, 'item_ids': ids, 'changes': {'read': True, 'starred': True}}
    original_receipt = api('operations', first)
    assert api('operations', first) == original_receipt
    later = {**first, 'operation_id': str(uuid.uuid4()), 'changes': {'read': False}}
    api('operations', later)
    api('operations', first)  # Late duplicate must not undo the later operation.
    state = api('snapshot')
    assert all(item['starred'] and not item['read'] for item in state['items'])
    api('operations', {**first, 'changes': {'read': False}}, expected=409)
    api('operations', {**first, 'operation_id': str(uuid.uuid4()), 'server_id': str(uuid.uuid4())}, expected=409)
    saved_ids, cursor = [], None
    for _ in range(4):
        page = api('snapshot?view=saved&limit=1' + ('&cursor=' + cursor if cursor else ''))
        saved_ids += [item['id'] for item in page['items']]
        cursor = page['pagination']['next_cursor']
        if not cursor:
            break
    assert set(saved_ids) == set(ids) and len(saved_ids) == len(ids), saved_ids
    feed('update', feed_id=fid, category='経済', title='変更済み')
    changed = api('snapshot')['feeds'][0]
    assert changed['category'] == '経済' and changed['title'] == '変更済み', changed
    feed('pause', feed_id=fid)
    paused = api('snapshot')
    assert paused['feeds'][0]['enabled'] is False and len(paused['items']) == 2
    feed('resume', feed_id=fid)
    assert api('snapshot')['feeds'][0]['enabled'] is True
    api('refresh', {'server_id': server_id})
    # Receipts and identity survive process restart; FreshRSS contents are kept.
    command(compose + ['restart', 'api'], env=env, stdout=subprocess.DEVNULL)
    for _ in range(30):
        try:
            assert api('info')['server_id'] == server_id
            break
        except OSError:
            time.sleep(1)
    assert api('operations', first) == original_receipt
    assert all(not item['read'] for item in api('snapshot')['items'])
    # FreshRSS failure returns previously confirmed content as stale, never empty success.
    command(compose + ['stop', 'freshrss'], env=env, stdout=subprocess.DEVNULL)
    stale = api('snapshot')
    assert stale['sync']['status'] == 'stale' and len(stale['items']) == 2
    (RUN / 'result.txt').write_text('PASS: real FreshRSS 1.30.4 integration\n', encoding='utf-8')
    print('PASS: real FreshRSS 1.30.4 ingestion, policy, states, pagination, pause, receipts, restart and stale cache')
finally:
    with (RUN / 'containers.log').open('w', encoding='utf-8') as log:
        subprocess.run(compose + ['logs', '--no-color'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, check=False)
    subprocess.run(compose + ['stop'], cwd=ROOT, env=env, check=False, stdout=subprocess.DEVNULL)
    print('Preserved integration evidence: ' + str(RUN))
    print('Isolated Docker project: ' + PROJECT)
