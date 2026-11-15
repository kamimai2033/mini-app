"""News BFF. Only FreshRSS fetches feed URLs; no third party Python dependencies."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import hmac
import html
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler
import uuid


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def iso(value, divisor=1):
    try:
        seconds = float(value) / divisor
        return datetime.fromtimestamp(seconds, timezone.utc).isoformat().replace('+00:00', 'Z') if seconds > 1 else None
    except (ValueError, TypeError, OverflowError, OSError):
        return None


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


class UpstreamError(ApiError):
    def __init__(self, code='upstream_unavailable', message='FreshRSS に接続できません。時間をおいて再同期してください。'):
        super().__init__(503, code, message)


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.hidden += 1
        elif tag in ('p', 'br', 'div', 'li'):
            self.parts.append(' ')

    def handle_endtag(self, tag):
        if tag in ('script', 'style') and self.hidden:
            self.hidden -= 1

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain(value, limit=2000):
    parser = PlainText()
    parser.feed(str(value or '')[:100_000])
    return ' '.join(''.join(parser.parts).split())[:limit]


def feed_url(value):
    """Syntactic gate; FreshRSS pins public DNS addresses on EVERY request/redirect."""
    if not isinstance(value, str) or len(value) > 2048 or re.search(r'[\s\\\x00-\x1f\x7f]', value):
        raise ApiError(422, 'invalid_feed_url', 'RSS URL が不正です。')
    try:
        p = urlsplit(value)
        host = (p.hostname or '').lower().rstrip('.')
        if p.scheme != 'https' or p.username is not None or p.password is not None or p.port not in (None, 443) or p.fragment:
            raise ValueError()
        if not host or '.' not in host or host.endswith(('.local', '.localhost', '.home', '.home.arpa', '.internal', '.test', '.invalid')):
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError()
        host.encode('ascii')
        if not re.fullmatch(r'[a-z0-9.-]+', host) or any(not label or label.startswith('-') or label.endswith('-') for label in host.split('.')):
            raise ValueError()
    except (ValueError, UnicodeError):
        raise ApiError(422, 'invalid_feed_url', '公開 HTTPS の RSS URL（標準ポート）を指定してください。') from None
    return value


def article_url(value):
    try:
        p = urlsplit(str(value))
        return str(value)[:4096] if p.scheme in ('https', 'http') and p.hostname and p.username is None and p.password is None else ''
    except ValueError:
        return ''


def secret(name):
    path = os.getenv(name + '_FILE')
    return Path(path).read_text(encoding='utf-8').strip() if path else os.getenv(name, '').strip()


class Config:
    def __init__(self):
        self.token = secret('NEWS_API_TOKEN')
        self.bridge_token = secret('NEWS_BRIDGE_TOKEN')
        self.password = secret('FRESHRSS_API_PASSWORD')
        self.user = os.getenv('NEWS_FRESHRSS_USER', 'news')
        self.base = os.getenv('FRESHRSS_URL', 'http://freshrss').rstrip('/')
        self.admin_url = os.getenv('FRESHRSS_PUBLIC_URL', '')
        self.origins = {x.strip().rstrip('/') for x in os.getenv('NEWS_ALLOWED_ORIGINS', '').split(',') if x.strip()}
        self.data = Path(os.getenv('NEWS_DATA_DIR', '/data'))
        self.timeout = float(os.getenv('NEWS_UPSTREAM_TIMEOUT', '20'))
        if min(len(self.token), len(self.bridge_token), len(self.password)) < 24:
            raise ValueError('Configure all three independent secrets (at least 24 characters each).')
        if '*' in self.origins or 'null' in self.origins:
            raise ValueError('NEWS_ALLOWED_ORIGINS must contain exact trusted origins.')
        for origin in self.origins:
            p = urlsplit(origin)
            if p.scheme not in ('http', 'https') or not p.netloc or p.path or p.query or p.fragment or p.username:
                raise ValueError('Invalid allowed origin.')
        if self.admin_url and (urlsplit(self.admin_url).scheme not in ('http', 'https') or urlsplit(self.admin_url).username):
            raise ValueError('Invalid FreshRSS public URL.')


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class FreshRSS:
    def __init__(self, config):
        self.config = config
        self.auth = None
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(self, path, form=None, *, bridge=None, authenticated=True):
        headers = {'Accept': 'application/json', 'User-Agent': 'mini-app-news/1'}
        data = None
        if bridge is not None:
            headers.update({'Authorization': 'Bearer ' + self.config.bridge_token, 'Content-Type': 'application/json'})
            data = json.dumps(bridge).encode()
        else:
            if authenticated:
                if not self.auth:
                    self.login()
                headers['Authorization'] = 'GoogleLogin auth=' + self.auth
            if form is not None:
                headers['Content-Type'] = 'application/x-www-form-urlencoded'
                data = urlencode(form, doseq=True).encode()
        try:
            with self.opener.open(Request(self.config.base + path, data=data, headers=headers), timeout=self.config.timeout) as response:
                body = response.read(8 * 1024 * 1024 + 1)
                if len(body) > 8 * 1024 * 1024:
                    raise UpstreamError('upstream_response_too_large')
                return body.decode('utf-8')
        except HTTPError as exc:
            # Never forward upstream HTML, credentials, arbitrary error detail or redirects.
            if exc.code in (401, 403):
                self.auth = None
            if bridge is not None and exc.code in (400, 404, 409, 422):
                try:
                    error = json.loads(exc.read(4096)).get('error', {})
                except (ValueError, AttributeError):
                    error = {}
                code = error.get('code', '') if isinstance(error, dict) else ''
                if code in ('invalid_feed', 'unsafe_feed', 'feed_not_found', 'refresh_busy'):
                    raise ApiError(exc.code, code, 'RSS の形式・接続先または対象フィードを確認してください。') from None
            raise UpstreamError() from None
        except (URLError, TimeoutError, OSError, UnicodeError):
            raise UpstreamError() from None

    def login(self):
        body = self.request('/api/greader.php/accounts/ClientLogin', {'Email': self.config.user, 'Passwd': self.config.password}, authenticated=False)
        self.auth = next((line[5:] for line in body.splitlines() if line.startswith('Auth=')), None)
        if not self.auth:
            raise UpstreamError('upstream_authentication_failed')

    def get(self, path):
        try:
            result = json.loads(self.request('/api/greader.php/reader/api/0/' + path))
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, TypeError):
            raise UpstreamError('invalid_upstream_response') from None

    def bridge(self, action, **fields):
        try:
            result = json.loads(self.request('/api/news-bridge.php', bridge={'action': action, **fields}))
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, TypeError):
            raise UpstreamError('invalid_upstream_response') from None

    def edit(self, path, fields):
        token = self.request('/api/greader.php/reader/api/0/token').strip()
        body = self.request('/api/greader.php/reader/api/0/' + path, {**fields, 'T': token})
        if body.strip() != 'OK':
            raise UpstreamError('upstream_write_unconfirmed')

    def subscriptions(self):
        result = self.get('subscription/list?output=json').get('subscriptions')
        if not isinstance(result, list):
            raise UpstreamError('invalid_upstream_response')
        return result

    def apply(self, kind, payload):
        if kind == 'operations':
            for state, enabled in payload['changes'].items():
                self.edit('edit-tag', {'i': payload['item_ids'], 'a' if enabled else 'r': 'user/-/state/com.google/' + state})
            return {}
        action = payload['action']
        if action in ('pause', 'resume'):
            return self.bridge(action, feed_id=payload['feed_id'])
        fields = {}
        if action == 'add':
            # A prior ambiguous subscribe is found by source URL before any retry.
            existing = next((f for f in self.subscriptions() if html.unescape(f.get('url', '')) == payload['url']), None)
            if existing:
                return {'feed_id': existing['id']}
            validated = self.bridge('validate', url=payload['url'])
            target_url = feed_url(validated.get('url', payload['url']))
            existing = next((f for f in self.subscriptions() if html.unescape(f.get('url', '')) == target_url), None)
            if existing:
                return {'feed_id': existing['id']}
            fields = {'ac': 'subscribe', 's': 'feed/' + target_url}
        else:
            fields = {'ac': 'edit', 's': payload['feed_id']}
        if payload.get('title'):
            fields['t'] = payload['title']
        if payload.get('category'):
            fields['a'] = 'user/-/label/' + payload['category']
        self.edit('subscription/edit', fields)
        return {}


class Database:
    def __init__(self, path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS operations(
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT UNIQUE NOT NULL,
                    payload_hash TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',result TEXT, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS snapshots(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
            ''')
            db.execute('INSERT OR IGNORE INTO metadata VALUES(?,?)', ('server_id', str(uuid.uuid4())))
            self.server_id = db.execute("SELECT value FROM metadata WHERE key='server_id'").fetchone()[0]

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('PRAGMA synchronous=FULL')
            with db:
                yield db
        finally:
            db.close()


class Service:
    capabilities = {'read': True, 'starred': True, 'feeds': True, 'pause': True, 'refresh': True, 'pagination': True, 'automatic_deletion': False}

    def __init__(self, config, upstream=None):
        self.config = config
        self.db = Database(config.data / 'news.sqlite3')
        self.upstream = upstream or FreshRSS(config)
        self.lock = threading.RLock()
        self.last_refresh = 0.0

    def info(self):
        return {'protocol': 1, 'mode': 'news', 'server_id': self.db.server_id, 'capabilities': self.capabilities, 'admin_url': self.config.admin_url or None}

    def check_server(self, body):
        if body.get('server_id') != self.db.server_id:
            raise ApiError(409, 'server_id_changed', '接続先が変わっています。再同期して確認してください。')

    def validate_operation(self, kind, body):
        if not isinstance(body, dict):
            raise ApiError(422, 'invalid_request', 'JSON オブジェクトを指定してください。')
        self.check_server(body)
        try:
            operation_id = str(uuid.UUID(body.get('operation_id', '')))
        except (ValueError, TypeError, AttributeError):
            raise ApiError(422, 'invalid_operation_id', 'operation_id は UUID が必要です。') from None
        if kind == 'operations':
            ids, changes = body.get('item_ids'), body.get('changes')
            if not isinstance(ids, list) or not 1 <= len(ids) <= 500 or any(not isinstance(i, str) or not re.fullmatch(r'tag:google.com,2005:reader/item/[0-9a-fA-F]{1,32}', i) for i in ids):
                raise ApiError(422, 'invalid_items', '記事 ID が不正です。')
            if not isinstance(changes, dict) or not changes or set(changes) - {'read', 'starred'} or any(type(v) is not bool for v in changes.values()):
                raise ApiError(422, 'invalid_changes', 'read/starred に真偽値を指定してください。')
            payload = {'item_ids': sorted(set(ids)), 'changes': changes}
        else:
            action = body.get('action')
            if action not in ('add', 'update', 'pause', 'resume'):
                raise ApiError(422, 'invalid_feed_action', '追加・編集・停止・再開のみ対応します。')
            payload = {'action': action}
            if action == 'add':
                payload['url'] = feed_url(body.get('url'))
            else:
                fid = body.get('feed_id')
                if not isinstance(fid, str) or not re.fullmatch(r'feed/[1-9][0-9]{0,15}', fid):
                    raise ApiError(422, 'invalid_feed_id', 'フィード ID が不正です。')
                payload['feed_id'] = fid
                if 'url' in body:
                    raise ApiError(422, 'immutable_feed_url', 'URL 変更は新規登録と元フィードの停止で行ってください。')
            if action in ('add', 'update'):
                if 'title' in body:
                    if not isinstance(body['title'], str) or not 1 <= len(body['title'].strip()) <= 160:
                        raise ApiError(422, 'invalid_title', '表示名は 1〜160 文字で指定してください。')
                    payload['title'] = body['title'].strip()
                category = body.get('category', '総合' if action == 'add' else None)
                if category is not None:
                    if category not in ('総合', '経済', 'IT'):
                        raise ApiError(422, 'invalid_category', 'カテゴリは総合・経済・ITから選択してください。')
                    payload['category'] = category
                if action == 'update' and not any(x in payload for x in ('category', 'title')):
                    raise ApiError(422, 'empty_update', '変更内容がありません。')
        return operation_id, payload

    def _finish_pending(self, db, row):
        try:
            detail = self.upstream.apply(row['kind'], json.loads(row['payload']))
        except ApiError as error:
            # Definite validation failures are receipts too; transport failures remain pending.
            if error.status < 500:
                result = {'error': {'code': error.code, 'message': error.message}, '_http_status': error.status}
                db.execute("UPDATE operations SET status='rejected',result=? WHERE operation_id=?", (json.dumps(result), row['operation_id']))
                db.commit()
            raise
        result = {'operation_id': row['operation_id'], 'status': 'applied', 'server_id': self.db.server_id, **detail}
        db.execute("UPDATE operations SET status='applied',result=? WHERE operation_id=?", (json.dumps(result), row['operation_id']))
        # HTTP effect and SQLite cannot share a transaction. The intent was already fsynced;
        # recovery replays its desired state before any later operation is accepted.
        db.execute('DELETE FROM snapshots')  # Derived cache only, never feed/article data.
        db.commit()
        return result

    def operate(self, kind, body):
        operation_id, payload = self.validate_operation(kind, body)
        encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        digest = hashlib.sha256((kind + '\n' + encoded).encode()).hexdigest()
        with self.lock, self.db.connect() as db:
            row = db.execute('SELECT * FROM operations WHERE operation_id=?', (operation_id,)).fetchone()
            if row and row['payload_hash'] != digest:
                raise ApiError(409, 'operation_id_reused', '同じ UUID に異なる操作は指定できません。')
            if row and row['status'] in ('applied', 'rejected'):
                result = json.loads(row['result'])
                if row['status'] == 'rejected':
                    raise ApiError(result['_http_status'], **result['error'])
                return result
            # Global FIFO is deliberately stronger than per-item ordering for one household.
            for pending in db.execute("SELECT * FROM operations WHERE status='pending' ORDER BY sequence").fetchall():
                try:
                    result = self._finish_pending(db, pending)
                except ApiError as error:
                    if pending['operation_id'] == operation_id:
                        raise
                    if error.status < 500:
                        continue
                    raise ApiError(409, 'pending_operation', '先行操作を確認できません。接続回復後に再送してください。') from None
                if pending['operation_id'] == operation_id:
                    return result
            db.execute('INSERT INTO operations(operation_id,payload_hash,kind,payload,created_at) VALUES(?,?,?,?,?)', (operation_id, digest, kind, encoded, now()))
            db.commit()  # Durable intent BEFORE side effects.
            row = db.execute('SELECT * FROM operations WHERE operation_id=?', (operation_id,)).fetchone()
            return self._finish_pending(db, row)

    def snapshot(self, view='all', limit=500, cursor=None):
        if view not in ('all', 'saved') or not 1 <= limit <= 500 or (cursor and not re.fullmatch(r'[0-9]{1,30}', cursor)):
            raise ApiError(422, 'invalid_pagination', 'ページ指定が不正です。')
        key = json.dumps([view, limit, cursor])
        with self.lock, self.db.connect() as db:
            try:
                subs = self.upstream.subscriptions()
                # Full RSS bodies can be much larger than the summaries we expose.
                # Return a smaller valid page if the upstream response exceeds the cap.
                query = {'n': min(limit, 100), 'r': 'd'}
                if cursor:
                    query['c'] = cursor
                stream = 'starred' if view == 'saved' else 'reading-list'
                while True:
                    try:
                        entries = self.upstream.get('stream/contents/user/-/state/com.google/' + stream + '?' + urlencode(query))
                        break
                    except UpstreamError as error:
                        if error.code != 'upstream_response_too_large' or query['n'] <= 1:
                            raise
                        query['n'] = max(1, query['n'] // 2)
                if not isinstance(entries.get('items'), list):
                    raise UpstreamError('invalid_upstream_response')
                try:
                    states = self.upstream.bridge('status').get('feeds', {})
                    if not isinstance(states, dict):
                        raise UpstreamError('invalid_upstream_response')
                    degraded = False
                except ApiError:
                    states, degraded = {}, True
                feeds = []
                for f in subs:
                    state = states.get(f['id'], {})
                    labels = [plain(c.get('label'), 40) for c in f.get('categories', [])]
                    feeds.append({'id': f['id'], 'title': plain(f.get('title'), 160), 'url': html.unescape(f.get('url', '')),
                                  'category': next((c for c in labels if c in ('総合', '経済', 'IT')), '総合'),
                                  'enabled': state.get('enabled'), 'last_success_at': iso(state.get('last_success')),
                                  'last_error_at': iso(state.get('last_error')), 'error': state.get('error') if not degraded else 'status_unavailable'})
                items = []
                for entry in entries['items']:
                    cats = entry.get('categories', [])
                    origin = entry.get('origin', {})
                    links = entry.get('canonical') or entry.get('alternate') or [{}]
                    identifier = entry.get('id')
                    if not isinstance(identifier, str):
                        continue
                    items.append({'id': identifier, 'title': plain(entry.get('title'), 500), 'url': article_url(links[0].get('href')),
                                  'summary': plain(entry.get('summary', {}).get('content')), 'published_at': iso(entry.get('published')),
                                  'received_at': iso(entry.get('crawlTimeMsec'), 1000), 'feed_id': str(origin.get('streamId', '')),
                                  'feed_title': plain(origin.get('title'), 160),
                                  'categories': [c.rsplit('/label/', 1)[1] for c in cats if isinstance(c, str) and '/label/' in c],
                                  'read': 'user/-/state/com.google/read' in cats, 'starred': 'user/-/state/com.google/starred' in cats})
                timestamp = now()
                result = {**self.info(), 'updated_at': timestamp, 'sync': {'status': 'partial' if degraded or any(f['error'] for f in feeds) else 'ok',
                          'last_success_at': timestamp, 'error': 'feed_status_unavailable' if degraded else None}, 'items': items, 'feeds': feeds,
                          'pagination': {'next_cursor': str(entries['continuation']) if entries.get('continuation') else None, 'has_more': bool(entries.get('continuation'))}}
                db.execute('INSERT OR REPLACE INTO snapshots VALUES(?,?)', (key, json.dumps(result)))
                # Bound disposable page cache, retaining the two first pages preferentially.
                db.execute('DELETE FROM snapshots WHERE rowid NOT IN (SELECT rowid FROM snapshots ORDER BY rowid DESC LIMIT 40)')
                return result
            except (ApiError, KeyError, TypeError, AttributeError) as error:
                cached = db.execute('SELECT payload FROM snapshots WHERE key=?', (key,)).fetchone()
                if not cached:
                    raise UpstreamError() from None
                result = json.loads(cached[0])
                result['sync']['status'] = 'stale'
                result['sync']['error'] = 'upstream_unavailable'
                return result

    def refresh(self, body):
        self.check_server(body)
        with self.lock:
            if time.monotonic() - self.last_refresh < 60:
                raise ApiError(429, 'refresh_throttled', '手動更新は 1 分以上あけてください。')
            self.last_refresh = time.monotonic()
            result = self.upstream.bridge('refresh')
            return {'server_id': self.db.server_id, 'sync': {'status': 'partial' if result.get('errors') else 'ok', 'last_success_at': now(), 'error': 'some_feeds_failed' if result.get('errors') else None}}


def handler_for(service):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'NewsAPI/1'

        def setup(self):
            super().setup()
            self.connection.settimeout(25)

        def log_message(self, fmt, *args):
            # Never log query strings, bodies, tokens or upstream error details.
            return

        def respond(self, status, payload):
            content = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Vary', 'Origin')
            origin = self.headers.get('Origin')
            if origin in service.config.origins:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(content)

        def run_request(self):
            try:
                origin = self.headers.get('Origin')
                if origin and origin not in service.config.origins:
                    raise ApiError(403, 'origin_denied', '許可されていない接続元です。')
                parsed = urlsplit(self.path)
                if self.command == 'OPTIONS':
                    self.respond(200, {})
                    return
                if self.command == 'GET' and parsed.path == '/api/news/info':
                    self.respond(200, service.info())
                    return
                authorization = self.headers.get('Authorization', '')
                if not hmac.compare_digest(authorization.encode(), ('Bearer ' + service.config.token).encode()):
                    raise ApiError(401, 'unauthorized', 'アクセスキーを確認してください。')
                if self.command == 'GET' and parsed.path == '/api/news/snapshot':
                    query = parse_qs(parsed.query)
                    try:
                        limit = int(query.get('limit', ['500'])[0])
                    except ValueError:
                        raise ApiError(422, 'invalid_pagination', 'limit が不正です。') from None
                    result = service.snapshot(query.get('view', ['all'])[0], limit, query.get('cursor', [None])[0])
                elif self.command == 'POST' and parsed.path in ('/api/news/operations', '/api/news/feeds', '/api/news/refresh'):
                    if self.headers.get('Transfer-Encoding'):
                        raise ApiError(400, 'invalid_request', 'Content-Length が必要です。')
                    try:
                        length = int(self.headers.get('Content-Length', '0'))
                    except ValueError:
                        length = 0
                    if not 1 <= length <= 128_000:
                        raise ApiError(413, 'request_too_large', 'リクエストサイズが不正です。')
                    if self.headers.get('Content-Type', '').split(';')[0].strip() != 'application/json':
                        raise ApiError(415, 'json_required', 'application/json を指定してください。')
                    try:
                        body = json.loads(self.rfile.read(length))
                    except (ValueError, UnicodeError):
                        raise ApiError(400, 'invalid_json', 'JSON が不正です。') from None
                    if not isinstance(body, dict):
                        raise ApiError(422, 'invalid_request', 'JSON オブジェクトを指定してください。')
                    result = service.refresh(body) if parsed.path.endswith('/refresh') else service.operate(parsed.path.rsplit('/', 1)[1], body)
                else:
                    raise ApiError(404, 'not_found', 'API が見つかりません。')
                self.respond(200, result)
            except ApiError as error:
                self.respond(error.status, {'error': {'code': error.code, 'message': error.message}})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                return
            except Exception:
                self.respond(500, {'error': {'code': 'internal_error', 'message': 'サーバー処理を完了できませんでした。'}})

        do_GET = run_request
        do_POST = run_request
        do_OPTIONS = run_request

    return Handler


if __name__ == '__main__':
    config = Config()
    service = Service(config)
    server = ThreadingHTTPServer((os.getenv('NEWS_BIND', '0.0.0.0'), int(os.getenv('NEWS_PORT', '8010'))), handler_for(service))
    print('News API ready; protocol 1. One process per persistent data directory.', flush=True)
    server.serve_forever()
