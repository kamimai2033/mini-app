"""Opt-in Yahoo RSS seed; submits to the NAS API, never fetches RSS itself."""
import argparse
import json
import ipaddress
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, ProxyHandler
import uuid
from news_api import NoRedirect

parser = argparse.ArgumentParser()
parser.add_argument('--api', default='http://127.0.0.1:8010')
parser.add_argument('--token-file', default=str(Path(__file__).resolve().parent / '.secrets' / 'api_token'))
args = parser.parse_args()
try:
    target = urlsplit(args.api.rstrip('/'))
    loopback = target.hostname == 'localhost'
    try:
        loopback = loopback or ipaddress.ip_address(target.hostname or '').is_loopback
    except ValueError:
        pass
    if not target.hostname or target.username is not None or target.password is not None or target.path or target.query or target.fragment:
        raise ValueError()
    if target.scheme != 'https' and not (target.scheme == 'http' and loopback):
        raise ValueError()
    target.port  # Validate malformed ports before reading or transmitting a secret.
except ValueError:
    parser.error('--api must be an HTTPS origin, or a loopback HTTP origin, without credentials or a path.')
token = Path(args.token_file).read_text(encoding='utf-8').strip()
opener = build_opener(ProxyHandler({}), NoRedirect())


def call(path, data=None, authenticated=True):
    body = json.dumps(data).encode() if data is not None else None
    headers = {'Content-Type': 'application/json'}
    if authenticated:
        headers['Authorization'] = 'Bearer ' + token
    request = Request(args.api.rstrip('/') + '/api/news/' + path, data=body, headers=headers)
    with opener.open(request, timeout=60) as response:
        return json.load(response)


info = call('info', authenticated=False)
if info.get('protocol') != 1 or info.get('mode') != 'news':
    raise SystemExit('The selected endpoint is not News API protocol 1.')
server_id = info['server_id']
for title, category, topic in [('Yahoo!ニュース 主要', '総合', 'top-picks'), ('Yahoo!ニュース 経済', '経済', 'business'), ('Yahoo!ニュース IT', 'IT', 'it')]:
    url = 'https://news.yahoo.co.jp/rss/topics/' + topic + '.xml'
    call('feeds', {'server_id': server_id, 'operation_id': str(uuid.uuid5(uuid.UUID(server_id), url)),
                   'action': 'add', 'url': url, 'title': title, 'category': category})
    print('Registered: ' + title)
