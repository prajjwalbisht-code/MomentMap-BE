#!/bin/bash

set -euo pipefail

API_KEY="${RAPIDAPI_KEY:-6cd80fc443msh8dbff7511f3db22p10a013jsne41f3e779b2c}"
HOST="real-time-events-search.p.rapidapi.com"
BASE_URL="https://${HOST}/search-events"
QUERY="music+concert+india"
DATE_FILTER="next_month"
IS_VIRTUAL="false"
PAGE_SIZE=10
START=0
RAW_FILE="all_events_raw.jsonl"
MERGED_FILE="all_events_data.json"
ALLOW_INSECURE_TLS="${ALLOW_INSECURE_TLS:-true}"

: > "$RAW_FILE"

while true; do
  echo "Fetching start=${START}..."

  CURL_ARGS=(-sS --request GET
    --url "${BASE_URL}?query=${QUERY}&date=${DATE_FILTER}&is_virtual=${IS_VIRTUAL}&start=${START}"
    --header "x-rapidapi-host: ${HOST}"
    --header "x-rapidapi-key: ${API_KEY}")

  if [ "$ALLOW_INSECURE_TLS" = "true" ]; then
    CURL_ARGS=(-k "${CURL_ARGS[@]}")
  fi

  RESPONSE=$(curl "${CURL_ARGS[@]}")

  COUNT=$(python3 -c '
import json,sys
try:
    payload = json.loads(sys.stdin.read())
    print(len(payload.get("data", [])))
except Exception:
    print(0)
' <<< "$RESPONSE")

  echo "Got ${COUNT} events"
  echo "$RESPONSE" >> "$RAW_FILE"

  if [ "$COUNT" -lt "$PAGE_SIZE" ]; then
    echo "Last page reached. Done!"
    break
  fi

  START=$((START + PAGE_SIZE))
  sleep 1
done

python3 - "$RAW_FILE" "$MERGED_FILE" <<'PY'
import json
import sys

raw_file = sys.argv[1]
merged_file = sys.argv[2]
all_events = []

with open(raw_file, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        all_events.extend(payload.get("data", []))

with open(merged_file, "w", encoding="utf-8") as out:
    json.dump(all_events, out, ensure_ascii=False, indent=2)

print(f"Merged {len(all_events)} events into {merged_file}")
PY

echo "All done! Raw pages saved to ${RAW_FILE} and merged results saved to ${MERGED_FILE}"
