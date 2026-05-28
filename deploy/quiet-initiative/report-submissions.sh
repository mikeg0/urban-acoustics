#!/usr/bin/env bash
# Print a human-readable report of every petition signup and feedback
# submission collected by the urban-quiet-initiative backend.
#
# Reads from the three DynamoDB tables managed by the CloudFormation stack:
#   - urban-quiet-signups     (petition emails)
#   - urban-quiet-feedback    (feedback form messages)
#   - urban-quiet-page-visits (first-party page-visit telemetry)
#
# All tables are scanned in full. The v2 AWS CLI paginates automatically,
# so multi-MB tables are handled transparently.
#
# Env overrides: AWS_REGION, SIGNUPS_TABLE, FEEDBACK_TABLE, PAGE_VISITS_TABLE.

set -euo pipefail

REGION="${AWS_REGION:-us-west-2}"
SIGNUPS_TABLE="${SIGNUPS_TABLE:-urban-quiet-signups}"
FEEDBACK_TABLE="${FEEDBACK_TABLE:-urban-quiet-feedback}"
PAGE_VISITS_TABLE="${PAGE_VISITS_TABLE:-urban-quiet-page-visits}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

aws dynamodb scan --table-name "$SIGNUPS_TABLE"     --region "$REGION" --output json > "$TMP/signups.json"
aws dynamodb scan --table-name "$FEEDBACK_TABLE"    --region "$REGION" --output json > "$TMP/feedback.json"
aws dynamodb scan --table-name "$PAGE_VISITS_TABLE" --region "$REGION" --output json > "$TMP/visits.json"

python3 - "$TMP/signups.json" "$TMP/feedback.json" "$TMP/visits.json" <<'PY'
import json, sys, textwrap
from collections import Counter
from datetime import datetime, timezone, timedelta

def v(item, key, default=""):
    cell = item.get(key) or {}
    if "S" in cell:    return cell["S"]
    if "N" in cell:    return cell["N"]
    if "BOOL" in cell: return "yes" if cell["BOOL"] else "no"
    return default

def load(path):
    with open(path) as fh:
        return json.load(fh).get("Items", [])

signups  = load(sys.argv[1])
feedback = load(sys.argv[2])
visits   = load(sys.argv[3])

signups.sort(key=lambda i: v(i, "createdAt"), reverse=True)
feedback.sort(key=lambda i: v(i, "createdAt"), reverse=True)
visits.sort(key=lambda i: v(i, "createdAt"), reverse=True)

def rule(ch="─", n=88): print(ch * n)

print()
rule("═")
print(f" PETITION SIGNUPS — {len(signups)} total")
rule("═")
if not signups:
    print("  (none yet)")
for s in signups:
    print()
    print(f"  {v(s,'createdAt')}  ·  {v(s,'name')}  <{v(s,'email')}>")
    line2 = []
    if v(s, "neighborhood"): line2.append(f"neighborhood: {v(s,'neighborhood')}")
    if "isResident" in s:    line2.append(f"resident: {v(s,'isResident')}")
    if v(s, "sourceIp"):     line2.append(f"ip: {v(s,'sourceIp')}")
    if line2:
        print(f"    {'  ·  '.join(line2)}")
    if v(s, "comment"):
        wrapped = textwrap.fill(v(s, "comment"), width=84,
                                initial_indent="    ↳ ", subsequent_indent="      ")
        print(wrapped)

print()
rule("═")
print(f" FEEDBACK SUBMISSIONS — {len(feedback)} total")
rule("═")
if not feedback:
    print("  (none yet)")
for f in feedback:
    print()
    print(f"  {v(f,'createdAt')}  ·  {v(f,'name')}  <{v(f,'email')}>")
    line2 = []
    if v(f, "topic"):      line2.append(f"topic: {v(f,'topic')}")
    if v(f, "block"):      line2.append(f"block: {v(f,'block')}")
    if v(f, "whenWoken"):  line2.append(f"when woken: {v(f,'whenWoken')}")
    if v(f, "sourceIp"):   line2.append(f"ip: {v(f,'sourceIp')}")
    if line2:
        print(f"    {'  ·  '.join(line2)}")
    if v(f, "message"):
        wrapped = textwrap.fill(v(f, "message"), width=84,
                                initial_indent="    ↳ ", subsequent_indent="      ")
        print(wrapped)

now = datetime.now(timezone.utc)
def within(item, delta):
    ts = v(item, "createdAt")
    if not ts: return False
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")) >= now - delta
    except ValueError:
        return False

unique_ips = {v(i, "sourceIp") for i in visits if v(i, "sourceIp")}
last_24h   = sum(1 for i in visits if within(i, timedelta(hours=24)))
last_7d    = sum(1 for i in visits if within(i, timedelta(days=7)))

def referrer_key(ref):
    return ref if ref else "(direct)"

top_referrers = Counter(referrer_key(v(i, "referrer")) for i in visits).most_common(10)
top_paths     = Counter(v(i, "path") or "/" for i in visits).most_common(10)

print()
rule("═")
print(f" PAGE VISITS — {len(visits)} total  ·  {len(unique_ips)} unique IPs  ·  {last_24h} in last 24h  ·  {last_7d} in last 7d")
rule("═")
if not visits:
    print("  (none yet)")
else:
    print()
    print("  Top referrers")
    for ref, n in top_referrers:
        print(f"    {n:>5}  {ref}")
    print()
    print("  Top paths")
    for p, n in top_paths:
        print(f"    {n:>5}  {p}")
    print()
    print("  Recent visits (latest 20)")
    for i in visits[:20]:
        print(f"    {v(i,'createdAt')}  ·  {v(i,'sourceIp') or '?':<15}  ·  {referrer_key(v(i,'referrer'))}")
        path = v(i, "path")
        if path and path != "/":
            print(f"      path: {path}")

print()
PY
