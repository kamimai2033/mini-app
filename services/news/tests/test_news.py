from pathlib import Path
from types import SimpleNamespace
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from news_api import ApiError, Database, FreshRSS, Service, UpstreamError, feed_url, handler_for, plain, ThreadingHTTPServer

ITEM = 'tag:google.com,2005:reader/item/123456789abcdef'


class FakeFreshRSS:
    def __init__(self):
        self.calls = []
        self.state = {'read': False, 'starred': False}
        self.fail, self.fail_status = False, False

    def apply(self, kind, payload):
        self.calls.append((kind, payload))
        if self.fail:
            raise UpstreamError()
        if kind == 'operations':
            self.state.update(payload['changes'])
        return {}

    def subscriptions(self):
        if self.fail:
            raise UpstreamError()
        return [{'id': 'feed/1', 'title': 'テスト', 'url': 'https://example.com/rss', 'categories': [{'label': '総合'}]}]

    def get(self, path):
        return {'items': [{'id': ITEM, 'title': '記事', 'canonical': [{'href': 'https://example.com/1'}],
                          'summary': {'content': '<p>概要</p><script>secret()</script>'},
                          'categories': ['user/-/label/総合'] + ['user/-/state/com.google/' + k for k, v in self.state.items() if v],
                          'origin': {'streamId': 'feed/1', 'title': 'テスト'}, 'published': 1700000000,
                          'crawlTimeMsec': '1700000000000'}], 'continuation': '1700000000000000'}

    def bridge(self, action, **kwargs):
        if self.fail_status:
            raise UpstreamError()
        return {'feeds': {'feed/1': {'enabled': True, 'last_success': 1700000000, 'last_error': 0, 'error': None}}}


