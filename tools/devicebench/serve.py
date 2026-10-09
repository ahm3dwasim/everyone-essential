#!/usr/bin/env python3
"""Serve the device bench on the LAN and record the Stick's POSTed result to result.json."""
import http.server, json, os, sys
os.chdir(os.path.dirname(os.path.abspath(__file__)))
class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript"}
    def do_POST(self):
        if self.path != "/result": return self.send_error(404)
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        data = json.loads(body); open("result.json", "w").write(json.dumps(data, indent=2))
        print("RESULT", json.dumps(data), flush=True)
        self.send_response(204); self.end_headers()
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
http.server.ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
