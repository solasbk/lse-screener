#!/usr/bin/env python3
"""
CGI endpoint to serve data.js or ohlcv.js from the workspace.
GET /cgi-bin/serve_data.py?file=data      → serves data.js content
GET /cgi-bin/serve_data.py?file=ohlcv     → serves ohlcv.js content
"""
import os, sys
from pathlib import Path

WORKSPACE = Path("/home/user/workspace")
FILES = {
    "data": WORKSPACE / "lse-screener" / "data.js",
    "ohlcv": WORKSPACE / "lse-screener" / "ohlcv.js",
}

query = os.environ.get("QUERY_STRING", "")
params = dict(p.split("=", 1) for p in query.split("&") if "=" in p)
file_key = params.get("file", "")

if file_key not in FILES:
    print("Content-Type: application/json")
    print()
    print('{"error": "Invalid file parameter. Use ?file=data or ?file=ohlcv"}')
    sys.exit(0)

filepath = FILES[file_key]

if not filepath.exists():
    print("Content-Type: application/json")
    print()
    print('{"error": "File not found"}')
    sys.exit(0)

print("Content-Type: application/javascript")
print()
sys.stdout.write(filepath.read_text())
