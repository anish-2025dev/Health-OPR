# Suntek Ecosystem — Inter-Product Integration Contracts

**Document:** Integration Contracts Specification  
**Status:** Approved Architectural Specification (Phase 1)  
**Date:** 2026-11-21  
**Target Audience:** Engineering, Product, Integration Architecture

---

## 1. Overview & Integration Philosophy

When an organization subscribes to both **Suntek-Mgt** and **Suntek-ops**, the two products can integrate to synchronize shared operational data while maintaining complete fault tolerance and loose coupling.

### Principles:

1. **Zero Hard Dependencies:** Neither product requires the other to function. If Suntek-Mgt is unavailable, Suntek-ops continues booking appointments, serving the queue, and managing patients without interruption.
2. **Asynchronous / Event-Driven Resiliency:** Integration operations are idempotent and tolerant of network retries.
3. **Explicit Boundary Verification:** Integration requests carry explicit HMAC signatures and idempotency keys.

---

## 2. Integration Contracts

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          INTER-PRODUCT INTEGRATION                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌──────────────┐         Contract 1: Employee Sync         ┌───────────┐  │
│   │              ├──────────────────────────────────────────►│           │  │
│   │              │         Contract 2: Branch Sync           │           │  │
│   │  Suntek-Mgt  ├──────────────────────────────────────────►│ Suntek-ops│  │
│   │    (HRMS)    │                                           │  (Clinic) │  │
│   │              │     Contract 3: Leave to Time-Off Feed    │           │  │
│   │              ├──────────────────────────────────────────►│           │  │
│   └──────────────┘                                           └───────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

### Contract 1: Clinical Staff Synchronization (`Mgt -> Ops`)

Syncs clinical employees (Doctors, Nurses) from Suntek-Mgt into Suntek-ops doctor/staff records.

- **Endpoint:** `POST /api/v1/integration/sync/doctors`
- **Headers:**
  - `Content-Type: application/json`
  - `X-Suntek-Signature: <hmac_sha256_hex>`
  - `Idempotency-Key: <uuid>`
- **Request Payload:**

```json
{
  "organization_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "employee_id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "full_name": "Dr. Sarah Jenkins",
  "email": "sarah.jenkins@hospital.org",
  "mobile_number": "+919876543210",
  "department_name": "Cardiology",
  "designation_name": "Senior Consultant",
  "branch_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "consultation_duration_minutes": 15,
  "status": "active"
}
```

- **Response (`200 OK` / `201 Created`):**

```json
{
  "status": "success",
  "doctor_id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "action": "synced"
}
```

---

### Contract 2: Branch & Facility Mapping (`Mgt -> Ops`)

Synchronizes organizational branches, physical addresses, and operational zones.

- **Endpoint:** `POST /api/v1/integration/sync/branches`
- **Request Payload:**

```json
{
  "organization_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "branch_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "branch_name": "Downtown Medical Center",
  "timezone": "Asia/Kolkata",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "geofence_radius_meters": 150,
  "status": "active"
}
```

---

### Contract 3: Approved Leave to Doctor Time-Off Feed (`Mgt -> Ops`)

When an employee with clinical role has leave approved in Suntek-Mgt, this event automatically creates a `doctor_time_off` block in Suntek-ops to prevent patient booking during the doctor's absence.

- **Endpoint:** `POST /api/v1/integration/events/leave-approved`
- **Request Payload:**

```json
{
  "organization_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  "employee_id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "leave_request_id": "8f8b506b-2856-47b2-89b5-4b0d0c3260c6",
  "start_date": "2026-12-01",
  "end_date": "2026-12-05",
  "reason": "Annual Leave"
}
```

- **Response (`200 OK`):**

```json
{
  "status": "success",
  "time_off_ids": ["c0a80101-0000-0000-0000-000000000001"],
  "blocked_booking_count": 0
}
```

---

## 3. Security & Validation Controls

1. **HMAC Signature Verification:** Requests are signed using a shared tenant secret with HMAC-SHA256 (`X-Suntek-Signature`).
2. **Replay Attack Mitigation:** Timestamp included in signed headers; timestamps older than 300 seconds are rejected.
3. **Idempotency:** All integration handlers maintain an idempotency table preventing duplicate processing of retried events.
