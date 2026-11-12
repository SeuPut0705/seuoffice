#!/usr/bin/env python3
"""Local stand-in for cef-builds.spotifycdn.com, as CEF_DOWNLOAD_URL.

The cef crate's build script reads the whole /index.json with a 10 MB body
limit, and the CDN's index has grown past it. This serves an index trimmed to
the one CEF version the build needs (every platform, minimal files only) and
redirects every other path (the archive download) to the CDN.

  cef-index-mirror.py PORT CEF_VERSION        e.g. 8099 154.0.34
"""
import http.server
import json
import sys
import urllib.request

CDN = 'https://cef-builds.spotifycdn.com'
PORT, VERSION = int(sys.argv[1]), sys.argv[2]


def trimmed_index():
    with urllib.request.urlopen(CDN + '/index.json', timeout=120) as response:
        index = json.load(response)
    out = {}
    for platform, body in index.items():
        versions = [
            {**v, 'files': [f for f in v['files'] if f['type'] == 'minimal']}
            for v in body['versions']
            if v['cef_version'].startswith(VERSION + '+')
        ]
        out[platform] = {'versions': versions}
    return json.dumps(out).encode()


INDEX = trimmed_index()
print('trimmed index: %d bytes' % len(INDEX), flush=True)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/index.json':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(INDEX)))
            self.end_headers()
            self.wfile.write(INDEX)
        else:
            self.send_response(302)
            self.send_header('Location', CDN + self.path)
            self.end_headers()

    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)


http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
