#!/usr/bin/env python3
"""
find-ddt.py — pick the right DDT4All ECU file for YOUR car.

The DDT database has no car names: DDT4All matches an ECU file by the
identification the ECU itself reports (supplier code, soft version, diagnostic
version). ZoeWeb's "ECU identification report" (Service screen) reads exactly
those values — feed them in here to find the file:

  python3 tools/find-ddt.py --supplier 020 --soft 0503            # by ident
  python3 tools/find-ddt.py --supplier 020 --soft 0503 --diag 24
  python3 tools/find-ddt.py --name x10                            # by filename
"""
import argparse
import json
from pathlib import Path

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('--db', default=str(Path(__file__).parent.parent / 'data' / 'db.json'))
ap.add_argument('--supplier', help='supplier code as the ECU reports it, e.g. 020')
ap.add_argument('--soft', help='soft version (hex as reported), e.g. 0503')
ap.add_argument('--diag', help='diagnostic version, e.g. 24')
ap.add_argument('--name', help='substring search in file names instead')
args = ap.parse_args()

db = json.load(open(args.db))

if args.name:
    for f in sorted(db):
        if args.name.lower() in f.lower():
            print(f'{f}  [{db[f].get("protocol", "?")}]')
    raise SystemExit

if not args.supplier and not args.soft:
    ap.error('give --supplier/--soft (from the ZoeWeb ECU identification report) or --name')

norm = lambda v: (v or '').strip().lstrip('0').upper() or '0'
hits = []
for fname, entry in db.items():
    for ident in entry.get('autoidents', []):
        if args.supplier and norm(ident.get('supplier_code')) != norm(args.supplier):
            continue
        if args.soft and norm(ident.get('soft_version')) != norm(args.soft):
            continue
        if args.diag and norm(ident.get('diagnostic_version')) != norm(args.diag):
            continue
        hits.append((fname, entry.get('protocol', '?'), ident))
        break

if not hits:
    print('no match — try fewer criteria (e.g. only --supplier), or --name')
for fname, proto, ident in sorted(hits):
    print(f'{fname}  [{proto}]  supplier={ident.get("supplier_code")} '
          f'soft={ident.get("soft_version")} diag={ident.get("diagnostic_version")}')
