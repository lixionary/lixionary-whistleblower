# Intended reporting flow

This guide follows a concern from the reporter's first visit through investigation, closure, and possible reopening. For review date, source revision, and historical-document differences, see the [documentation index](README.md).

## 1. Participants and responsibilities

- **Reporter:** submits a concern, saves private access credentials, reviews anything shared with staff, and returns to the case portal for follow-up. No staff account is required.
- **Case manager (`manager`):** receives cases routed to their team, handles initial review and conflicts, assigns investigators, oversees protection and deadlines, and reviews closure proposals made by another person.
- **Case analyst (`analyst`):** investigates cases explicitly assigned to them within their current team. Analysts can communicate with reporters, review approved evidence, record findings and actions, and propose closure.
- **System administrator (`admin`):** configures staff, teams, company policy, categories, deadlines, and retention. This role has no case-content access through the staff case API.
- **Privacy service:** holds optional contact destinations, private assistant conversations, and sealed evidence originals separately from the case workspace. Application staff have no contact-reveal endpoint.

The manager role and case ownership are separate concepts: an analyst can be the case owner, while managers retain oversight of cases in their team. See the [manager guide](case-manager-guide.md) and [analyst guide](case-analyst-guide.md).

## 2. Before opening the reporting channel

An administrator configures the company policy and privacy notice in English and Indonesian, categories, any business units, acknowledgment and follow-up intervals, and retention periods for cases, contacts, evidence, transcripts, audit, and backups.

The deployment needs a normal reporting team and an independent restricted team. Saving complete settings requires at least two active managers in each team and no overlapping membership between the configured teams. Production submission is blocked until company setup is complete. Staff authenticate with mandatory MFA; Google sign-in, when configured, still requires local MFA.

These are setup checks, not a guarantee that later staff changes preserve reviewer availability. The administrator and managers should keep enough unconflicted reviewers available.

Source: [company configuration and teams](../apps/server/src/routes/admin.ts), [staff authentication](../apps/server/src/auth.ts), [Google login](../apps/server/src/routes/google.ts).

## 3. Reporter entry and submission

1. Open `/` and choose **Report**, which opens `/report`. English and Indonesian are available.
2. Read the company policy and privacy notice and acknowledge reading them.
3. Enter a title, summary, and category. Additional details can describe what happened, who was involved, when, where, why, how, how the reporter knows, available evidence, impact, and whether the conduct continues. These additional details are optional; uncertainty can be stated explicitly.
4. Select a relationship: employee, former employee, contractor/supplier, or external. Select a business unit if offered.
5. Mark the report sensitive if it involves leadership or the reporting team. This selects the independent restricted route.
6. Optionally supply an email for private notifications. Leaving it blank is supported. Optional AI consent appears when the company enables AI.
7. Review the narrative for identifying or unnecessary sensitive details, confirm the review, and submit.

The current form starts directly with the report. Email verification is **not an admission step**. The optional email is removed from the staff-visible report and stored in the privacy service. Uploaded evidence is handled later, from the case portal.

The server checks the current policy version and configured categories/business units. If the policy changes while the form is open, the reporter must review the updated policy and confirm again. Submission retries from the same page reuse the submission identifier and credentials to avoid creating duplicate cases. Unsaved form and retry state are held in browser memory.

```mermaid
flowchart TD
    Start["Open the reporting portal"] --> Policy["Read policy and privacy notice"]
    Policy --> Form["Complete the report form"]
    Form --> Options["Choose sensitive routing and optional email or AI consent"]
    Options --> Review["Review content and confirm submission"]
    Review --> Create["Create case in received state"]
    Create --> Route{"Sensitive report?"}
    Route -->|No| Normal["Route to normal team"]
    Route -->|Yes| Restricted["Route to independent restricted team"]
    Normal --> Alert["Queue a generic staff alert"]
    Restricted --> Alert
    Create --> Receipt["Display case code, access secret, and recovery secret"]
    Receipt --> Email{"Optional email challenge offered?"}
    Email -->|Yes| OTP["Verify email now, or defer until later"]
    Email -->|No| Save["Save credentials and confirm they are saved"]
    OTP --> Save
    Save --> Portal["Open the private case portal"]
```

Source: [public home](../apps/web/src/app/page.tsx), [report form](../apps/web/src/app/report/page.tsx), [submission API](../apps/server/src/routes/reporter.ts), [current report schema](../packages/shared/src/suite.ts), [privacy reservation](../apps/privacy/src/admission.ts).

