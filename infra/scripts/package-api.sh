#!/usr/bin/env bash
# Builds the Lambda package for the API without touching the API's own code:
#   .build/api/server.js      the existing esbuild bundle (ESM, top-level await), unchanged
#   .build/api/preload.js     loads /segue/* from SSM into the environment, then imports server.js
#   .build/api/package.json   "type": "module", so Node runs the bundle as ESM
#   .build/api/node_modules   pg (the API build marks it --external) and the AWS SDK clients for DynamoDB and SSM,
#                             loaded at runtime only on Lambda
#   .build/api/run.sh         the handler Lambda Web Adapter starts
set -euo pipefail
INFRA="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$INFRA/.." && pwd)"
OUT="$INFRA/.build/api"

PG_VERSION="$(node -p "require('$ROOT/apps/api/package.json').dependencies.pg.replace(/^[^0-9]*/, '')")"

(cd "$ROOT" && pnpm --filter @segue/api build)

rm -rf "$OUT"
mkdir -p "$OUT"
cp "$ROOT/apps/api/dist/server.js" "$OUT/server.js"
(cd "$ROOT" && pnpm --filter @segue/api exec esbuild src/lambda/preload.ts --bundle --platform=node --target=node22 --format=esm --log-level=warning --outfile="$OUT/preload.js")
cat > "$OUT/package.json" <<JSON
{ "name": "segue-api-lambda", "private": true, "type": "module", "dependencies": { "pg": "$PG_VERSION", "@aws-sdk/client-dynamodb": "^3.700.0", "@aws-sdk/client-ssm": "^3.700.0" } }
JSON
printf '#!/bin/sh\nexec node preload.js\n' > "$OUT/run.sh"
chmod +x "$OUT/run.sh"
(cd "$OUT" && npm install --omit=dev --no-package-lock --no-audit --no-fund --ignore-scripts --silent)

echo "Lambda package ready: $OUT ($(du -sh "$OUT" | cut -f1), pg $PG_VERSION)"
