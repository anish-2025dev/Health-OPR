# Platform Console — Architecture Specification

**Product:** Platform Console (Operator Control Plane)  
**Status:** Approved Architectural Specification (Phase 1)  
**Date:** 2026-11-21  
**Target Audience:** Engineering, Product, DevOps, Security

---

## 1. System Mission & Scope

The Platform Console is the operator control plane for the Suntek Ecosystem. It enables platform super-administrators to onboard healthcare organizations, provision tenant branches, manage owner onboarding invitations, control tenant operational lifecycles, and audit platform activities.

It is completely isolated from tenant application data: platform administrators have **no access** to tenant patient records, employee salaries, attendance logs, or clinical data.

---

## 2. Core Functional Modules

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PLATFORM CONSOLE MODULES                           │
├───────────────────────────────┬─────────────────────────────┬───────────────┤
│    OPERATOR AUTHENTICATION    │      TENANT PROVISIONING    │  ONBOARDING   │
├───────────────────────────────┼─────────────────────────────┼───────────────┤
│ • platform_admins credentials │ • Organization Onboarding   │ • Invite Links│
│ • Dedicated JWT Audience      │ • Slug Reservation         │ • 7-Day Expire│
│ • Argon2 Password Hashing     │ • Initial Branch Setup      │ • Token Hash  │
│ • Platform Session Cookies    │ • Product Entitlements      │ • One-Time Use│
├───────────────────────────────┼─────────────────────────────┴───────────────┤
│       LIFECYCLE MANAGEMENT    │              OPERATOR AUDIT LOGS            │
├───────────────────────────────┼─────────────────────────────────────────────┤
│ • Organization Suspension     │ • Append-Only Platform Audit Trail          │
│ • Organization Reactivation   │ • IP Address & User-Agent Tracking          │
│ • Organization Renaming       │ • Actor ID & Target Organization Scoping    │
└───────────────────────────────┴─────────────────────────────────────────────┘
```

---

## 3. Database Ownership & Schema Architecture

All Platform Console tables are platform-level tables (not scoped to an individual tenant organization):

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PLATFORM CONSOLE DATABASE TABLES                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ Operator Identity & Sessions:                                               │
│   • platform_admins                                                         │
│   • platform_sessions                                                       │
│                                                                             │
│ Tenant Foundation & Invites:                                                │
│   • organizations (platform-level attributes & status)                      │
│   • branches (initial branch provisioning)                                  │
│   • user_invites (single-use hashed invitation tokens)                      │
│                                                                             │
│ Operator Observability:                                                     │
│   • platform_audit_logs                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Authentication & Security Boundary

1. **Non-Interchangeable JWT Token Audience:**
   - Platform tokens are signed with audience `healthos-platform`.
   - Cannot be used against any tenant API endpoint (`/api/v1/mgt/*`, `/api/v1/ops/*`).
   - Tenant tokens (`healthos`, `healthos-patient`) are rejected by the platform router with HTTP 401/403.
2. **Session Cookie Isolation:**
   - Platform session cookie is named `hos_platform_refresh`, completely separated from tenant session cookies (`hos_refresh`, `hos_patient_refresh`).
3. **No Direct Tenant Data Access:**
   - Platform APIs are restricted strictly to `/api/v1/platform/*`.
   - Operators can never inspect patient tables, attendance punches, or payroll records.
