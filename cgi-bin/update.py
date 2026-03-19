#!/usr/bin/env python3
"""
CGI endpoint for updating the LSE database.
POST /cgi-bin/update.py  → runs Yahoo Finance validation + corrections, returns updated data
GET  /cgi-bin/update.py   → returns status/health check
"""
import json, os, sys, time, traceback
from pathlib import Path

# Paths
WORKSPACE = Path("/home/user/workspace")
DATA_JS = WORKSPACE / "lse-screener" / "data.js"
OHLCV_JS = WORKSPACE / "lse-screener" / "ohlcv.js"
TICKERS_FILE = WORKSPACE / "lse_tickers.json"
YAHOO_DATA = WORKSPACE / "yahoo_data.json"
YAHOO_PROGRESS = WORKSPACE / "yahoo_progress.json"
CORRECTIONS_LOG = WORKSPACE / "corrections_log.json"

method = os.environ.get("REQUEST_METHOD", "GET")

print("Content-Type: application/json")
print()

if method == "GET":
    # Health check / status
    data_exists = DATA_JS.exists()
    ohlcv_exists = OHLCV_JS.exists()
    last_modified = None
    if data_exists:
        last_modified = time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(DATA_JS.stat().st_mtime))
    print(json.dumps({
        "status": "ok",
        "data_exists": data_exists,
        "ohlcv_exists": ohlcv_exists,
        "last_modified": last_modified
    }))
    sys.exit(0)

if method != "POST":
    print(json.dumps({"error": "Method not allowed"}))
    sys.exit(0)

# === POST: Run the update pipeline ===
import requests
import urllib.parse

THRESHOLD = 0.20  # 20% diff → use Yahoo

CROSS_CHECK_FIELDS = [
    ('market_cap', 'market_cap'),
    ('price', 'price'),
    ('volume', 'volume'),
    ('avg_volume', 'avg_volume'),
    ('year_high', 'year_high'),
    ('year_low', 'year_low'),
]

result = {"steps": [], "corrections": 0, "errors": []}