def config(path):
    return SimpleNamespace(data=path, token='a' * 48, bridge_token='b' * 48, password='c' * 48, user='news',
                           base='http://freshrss', admin_url='https://rss.example.com', origins={'https://daily.example.com'}, timeout=0.1)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='news-unit-')
        self.addCleanup(self.temp.cleanup)
        self.config = config(Path(self.temp.name))
        self.upstream = FakeFreshRSS()
        self.service = Service(self.config, self.upstream)

    def operation(self, **changes):
        return {'operation_id': str(uuid.uuid4()), 'server_id': self.service.db.server_id, 'item_ids': [ITEM], 'changes': changes or {'read': True}}

    def test_uuid_receipts_survive_restart_and_never_reapply_older_update(self):
        original = self.operation(read=True)
        receipt = self.service.operate('operations', original)
        self.service.operate('operations', self.operation(read=False))
        restarted = Service(self.config, self.upstream)
        self.assertEqual(restarted.operate('operations', original), receipt)
        self.assertFalse(self.upstream.state['read'])
        self.assertEqual(len(self.upstream.calls), 2)

    def test_crash_between_external_effect_and_receipt_recovers_before_new_write(self):
        original = self.operation(read=True)
        with self.service.db.connect() as db:
            db.execute("CREATE TRIGGER fail_receipt BEFORE UPDATE ON operations WHEN NEW.status='applied' BEGIN SELECT RAISE(ABORT,'simulated crash'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.service.operate('operations', original)
        self.assertTrue(self.upstream.state['read'])
        with self.service.db.connect() as db:
            self.assertEqual(db.execute('SELECT status FROM operations').fetchone()[0], 'pending')
            db.execute('DROP TRIGGER fail_receipt')
        restarted = Service(self.config, self.upstream)
        restarted.operate('operations', self.operation(read=False))
        self.assertEqual([call[1]['changes']['read'] for call in self.upstream.calls], [True, True, False])
        restarted.operate('operations', original)
        self.assertFalse(self.upstream.state['read'])

    def test_pending_failure_blocks_new_intent_without_losing_it(self):
        original = self.operation(read=True)
        self.upstream.fail = True
        with self.assertRaises(UpstreamError):
            self.service.operate('operations', original)
        with self.assertRaises(ApiError) as raised:
            self.service.operate('operations', self.operation(read=False))
        self.assertEqual(raised.exception.code, 'pending_operation')
        with self.service.db.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM operations').fetchone()[0], 1)
        self.upstream.fail = False
        self.service.operate('operations', original)
        self.assertTrue(self.upstream.state['read'])

    def test_uuid_payload_and_server_identity_conflicts_are_distinct(self):
        original = self.operation()
        self.service.operate('operations', original)
        for body, code in (({**original, 'changes': {'read': False}}, 'operation_id_reused'),
                           ({**original, 'server_id': str(uuid.uuid4())}, 'server_id_changed')):
            with self.assertRaises(ApiError) as raised:
                self.service.operate('operations', body)
            self.assertEqual(raised.exception.code, code)

    def test_database_connections_are_closed(self):
        with self.service.db.connect() as db:
            self.assertEqual(db.execute('SELECT 1').fetchone()[0], 1)
        with self.assertRaises(sqlite3.ProgrammingError):
            db.execute('SELECT 1')

    def test_cache_is_stale_on_failure_and_first_failure_is_503(self):
        good = self.service.snapshot()
        self.assertEqual(good['items'][0]['summary'], '概要')
        self.upstream.fail = True
        stale = self.service.snapshot()
        self.assertEqual(stale['items'], good['items'])
        self.assertEqual(stale['updated_at'], good['updated_at'])
        self.assertEqual(stale['sync']['status'], 'stale')
        with self.assertRaises(UpstreamError):
            self.service.snapshot('saved')

    def test_bridge_failure_is_partial_with_unknown_feed_state(self):
        self.upstream.fail_status = True
        snapshot = self.service.snapshot()
        self.assertEqual(snapshot['sync']['status'], 'partial')
        self.assertIsNone(snapshot['feeds'][0]['enabled'])
        self.assertIsNone(snapshot['feeds'][0]['last_success_at'])

    def test_oversized_fulltext_response_retries_smaller_page(self):
        original = self.upstream.get
        counts = []
        def get(path):
            count = int(parse_qs(urlsplit(path).query)['n'][0])
            counts.append(count)
            if count > 25:
                raise UpstreamError('upstream_response_too_large')
            return original(path)
        self.upstream.get = get
        self.assertTrue(self.service.snapshot()['pagination']['has_more'])
        self.assertEqual(counts, [100, 50, 25])

    def test_rejects_non_boolean_desired_state_and_unsubscribe(self):
        for kind, body in [('operations', {**self.operation(), 'changes': {'read': 'false'}}),
                           ('feeds', {**self.operation(), 'action': 'unsubscribe', 'feed_id': 'feed/1'})]:
            with self.assertRaises(ApiError) as raised:
                self.service.operate(kind, body)
            self.assertEqual(raised.exception.status, 422)
        self.assertEqual(self.upstream.calls, [])

    def test_https_url_policy_and_plain_text(self):
        for url in ('http://example.com/feed', 'https://127.0.0.1/rss', 'https://[::1]/rss', 'https://100.64.0.1/rss',
                    'https://router.home/rss', 'https://host.local/rss', 'https://user:pass@example.com/feed',
                    'https://example.com:8443/rss', 'https://example.com\\@127.0.0.1/rss', 'https://example.com/rss\n'):
            with self.subTest(url=url), self.assertRaises(ApiError):
                feed_url(url)
        self.assertEqual(feed_url('https://news.yahoo.co.jp/rss/topics/top-picks.xml'), 'https://news.yahoo.co.jp/rss/topics/top-picks.xml')
        self.assertEqual(plain('<style>x</style><p>A&amp;B</p><img src="https://tracker/"><script>bad</script>'), 'A&B')

    def test_upstream_timeout_is_redacted(self):
        upstream = FreshRSS(self.config)
        upstream.auth = 'secret-auth-token'
        upstream.opener.open = Mock(side_effect=TimeoutError('secret internal URL'))
        with self.assertRaises(UpstreamError) as raised:
            upstream.get('subscription/list?output=json')
        self.assertEqual(raised.exception.status, 503)
        self.assertNotIn('secret', str(raised.exception))


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='news-http-')
        cls.config = config(Path(cls.temp.name))
        cls.service = Service(cls.config, FakeFreshRSS())
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(cls.service))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def request(self, path, headers=None, data=None, method=None):
        try:
            response = urlopen(Request(self.base + path, headers=headers or {}, data=data, method=method), timeout=3)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, json.load(response)

    def test_auth_cors_no_store_and_public_info(self):
        status, headers, body = self.request('/api/news/info')
        self.assertEqual(status, 200)
        self.assertEqual(body['mode'], 'news')
        self.assertNotIn(self.config.token, json.dumps(body))
        self.assertEqual(self.request('/api/news/snapshot')[0], 401)
        headers = {'Authorization': 'Bearer ' + self.config.token, 'Origin': 'https://daily.example.com'}
        status, response_headers, body = self.request('/api/news/snapshot', headers)
        self.assertEqual(status, 200)
        self.assertEqual(response_headers['Access-Control-Allow-Origin'], headers['Origin'])
        self.assertEqual(response_headers['Cache-Control'], 'no-store')
        status, response_headers, body = self.request('/api/news/snapshot', {**headers, 'Origin': 'https://evil.example.com'})
        self.assertEqual(status, 403)
        self.assertIsNone(response_headers.get('Access-Control-Allow-Origin'))
        status, _, _ = self.request('/api/news/snapshot', {'Origin': 'https://daily.example.com'}, method='OPTIONS')
        self.assertEqual(status, 200)

    def test_malformed_json_and_body_limits(self):
        headers = {'Authorization': 'Bearer ' + self.config.token, 'Content-Type': 'application/json'}
        self.assertEqual(self.request('/api/news/operations', headers, b'{')[0], 400)
        self.assertEqual(self.request('/api/news/operations', headers, b'[]')[0], 422)
        self.assertEqual(self.request('/api/news/operations', headers, b'x' * 128001)[0], 413)


if __name__ == '__main__':
    unittest.main()