## 4. Receipt, notifications, and returning to a case

The receipt displays three values:

- **Case code:** identifies the case.
- **Access secret:** called `pin` in the API; used with the case code to sign in again.
- **Recovery secret:** called `recoveryCode` in the API; used with the case code to recover access if the access secret is lost.

The reporter can copy or download these credentials and must confirm saving them before proceeding. Submission also starts a reporter session. Receipt secrets are not kept as retrievable plaintext by the server; reloading an unsaved receipt can lose them.

If an email was supplied and email delivery is configured, the receipt offers a six-digit OTP to activate notifications. The challenge lasts five minutes. Verification can be deferred, and contacts can be added or managed later in `/case`. Email and phone contacts depend on the corresponding delivery provider being configured. Only verified contacts with notifications enabled receive generic alerts to return to the portal.

Verification proves control of a destination. It does not establish legal identity, employment, or whether an allegation is true. Optional notification contacts do not enable email-based case recovery.

On a later visit, the reporter opens `/case` and signs in with their case code and access secret. Recovery replaces both secrets and invalidates earlier access sessions/capabilities. The reporter must save the replacements. There is no email lookup or staff recovery override; losing access to both secrets leaves no supported recovery path.

Source: [receipt component](../apps/web/src/components/suite/common.tsx), [case portal](../apps/web/src/app/case/page.tsx), [reporter sessions and recovery](../apps/server/src/routes/reporter.ts), [private contacts](../apps/privacy/src/app.ts), [notification delivery](../apps/privacy/src/jobs.ts).

## 5. What happens after submission

The case starts as `received`, routed to the configured normal or restricted team. No individual owner is automatically selected. Team managers can see it without individual assignment, and a generic staff alert is queued.

The intended handoff is:

1. A manager opens the case, checks conflicts, acknowledges receipt, and moves it into triage.
2. The manager assesses category, severity, protection needs, and whether restricted handling is necessary.
3. The manager assigns an eligible analyst or manager as owner and coordinates investigation.
4. Assigned analysts gather facts through the portal, record findings, and track actions.
5. An authorized investigator proposes closure after completing recorded actions.
6. A manager other than the proposer approves closure or returns the case to investigation.

```mermaid
sequenceDiagram
    actor R as Reporter
    participant P as Reporting portal
    participant M as Team case manager
    participant A as Assigned analyst
    participant V as Manager other than proposer
    R->>P: Submit reviewed report
    P-->>R: Receipt and private access credentials
    P-->>M: Case becomes visible and staff alert is queued
    M->>P: Check conflict, acknowledge, and triage
    M->>P: Assign eligible analyst and owner
    P-->>A: Assigned case access and queued alert
    A->>P: Ask follow-up questions
    R->>P: Send reviewed replies and approve evidence
    A->>P: Record findings and complete actions
    A->>P: Propose closure with internal and public explanations
    P-->>V: Queue closure-review alert
    alt Closure approved
        V->>P: Approve with review reason
        P-->>R: Show closed state and public explanation
    else More investigation required
        V->>P: Reject with review reason
        P-->>A: Case returns to investigating
    end
```

An arrow for a queued alert does not mean delivery is immediate or guaranteed. Staff alerts contain a sign-in link, not case content. The portal is the working record.

Source: [case workflow](../apps/server/src/routes/cases.ts), [staff access and case views](../apps/server/src/service.ts), [staff notification jobs](../apps/server/src/jobs.ts).

## 6. Reporter mailbox, evidence, and optional AI

### Portal messages

The reporter and authorized staff exchange messages inside the case portal. Reporters confirm reviewing outgoing content. Staff messages are visible to the reporter, while investigation notes, findings, task details, protection plans, and internal closure rationale remain in the staff workspace. Staff messages appear as staff messages rather than disclosing the sender's staff identity in the reporter case view.

### Evidence

After submission, the reporter can upload images, PDFs, or supported Office files in `/case`. The privacy service seals the original, creates a sanitized preview, and lets the reporter review every page and apply permanent redactions. Only the reviewed version explicitly approved by the reporter is published to the staff evidence workspace. Processing can fail; an uploaded file is not automatically shared evidence.

```mermaid
flowchart LR
    Upload["Reporter uploads evidence in case portal"] --> Seal["Seal original in private storage"]
    Seal --> Convert["Create sanitized preview"]
    Convert --> Review["Reporter reviews every page"]
    Review --> Redact{"More redaction needed?"}
    Redact -->|Yes| Apply["Apply redaction and refresh preview"]
    Apply --> Review
    Redact -->|No| Approve["Reporter explicitly approves reviewed version"]
    Approve --> Publish["Publish approved derivative to case workspace"]
    Publish --> Staff["Authorized managers and analysts inspect evidence"]
```