try:
    # Step 1: Load existing data
    result["steps"].append({"step": "load_data", "status": "running"})

    content = DATA_JS.read_text()
    json_str = content.replace('window.LSE_DATA = ', '', 1).rstrip().rstrip(';')
    fmp_data = json.loads(json_str)

    ohlcv_content = OHLCV_JS.read_text()
    ohlcv_json_str = ohlcv_content.replace('window.LSE_OHLCV = ', '', 1).rstrip().rstrip(';')
    ohlcv_data = json.loads(ohlcv_json_str)

    tickers = json.loads(TICKERS_FILE.read_text())

    result["steps"][-1]["status"] = "done"
    result["steps"][-1]["detail"] = f"Loaded {len(fmp_data['stocks'])} stocks, {len(ohlcv_data.get('stocks', {}))} OHLCV records"

    # Step 2: Yahoo Finance fetch
    result["steps"].append({"step": "yahoo_fetch", "status": "running"})

    # Build market cap map from existing data
    fmp_market_caps = {}
    for stock in fmp_data['stocks']:
        sym = stock.get('symbol', '')
        mc = stock.get('market_cap', 0) or stock.get('marketCap', 0)
        if mc and mc > 0:
            fmp_market_caps[sym] = mc

    tickers_to_check = [t for t in tickers if t in fmp_market_caps]

    # Create Yahoo session
    session = requests.Session()
    session.headers.update({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    })
    session.get('https://fc.yahoo.com', timeout=15, allow_redirects=True)
    crumb_resp = session.get('https://query2.finance.yahoo.com/v1/test/getcrumb', timeout=15)
    crumb = crumb_resp.text.strip()

    yahoo_results = {}
    failed = []
    BATCH = 100
    batches = [tickers_to_check[i:i+BATCH] for i in range(0, len(tickers_to_check), BATCH)]

    for batch_idx, batch in enumerate(batches):
        symbols_str = ','.join(batch)
        params = {
            'symbols': symbols_str,
            'fields': 'regularMarketPrice,marketCap,regularMarketVolume,averageDailyVolume3Month,fiftyTwoWeekHigh,fiftyTwoWeekLow',
            'crumb': crumb
        }
        try:
            resp = session.get('https://query2.finance.yahoo.com/v7/finance/quote',
                             params=params, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                quotes = data.get('quoteResponse', {}).get('result', [])
                for q in quotes:
                    sym = q.get('symbol', '')
                    yahoo_results[sym] = {
                        'price': q.get('regularMarketPrice'),
                        'market_cap': q.get('marketCap'),
                        'volume': q.get('regularMarketVolume'),
                        'avg_volume': q.get('averageDailyVolume3Month'),
                        'year_high': q.get('fiftyTwoWeekHigh'),
                        'year_low': q.get('fiftyTwoWeekLow'),
                    }
            else:
                failed.extend(batch)
        except Exception as e:
            failed.extend(batch)

        # Small delay between batches
        if batch_idx < len(batches) - 1:
            time.sleep(0.3)

    # Save Yahoo data
    yahoo_output = {"data": yahoo_results, "failed": failed, "timestamp": time.strftime('%Y-%m-%dT%H:%M:%SZ')}
    YAHOO_DATA.write_text(json.dumps(yahoo_output, indent=2))

    result["steps"][-1]["status"] = "done"
    result["steps"][-1]["detail"] = f"Fetched {len(yahoo_results)} quotes from Yahoo, {len(failed)} failed"

    # Step 3: Apply corrections
    result["steps"].append({"step": "apply_corrections", "status": "running"})

    corrections_log = []
    field_counts = {field: 0 for field, _ in CROSS_CHECK_FIELDS}
    fill_counts = {field: 0 for field, _ in CROSS_CHECK_FIELDS}

    for stock in fmp_data['stocks']:
        symbol = stock['symbol']
        yahoo = yahoo_results.get(symbol)
        if not yahoo:
            continue

        for fmp_field, yahoo_field in CROSS_CHECK_FIELDS:
            fmp_val = stock.get(fmp_field)
            yahoo_val = yahoo.get(yahoo_field)

            if yahoo_val is None or yahoo_val == 0:
                continue

            if fmp_val is None or fmp_val == 0:
                stock[fmp_field] = yahoo_val
                fill_counts[fmp_field] += 1
                corrections_log.append({
                    'symbol': symbol,
                    'field': fmp_field,
                    'fmp_value': fmp_val,
                    'yahoo_value': yahoo_val,
                    'type': 'fill'
                })
                continue

            ratio = yahoo_val / fmp_val
            if abs(ratio - 1) > THRESHOLD:
                stock[fmp_field] = yahoo_val
                field_counts[fmp_field] += 1
                corrections_log.append({
                    'symbol': symbol,
                    'field': fmp_field,
                    'fmp_value': fmp_val,
                    'yahoo_value': yahoo_val,
                    'pct_diff': round((ratio - 1) * 100, 1),
                    'type': 'correction'
                })

    # Also correct OHLCV volume data for tickers where FMP volume was wildly wrong
    ohlcv_corrections = 0
    for stock in fmp_data['stocks']:
        symbol = stock['symbol']
        yahoo = yahoo_results.get(symbol)
        if not yahoo or not yahoo.get('volume'):
            continue
        ohlcv_entry = ohlcv_data.get('stocks', {}).get(symbol)
        if not ohlcv_entry or not ohlcv_entry.get('v'):
            continue
        # Check if latest OHLCV volume differs wildly from Yahoo's latest volume
        latest_vol = ohlcv_entry['v'][-1] if ohlcv_entry['v'] else None
        if latest_vol and latest_vol > 0 and yahoo['volume'] > 0:
            ratio = yahoo['volume'] / latest_vol
            if abs(ratio - 1) > THRESHOLD:
                ohlcv_entry['v'][-1] = yahoo['volume']
                ohlcv_corrections += 1

    total_corrections = sum(field_counts.values()) + sum(fill_counts.values())
    result["steps"][-1]["status"] = "done"
    result["steps"][-1]["detail"] = f"{total_corrections} field corrections, {ohlcv_corrections} volume corrections"
    result["corrections"] = total_corrections + ohlcv_corrections

    # Save corrections log
    CORRECTIONS_LOG.write_text(json.dumps(corrections_log[:200], indent=2))

    # Step 4: Write updated files
    result["steps"].append({"step": "write_files", "status": "running"})

    # Update last_updated timestamp
    fmp_data['last_updated'] = time.strftime('%Y-%m-%dT%H:%M:%SZ')

    data_js_content = 'window.LSE_DATA = ' + json.dumps(fmp_data, separators=(',', ':')) + ';'
    DATA_JS.write_text(data_js_content)

    ohlcv_js_content = 'window.LSE_OHLCV = ' + json.dumps(ohlcv_data, separators=(',', ':')) + ';'
    OHLCV_JS.write_text(ohlcv_js_content)

    result["steps"][-1]["status"] = "done"
    result["steps"][-1]["detail"] = "Updated data.js and ohlcv.js"

    result["status"] = "success"
    result["timestamp"] = time.strftime('%Y-%m-%dT%H:%M:%SZ')

except Exception as e:
    result["status"] = "error"
    result["errors"].append(str(e))
    result["traceback"] = traceback.format_exc()
    # Mark current step as error
    if result["steps"] and result["steps"][-1]["status"] == "running":
        result["steps"][-1]["status"] = "error"
        result["steps"][-1]["detail"] = str(e)

print(json.dumps(result))
