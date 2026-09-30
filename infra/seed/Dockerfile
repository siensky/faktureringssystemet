# Engångscontainer: provisionerar S2S-klienter + demo-tenant/admin i
# service_clients/tenants/users (seed.ts), och separat exempeldata
# (seed-demo-data.ts) via docker-compose.yml:s `command:`-override på
# `seed-demo-data`-tjänsten — samma image, två olika entry-scripts, så de
# kan placeras på olika ställen i uppstartskedjan (seed.ts efter bara
# migrate, seed-demo-data.ts efter att tjänsterna är healthy).
#
# Byggs från repo-roten. Egen minimal package.json (bara postgres.js) —
# inget workspace-beroende, precis som infra/migrate.

FROM oven/bun:1-alpine
WORKDIR /app

COPY infra/seed/package.json ./package.json
RUN bun install

COPY infra/seed/demo-constants.ts ./demo-constants.ts
COPY infra/seed/seed.ts ./seed.ts
COPY infra/seed/seed-demo-data.ts ./seed-demo-data.ts

CMD ["bun", "run", "seed.ts"]
