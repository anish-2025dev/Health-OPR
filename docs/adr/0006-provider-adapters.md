# 0006: Provider adapters for all external integrations

**Status:** Accepted

## Decision

Each external capability has an interface and one or more adapters under
`apps/api/src/integrations/<kind>/`:

| Kind      | Initial adapter                     | Dev/test adapter        |
| --------- | ----------------------------------- | ----------------------- |
| whatsapp  | Meta WhatsApp Business Cloud API    | Fake (records messages) |
| sms / otp | MSG91                               | Console/fake            |
| email     | Configurable transactional provider | Fake                    |
| storage   | S3-compatible                       | Local/in-memory         |
| payments  | Razorpay (later)                    | Fake                    |

Configuration selects the adapter. Business modules depend only on the interface. Webhook handlers
verify signatures, deduplicate by provider event id, acknowledge quickly and process asynchronously.

## Consequences

Vendors can be swapped, tests don't call real providers, and no credentials are needed in development.
