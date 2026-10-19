# Reporting and case handling documentation

These guides explain the intended operating journey and the behavior supported by the current application. Start with the reporting flow, then read the guide for your staff role.

- [Reporting flow](reporting-flow.md): anonymous submission, receipt, private mailbox, optional AI, evidence, and the complete case lifecycle.
- [Case manager guide](case-manager-guide.md): receiving cases, taking responsibility, triage, analyst assignment, independent escalation, closure review, and reopening.
- [Case analyst guide](case-analyst-guide.md): joining an assigned case, investigating, communicating with the reporter, recording findings and actions, and proposing closure.

## Scope and evidence

Reviewed on **19 October 2026**, against local source revision **`af42998`**, application version **`1.1.0`**. These are repository-based workflow guides; production configuration, delivery, and signed-in UI behavior were not verified for this review. Source links in each guide identify the implementation behind the described behavior. Referenced tests were inspected, not rerun.

“Intended practice” describes how the team should operate the available features. “Implementation boundary” identifies a distinction between that practice and what the application actually enforces. This documentation does not establish a regulatory certification or a jurisdiction-specific reporting obligation.

## Important changes from older documentation

The current application accepts a report **without an account, an employee-directory lookup, or email verification before submission**. A reporter may optionally provide an email and verify it **after submission** to activate case notifications. The employee directory and access-request administration endpoints have been removed.

Some introductory text in the root [README](../README.md) and earlier sections of [implementation.md](implementation.md) still describe the older email admission gate. The ISO alignment section of `implementation.md` also uses some field names and values that differ from current source. Use the current schemas and routes linked in these guides for the workflow described here. [gaps.md](gaps.md) explicitly describes the historical MVP and proposed improvements rather than the current suite.

Current source evidence:

- [Report form](../apps/web/src/app/report/page.tsx) and [report submission API](../apps/server/src/routes/reporter.ts).
- [Private submission reservation and optional email challenge](../apps/privacy/src/admission.ts).
- [Current roles, states, relationships, protection risks, and closure schemas](../packages/shared/src/suite.ts).
- [Access checks and staff/reporter case views](../apps/server/src/service.ts).
- [Case workflow API](../apps/server/src/routes/cases.ts).
- [Integration test source](../apps/server/test/suite.test.ts), especially the direct anonymous submission, post-submission email verification, assignment, independent closure, escalation, and protection scenarios.

## Other documentation

- [Implementation and historical validation](implementation.md).
- [Deployment and operations runbook](runbook.md).
- [Historical MVP gap assessment](gaps.md).
