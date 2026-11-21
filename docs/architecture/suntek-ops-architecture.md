# Suntek-ops — Architecture Specification

**Product:** Suntek-ops (Hospital Management and Operations System)  
**Status:** Approved Architectural Specification (Phase 1)  
**Date:** 2026-11-21  
**Target Audience:** Engineering, Product, DevOps, Security

---

## 1. System Mission & Scope

Suntek-ops is an independent, high-throughput Hospital Management and Operations platform designed to handle patient registration, privacy consent lifecycle, doctor scheduling, transactional appointment booking, real-time outpatient queue management, and patient communication.

It operates as an independent, fully autonomous SaaS product that requires **zero runtime dependency** on workforce attendance, leave approvals, employee payroll, or HR management.

---

## 2. Core Functional Modules

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SUNTEK-OPS CORE DOMAINS                          │
├───────────────────────────────┬─────────────────────────────┬───────────────┤
│       PATIENT & PRIVACY       │     CLINICAL APPOINTMENTS   │  QUEUE & DESK │
├───────────────────────────────┼─────────────────────────────┼───────────────┤
│ • Phone as Contact Channel    │ • Doctor Profiles & Windows │ • Token Count │
│ • Family Profiles & Links     │ • Weekly Rosters & Slots    │ • Triage 0-2  │
│ • Consent & Privacy Notices   │ • Doctor Time-Off Blocks    │ • Call Next   │
│ • Duplicate Review & Merging  │ • Row-Lock Booking Counter  │ • Live Board  │
│ • Data Principal Rights (DPDP)│ • Idempotent Walk-ins       │ • Wait Est.   │
├───────────────────────────────┼─────────────────────────────┴───────────────┤
│    PATIENT WEB & MESSAGING    │            OPERATIONAL ANALYTICS            │
├───────────────────────────────┼─────────────────────────────────────────────┤
│ • Public Patient Portal (OTP) │ • Booking Volumes & Seen / No-Show Rates    │
│ • Privacy-Safe Tracking URL   │ • Average Waiting & Consultation Times      │
│ • WhatsApp Cloud API Bot      │ • Doctor Utilization & Peak Arrival Hours   │
│ • Consent-Aware SMS (MSG91)   │ • Branch Queue Throughput Metrics           │
└───────────────────────────────┴─────────────────────────────────────────────┘
```

### 2.1 Patient Registration & Identity Architecture

- **Contact-Channel Decoupling:** Phone numbers are treated strictly as communication channels, never as unique patient identities (`contacts` $\to$ `contact_patient_links` $\to$ `patients`). This allows family members sharing a single phone number to have independent clinical profiles.
- **Family Profile Linking:** Self profiles are instantly authorized; family members created via digital channels remain pending staff review until verified at reception.
- **Duplicate Detection & Merging:** Bigram name similarity calculation (threshold: 0.85) + Date of Birth matching. Suspected duplicates enter a staff review queue. Merging is non-destructive, preserving audit trails and redirecting active tokens and visits.

### 2.2 Patient Privacy & Digital Personal Data Protection (DPDP)

- **Immutable Privacy Notices:** Versioned privacy notices published and locked; every consent record references an exact version hash.
- **Granular Consent Tracking:** Purpose-specific consents (`privacy_notice`, `whatsapp_service`, `sms_service`, `marketing`).
- **Data Principal Rights:** Endpoints for data access, correction, erasure requests, and grievance logging.

### 2.3 Doctor Scheduling & Appointment Booking

- **Consultation Configuration:** Configurable consultation durations, daily booking limits, and advance booking windows per doctor.
- **Weekly Schedule Engine:** Day-of-week recurring schedules defining start/end times and slot capacity.
- **Doctor Time-Off:** Granular leave/time-off blocks that instantly close scheduling availability.
- **Race-Condition-Free Booking:** PostgreSQL row-level locks on the target doctor's record prevent concurrent double-booking. Idempotency keys prevent duplicate bookings from network retries.

### 2.4 Live Outpatient Queue Management

- **Token Allocation Engine:** Daily transactional token sequence per doctor (`queue_counters`).
- **Triage & Priority Routing:** Reception desk assigns priority tiers (0: Normal, 1: Urgent, 2: Emergency). "Call Next" automatically serves the highest priority waiting patient, breaking ties by token sequence.
- **Doctor Queue Isolation:** Doctors can view, call, start, and complete only visits assigned to their own queue. Receptionists have branch-wide queue oversight.

### 2.5 Privacy-Preserving Public Tracking & Waiting Displays

- **Public Tracking Link (`/track/:code`):** Unguessable 16-character alphanumeric tracking token. Displays live serving token, queue position, and estimated wait time. Strictly omits patient names, contact numbers, and medical conditions.
- **Waiting-Room TV Display (`/queue-display/:doctorId`):** Real-time display of current serving token and upcoming tokens.

### 2.6 Patient Portal (`PatientApp`) & Messaging Integrations

- **Standalone Patient Web:** Mobile-first web app using phone + OTP authentication (`healthos-patient` audience). Allows patients to book appointments, manage family profiles, and track live status.
- **WhatsApp Cloud API Integration:** Automated conversational bot for booking, cancellation, and queue updates.
- **SMS Gateway (MSG91):** Fallback notification delivery honoring patient communication consent preferences.

---

## 3. Database Ownership & Schema Architecture

All Suntek-ops tables are owned and managed by the Ops domain. Every tenant table contains `organization_id` with PostgreSQL Row-Level Security (RLS) **enabled and forced**.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          SUNTEK-OPS DATABASE TABLES                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ Clinic Administration:                                                      │
│   • patient_settings                                                        │
│                                                                             │
│ Patients & Privacy:                                                         │
│   • contacts                                                                │
│   • patients                                                                │
│   • contact_patient_links                                                   │
│   • privacy_notice_versions                                                 │
│   • consents                                                                │
│   • patient_duplicate_flags                                                 │
│   • data_principal_requests                                                 │
│                                                                             │
│ Doctors & Scheduling:                                                       │
│   • doctors                                                                 │
│   • doctor_schedules                                                        │
│   • doctor_time_off                                                         │
│                                                                             │
│ Appointments & Queue:                                                       │
│   • appointments                                                            │
│   • queue_counters                                                          │
│   • queue_entries                                                           │
│                                                                             │
│ Patient Portal & Auth:                                                      │
│   • patient_accounts                                                        │
│   • patient_otps                                                            │
│   • patient_account_sessions                                                │
│                                                                             │
│ WhatsApp & Messaging:                                                       │
│   • whatsapp_channels                                                       │
│   • whatsapp_inbound_events                                                 │
│   • whatsapp_conversations                                                  │
│   • notification_log                                                        │
│                                                                             │
│ Audit:                                                                      │
│   • audit_logs (Ops-scoped events)                                          │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Cross-Domain Decoupling Strategy

### 4.1 Resolving `doctors.department_id` Dependency

- **Current State:** `doctors.department_id` holds a foreign key to `departments.id` (owned by Suntek-Mgt).
- **Decoupling Solution:**
  1. Make `doctors.department_id` nullable and remove hard database-level foreign key constraint to `departments`.
  2. For standalone Suntek-ops deployments, `department_id` is optional or mapped to an internal clinical department lookup.
  3. When integrated with Suntek-Mgt, the department ID is populated via the sync integration adapter.

### 4.2 Resolving User Identity (`doctors.user_id`)

- Doctor profiles in Suntek-ops reference `users.id` for staff authentication.
- For standalone Suntek-ops, doctors are created directly via the clinical administration interface with clinical roles (`doctor`), completely decoupled from HRMS employee records.

---

## 5. Identity & Authentication Boundaries

Suntek-ops operates with three distinct authentication audiences:

1. **Clinic Staff (`healthos` Audience):**
   - Access token + `hos_refresh` cookie.
   - Roles: `doctor`, `nurse`, `receptionist`, `clinic_admin`.
   - Access restricted strictly to clinical routes (`/patients`, `/doctors`, `/appointments`, `/queue`, `/analytics/clinic`).
2. **Patient Portal (`healthos-patient` Audience):**
   - Scoped strictly to the authenticated patient account.
   - Access token + `hos_patient_refresh` cookie (30-day session).
   - Zero access to clinic administration, staff endpoints, or other patients' data.
3. **Public Queue Tracking:**
   - Unauthenticated, unguessable 16-character tracking codes (`/public/track/:code`).
