# ADR 0001: Call Recording Consent And Retention

- Status: Accepted
- Decision date: 2026-07-11
- Implementation status: Documentation only

## Context

Future call personalization may use Google Meet recordings and transcripts. Recording must not be enabled without an explicit choice from the person booking the call, and retained transcripts need a defined lifecycle.

## Decision

Cal.com booking will require an explicit Yes or No recording-consent choice.

- If Yes is selected, the application may enable Google Meet recording and transcription.
- If No is selected, the meeting proceeds normally without transcript-based personalization.
- Nonbuyer transcripts will be retained for 90 days.
- Client transcripts will be retained for the active Sprint or Accelerator term plus 12 months.

## Consequences

The consent answer must be auditable and associated with the booking before recording settings are changed. Transcript-dependent follow-up must have a report-only fallback. Retention jobs must distinguish nonbuyers from active and former clients.

No Cal.com, Google OAuth, Google Meet, transcript, or retention functionality is implemented by this ADR.
