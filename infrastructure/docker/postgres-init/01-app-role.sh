#!/bin/bash
# Runs once when the local PostgreSQL volume is first created (docker-entrypoint-initdb.d).
#
# Creates the role the API connects as. It is deliberately NOT a superuser and has no BYPASSRLS,
# because PostgreSQL row-level security does not apply to those, so tenant isolation would go
# untested. This mirrors Neon, where the default owner role is not a superuser.
# CREATEDB lets the integration tests create their own *_test database. Local development only.
set -euo pipefail

psql -v ON_ERROR_STOP=1 \
  -v app_user="$POSTGRES_APP_USER" \
  -v app_password="$POSTGRES_APP_PASSWORD" \
  -v db_name="$POSTGRES_DB" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
	CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password' CREATEDB NOSUPERUSER NOBYPASSRLS;
	ALTER DATABASE :"db_name" OWNER TO :"app_user";
	ALTER SCHEMA public OWNER TO :"app_user";
EOSQL
