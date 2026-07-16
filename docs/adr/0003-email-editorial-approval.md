# ADR 0003: Email Editorial Approval

- Status: Accepted
- Decision date: 2026-07-11
- Implementation status: Documentation only

## Context

Launch Club V3 will eventually send report-delivery, lifecycle, and nurture email through Resend. Marketing and personalized copy needs a reviewable editorial source before any automation can send it.

## Decision

- Google Docs is the editorial source of truth for Launch Club email copy.
- Every email uses one of these states: Draft, Needs revision, Approved for implementation, Implemented, or Live.
- No nurture email may become active until its Google Docs copy is marked Approved for implementation.
- The report-delivery email also requires review before production use.
- Application templates will eventually be versioned.
- Resend will eventually deliver approved application templates.

## Consequences

Implementation must record the approved source version and must prevent Draft or Needs revision copy from becoming sendable. Editing application code alone will not constitute editorial approval.

No Resend integration, template activation, email scheduling, or email sending is implemented by this ADR.
