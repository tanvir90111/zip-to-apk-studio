#!/usr/bin/env bash
# usage: notify.sh <building|done|failed> <message>
body=$(node -e 'console.log(JSON.stringify({status:process.argv[1],message:process.argv[2]}))' "$1" "$2")
curl -fsS -X POST -H "Authorization: Bearer $BUILD_TOKEN" -H "content-type: application/json" \
  --data "$body" "$WORKER_URL/api/internal/status/$JOB_ID" || true
