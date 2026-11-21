# Suntek Ecosystem — Target Deployment Topology

**Document:** Target Deployment Topology & Infrastructure Architecture  
**Status:** Approved Architectural Specification (Phase 1)  
**Date:** 2026-11-21  
**Target Platform:** Render, Neon PostgreSQL 17, Redis, Vite Static Sites

---

## 1. Overview

To support complete operational independence and horizontal scalability, the monolithic services (`healthos-api` and `healthos-web`) are decoupled into specialized deployable units across both backend and frontend layers.

---

## 2. Target Service Topology

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       SUNTEK ECOSYSTEM TARGET DEPLOYMENT                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   [ SUNTEK-MGT HRMS ]                                                       │
│   ├── suntek-mgt-web        (Static Web: Vite / React, VITE_APP_SURFACE=mgt)│
│   └── suntek-mgt-api        (Node 22 Web Service: /api/v1/mgt/*)            │
│                                                                             │
│   [ SUNTEK-OPS HOSPITAL ]                                                   │
│   ├── suntek-ops-admin-web  (Static Web: Vite / React, VITE_APP_SURFACE=ops)│
│   ├── suntek-ops-patient-web(Static Web: Vite / React, VITE_APP_SURFACE=pat)│
│   └── suntek-ops-api        (Node 22 Web Service: /api/v1/ops/*)            │
│                                                                             │
│   [ OPERATOR PLANE ]                                                        │
│   └── platform-console-web  (Static Web: Vite / React, VITE_APP_SURFACE=plt)│
│                                                                             │
│   [ DATA & INFRASTRUCTURE ]                                                │
│   ├── Neon PostgreSQL 17    (Independent databases or isolated schemas)     │
│   └── Redis Cluster / KV    (Rate limiting, token blacklist, locks)         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Render Deployment Specifications (`render.yaml`)

### 3.1 Suntek-Mgt Services

1. **`suntek-mgt-api`:**
   - **Type:** Web Service (`env: node`)
   - **Plan:** Starter
   - **Build Command:** `npm ci --workspace @healthos/api`
   - **Start Command:** `npm run start --workspace @healthos/api`
   - **Health Check Path:** `/healthz`
   - **Environment Variables:** `DATABASE_URL`, `REDIS_URL`, `APP_URL`, `JWT_SECRET`, `MSG91_AUTH_KEY`, `PRODUCT_MODE=mgt`

2. **`suntek-mgt-web`:**
   - **Type:** Static Site
   - **Build Command:** `npm run build:mgt` (or `VITE_APP_SURFACE=mgt npm run build --workspace @healthos/web`)
   - **Publish Directory:** `apps/web/dist`
   - **Routing:** Rewrite `/*` $\to$ `/index.html`

### 3.2 Suntek-ops Services

1. **`suntek-ops-api`:**
   - **Type:** Web Service (`env: node`)
   - **Plan:** Starter
   - **Health Check Path:** `/healthz`
   - **Environment Variables:** `DATABASE_URL`, `REDIS_URL`, `APP_URL`, `JWT_SECRET`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `PRODUCT_MODE=ops`

2. **`suntek-ops-admin-web`:**
   - **Type:** Static Site
   - **Build Command:** `VITE_APP_SURFACE=ops npm run build --workspace @healthos/web`
   - **Publish Directory:** `apps/web/dist`

3. **`suntek-ops-patient-web`:**
   - **Type:** Static Site
   - **Build Command:** `VITE_APP_SURFACE=patient npm run build --workspace @healthos/web`
   - **Publish Directory:** `apps/web/dist`

---

## 4. Zero-Downtime Transition & Backward Compatibility Gateway

During the transition phases (Phases 2 through 4), the existing `healthos-api` web service continues to mount all routes:

- `/api/v1/mgt/*` (New Mgt domain router)
- `/api/v1/ops/*` (New Ops domain router)
- `/api/v1/platform/*` (Platform router)
- Legacy `/api/v1/*` routes (e.g. `/api/v1/attendance`, `/api/v1/appointments`, `/api/v1/patients`) remain 100% active and mapped directly to domain handlers.

This guarantees that existing frontend clients and mobile users experience zero disruption.
