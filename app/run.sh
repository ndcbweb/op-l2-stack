#!/bin/sh
set -e
cd /app/server
export DATA_DIR=${DATA_DIR:-/data} L2_DIR=${L2_DIR:-/l2} WEB_DIR=${WEB_DIR:-/app/web}
exec node --experimental-sqlite --no-warnings src/index.js
