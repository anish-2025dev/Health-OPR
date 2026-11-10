# Backend modules

Each business capability is a module in this folder. Modules are added phase by phase. Planned modules:
`authentication`, `organizations`, `branches`, `staff-access`, `contacts`, `patients`, `family`,
`consent`, `doctors`, `appointments`, `queue`, `notifications`, `whatsapp`, `hr-employees`,
`hr-attendance`, `hr-shifts`, `hr-leave`, `hr-payroll`, `hr-compliance`, `audit` and `analytics`.

## Convention

```
modules/<name>/
  index.js          # public surface: exports the router and any service other modules may call
  <name>.routes.js  # HTTP layer: parse/validate input (zod), call the service, shape the response
  <name>.schemas.js # zod request/response schemas
  <name>.service.js # business rules and transactions; no req/res objects
  <name>.repository.js # database access only (knex); always scoped by organization_id
  <name>.permissions.js # permission names and checks for this module
```

Create only the files a module actually needs.

## Rules

- Other modules import only from a module's `index.js`. Never reach into another module's repository.
- Every repository function that touches tenant-owned data takes the tenant context and filters on
  `organization_id` (and `branch_id` where it applies). PostgreSQL RLS is a second line of defence, not
  a replacement.
- Authorization happens on the backend in routes/services. Hiding something in the UI does not count.
- Booking, token generation and payroll finalization run inside database transactions.
- Statutory rates, ceilings and thresholds come from effective-dated rule records, never from constants
  in code.
- Every schema change ships as a migration in `src/db/migrations`, and every business rule ships with tests.
