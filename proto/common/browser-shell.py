#!/usr/bin/env python3
"""A browser stand-in for a shell: serves DIST and answers window.__shell over
HTTP, so host.js can be checked in any browser before a real shell exists.

  python3 browser-shell.py DIST DOC OUT.jsonl [port] [mode]
  then open http://127.0.0.1:<port>/browser-host.html
"""
import http.server
import json
import os
import sys
import urllib.parse

DIST, DOC, OUT = sys.argv[1], os.path.abspath(sys.argv[2]), sys.argv[3]
PORT = int(sys.argv[4]) if len(sys.argv) > 4 else 8765
MODE = sys.argv[5] if len(sys.argv) > 5 else 'bench'

PAGE = b'''<!doctype html><html><head><meta charset="UTF-8"><style>html,body{margin:0;height:100%;overflow:hidden}
#editor{border:0;width:100%;height:100%;display:block}</style></head><body>
<iframe id="editor"></iframe><script>
const j = (r) => r.json()
window.__shell = {
  config: () => fetch('/__shell/config').then(j),
  openFile: async (path) => {
    const r = await fetch('/__shell/open?path=' + encodeURIComponent(path))
    return { name: path.split('/').pop(), path, bytes: new Uint8Array(await r.arrayBuffer()) }
  },
  saveFile: (path, bytes) => fetch('/__shell/save?path=' + encodeURIComponent(path), { method: 'POST', body: bytes }),
  echo: async (bytes) => new Uint8Array(await (await fetch('/__shell/echo', { method: 'POST', body: bytes })).arrayBuffer()),
  report: (obj) => fetch('/__shell/report', { method: 'POST', body: JSON.stringify(obj) }),
  printPdf: async () => ({ ok: false, error: 'no print in the browser stand-in' }),
}
</script><script type="module" src="./host.js"></script></body></html>'''


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DIST, **k)

    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm',
                      '.js': 'text/javascript', '.mjs': 'text/javascript'}

    def send(self, body, ctype='application/octet-stream'):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == '/browser-host.html':
            return self.send(PAGE, 'text/html')
        if url.path == '/__shell/config':
            return self.send(json.dumps({'doc': DOC, 'mode': MODE, 't0': None}).encode(), 'application/json')
        if url.path == '/__shell/open':
            return self.send(open(DOC, 'rb').read())
        return super().do_GET()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if url.path == '/__shell/echo':
            return self.send(body)
        if url.path == '/__shell/save':
            path = urllib.parse.parse_qs(url.query)['path'][0]
            open(path, 'wb').write(body)
            return self.send(b'{}', 'application/json')
        if url.path == '/__shell/report':
            with open(OUT, 'a') as f:
                f.write(body.decode() + '\n')
            return self.send(b'{}', 'application/json')
        self.send_error(404)


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
