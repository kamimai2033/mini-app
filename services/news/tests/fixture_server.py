"""HTTPS RSS fixture for isolated Docker CI; never used by production Compose."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ssl
import time

RSS = '''<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>検証ニュース</title><link>https://example.com/</link><description>Fixture</description>
<item><guid>news-fixture-1</guid><title>テスト記事 1</title><link>https://example.com/1</link><description>&lt;p&gt;概要 1&lt;/p&gt;</description><pubDate>Fri, 13 Nov 2026 10:00:00 GMT</pubDate></item>
<item><guid>news-fixture-2</guid><title>テスト記事 2</title><link>https://example.com/2</link><description>概要 2</description><pubDate>Fri, 13 Nov 2026 11:00:00 GMT</pubDate></item>
</channel></rss>'''


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/redirect-private'):
            self.send_response(302)
            self.send_header('Location', 'https://127.0.0.1/private')
            self.end_headers()
            return
        if self.path.startswith('/redirect-http'):
            self.send_response(302)
            self.send_header('Location', 'http://feeds.example.com/rss.xml')
            self.end_headers()
            return
        if self.path.startswith('/redirect-valid'):
            self.send_response(301)
            self.send_header('Location', 'https://feeds.example.com/rss.xml')
            self.end_headers()
            return
        if self.path.startswith('/slow'):
            time.sleep(12)
        body = RSS
        if self.path.startswith('/doctype'):
            body = RSS.replace('<rss ', '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss ')
        if self.path.startswith('/malformed'):
            body = '<rss><channel>'
        if self.path.startswith('/html'):
            body = '<html><body>Not a feed</body></html>'
        content = body.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/rss+xml; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        try:
            self.wfile.write(content)
        except (BrokenPipeError, ssl.SSLError):
            pass

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('0.0.0.0', 443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('/fixture/cert.pem', '/fixture/key.pem')
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