### Optional private assistant

With company enablement, provider configuration, and reporter consent, the assistant can ask follow-up questions after the report has been submitted and the case portal opened. It uses the submitted information to clarify missing facts; it does not take the manager's or analyst's role.

The raw conversation and generated review drafts stay in the privacy service. **Review update** produces an editable structured follow-up. Only an update explicitly reviewed and shared by the reporter becomes a case mailbox message. The original report remains unchanged.

AI allows 30 message attempts, including initialization, and three update-generation attempts per case per UTC day. Provider failures consume an attempt; replaying an existing request does not. Declining AI, provider failure, or exhausted AI allowance does not prevent ordinary reporting or case access. Retention and legal holds apply to private history; it is not promised indefinitely.

```mermaid
flowchart TD
    Case["Open submitted case"] --> Consent{"AI enabled and reporter consents?"}
    Consent -->|No| Mailbox["Use ordinary case mailbox"]
    Consent -->|Yes| Chat["Private assistant follow-up"]
    Chat --> Draft["Generate review update"]
    Draft --> Edit["Reporter edits and reviews update"]
    Edit --> Decision{"Share approved update?"}
    Decision -->|No| Private["Keep draft private"]
    Decision -->|Yes| Share["Append approved text to case mailbox"]
    Share --> Staff["Authorized staff read shared update"]
```

Source: [case portal](../apps/web/src/app/case/page.tsx), [evidence UI](../apps/web/src/components/suite/evidence.tsx), [private evidence and contact API](../apps/privacy/src/app.ts), [assistant UI](../apps/web/src/components/suite/case-conversation.tsx), [private conversation processing](../apps/privacy/src/conversation.ts).

## 7. Case states and transitions

These are the current suite states. Older `new`, `under_review`, and `closed_resolved` definitions in [status.ts](../packages/shared/src/status.ts) do not describe this workflow.

```mermaid
stateDiagram-v2
    [*] --> received: Report submitted
    received --> triage: Start initial assessment
    triage --> investigating: Begin investigation
    investigating --> waiting_reporter: Await reporter information
    waiting_reporter --> investigating: Staff resumes investigation
    triage --> closure_review: Propose closure with no open tasks
    investigating --> closure_review: Propose closure with no open tasks
    waiting_reporter --> closure_review: Propose closure with no open tasks
    closure_review --> investigating: Different manager rejects proposal
    closure_review --> closed: Different manager approves proposal
    closed --> investigating: Manager reopens with reason
```

Acknowledgment is a separate timestamp, not a state. Explicit acknowledgment, the first ordinary state transition, or a staff message can set it. Merely opening, assigning, or classifying a case does not acknowledge it. A reporter reply does not automatically move `waiting_reporter` back to `investigating`; staff make that transition.

Restricted escalation changes the team and access rather than creating a separate lifecycle state. Closure must use the proposal and review actions; a direct state change to `closed` is rejected.

Source: [current state definitions](../packages/shared/src/suite.ts), [transition and closure routes](../apps/server/src/routes/cases.ts).

## 8. Closure, feedback, retaliation, and reopening

Approved closure shows the reporter the public explanation. Ordinary messages, new evidence uploads, and new assistant work are unavailable while closed. Existing retained case information remains accessible with case credentials.

The reporter can:

- Submit one feedback response with 1–5 ratings for trust, communication, and protection.
- Report retaliation or detriment, including after closure. This records the concern, flags the case, and queues staff attention; it does not reopen the case automatically.
- Request reopening with a reason. This records a request for staff; a manager must separately reopen the case.

Managers should reopen a closed case when new information or protection concerns require further investigation. Reopening returns it to `investigating`, preserves the previous closure in an internal record, and allows normal work again.

Configured retention can eventually delete closed case data unless a legal hold applies. Optional contacts, transcripts, and evidence have their own retention treatment. Contact isolation does not prevent a narrative, distinctive circumstance, or document from identifying someone; reporter review remains necessary.

Source: [reporter follow-up, feedback, detriment, and reopen requests](../apps/server/src/routes/reporter.ts), [manager reopening and holds](../apps/server/src/routes/cases.ts), [case retention jobs](../apps/server/src/jobs.ts), [private retention jobs](../apps/privacy/src/jobs.ts).
