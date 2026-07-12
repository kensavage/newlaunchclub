# ADR 0002: Stripe Sprint Purchase

- Status: Accepted
- Decision date: 2026-07-11
- Implementation status: Documentation only

## Context

The Opportunity Report will eventually offer a direct purchase path for the Launch Club Sprint. The commercial terms and supported checkout behavior must be fixed before payment code is introduced.

## Decision

- The Sprint is a fixed $3,000 one-time Stripe Checkout purchase.
- The Stripe Product and Price do not exist yet.
- The application will eventually read the Price ID from an environment variable.
- Card and Link will be supported.
- Promotion codes will be allowed.
- Payment plans and manual invoicing will not be offered.
- A verified successful Stripe webhook will be the purchase source of truth.

## Consequences

The future integration must create Checkout Sessions server-side and must never accept a browser-supplied amount or Price ID. Fulfillment must be webhook-driven and idempotent.

No Stripe product, price, checkout, webhook, environment variable, or production configuration is created by this ADR.
