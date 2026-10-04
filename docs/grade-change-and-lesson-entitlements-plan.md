# Grade Changes, Lesson Entitlements, and Subscription Pricing Plan

## Status and scope

- Phase 1 pricing and the one-subject minimum/default are implemented.
- Phase 2 grade changes and explicit history restoration are implemented, verified, and deployed.
- Phase 3 paid-plan assignment checks, lesson-mode restrictions, and per-subject lesson quotas are implemented, verified, and deployed.
- Firestore rules/indexes and Hosting are deployed; live signed-in account flows remain to be exercised with a test account.
- No user, payment, subscription, subject, lesson, or history records are deleted by this work. The developer will clear development records separately before testing the new pricing data.

## Confirmed product rules

### Subject history and grade changes

1. Changing grade cancels every active subject enrollment using the existing cancellation model. It does not delete the old subject episode or its records.
2. The student must select subjects again for the destination grade. No old subjects are selected automatically.
3. A cancelled subject episode is eligible for history restoration only when its grade equals the destination grade and its cancellation date is less than three calendar months old.
4. Restoration is opt-in per subject. If selected, copy only the topic documents and their `understandingScores` records. Do not copy staff assignments, lessons, exercises, reports, or other records. If not selected, create a fresh subject episode.
5. The student's active subscription subject count is the maximum number of destination-grade subjects they can add or restore. Enforce this in the UI and again in trusted server logic.

### Subscription access and lesson quotas

1. Free plan students cannot receive a new tutor assignment or be scheduled into lessons.
2. Circle students can be scheduled for group lessons only.
3. Personalized students can be scheduled for group and one-on-one lessons.
4. For each subject in one paid subscription window:
   - Circle: up to 4 group lessons.
   - Personalized: up to 4 one-on-one lessons and 2 group lessons.
5. A quota window starts when payment activates (or renews) the subscription and ends at its renewal date. Do not use calendar-month boundaries. A lesson must fall inside the student's active window.
6. Count planned, completed, and missed lessons. Exclude cancelled lessons. For a group session, count one lesson against each participating student's own subject allowance.
7. A requested plan downgrade remains pending until the current renewal date. The current plan's scheduling modes and remaining quotas stay available until that date; the new plan's entitlements begin only after it activates.

### Prices and subject count

| Plan | First subject, monthly | Each additional subject, monthly | Lessons in one subscription window per subject |
| --- | ---: | ---: | --- |
| Free | R0 | R0 | No tutor or scheduled lesson access |
| Circle | R199 | R49 | 4 group |
| Personalized | R999 | R599 | 4 one-on-one + 2 group |

- Paid subscriptions allow 1 to 20 subjects. The default selection is 1.
- Free remains at 0 registered paid subjects.
- Preserve the current yearly discount of 2 free months: annual charge is 10 times the corresponding monthly total. Lesson allowances still apply once per actual activation-to-renewal window; a yearly plan therefore has one quota window between annual renewals.

## Implementation findings

- `changeStudentGrade` now cancels current subject episodes, ends staff memberships, cancels planned lessons, updates the student's grade, and creates no replacement subjects automatically. It restores only explicitly selected matching histories.
- `updateStudentSubjects` restores a recent same-grade history only when its cancelled episode ID is explicitly supplied. Fresh additions do not copy history. New and restored subject episodes receive the active subscription's per-subject quota ledger.
- `assignStudentToTutor` verifies a matching successful payment, active paid subscription, and subject capacity before assigning a primary tutor.
- Planned lesson creation, group roster changes, cancellation, and unscheduled lesson-log reservation now use trusted callables. Lesson completion and topic-score persistence remain in the frontend with restricted Firestore rules.
- Quota windows start at successful Paystack activation/renewal. Each active subject stores the cycle ID, plan, window dates, and separate group/one-on-one grant, carried-in, used, and remaining counts. Successful renewal carries forward unused mode balances; failed or pending renewal does not advance the ledger.
- Frontend and Functions pricing use the confirmed one-subject first-price model: Circle R199 + R49 per additional subject and Personalized R999 + R599 per additional subject. The development data reset remains necessary before testing legacy payment records against this pricing.

## Implementation plan

### Phase 1: Pricing engine and validation

Completed.

1. Update the frontend and Functions plan definitions with the confirmed prices and allowances in the table above.
2. Change the paid subject minimum and default from 2 to 1, preserving the 20-subject maximum. Update signup query defaults, billing-page fallbacks, the subject-count control, frontend effective-subscription validation, and Functions quote validation so all entry points agree.
3. Keep the frontend quote and Functions quote equivalent. Functions remain authoritative for Paystack initialization, payment amount verification, renewal charges, subject-capacity validation, and paid exercise access.
4. Update the plan selector copy and quote output so it displays the new subject rates and the Circle/Personalized lesson allowances per subscription window. Add separate group and one-on-one allowance values to the quote instead of presenting Personalized as only one-on-one.
5. Keep the existing annual discount. Do not migrate or delete existing data. Because payment verification recomputes the quote from the current pricing rules, old test subscriptions and payment records must be cleared before testing the new prices; the developer will perform that reset separately.

### Phase 2: Grade change and explicit history restoration — completed

1. Change the grade-transition operation to cancel each active subject episode, end its active tutor/staff membership, and update the student's grade without automatically creating replacement episodes.
2. Cancel future planned lessons associated with the old active episodes as part of the transition. Leave completed lesson, exercise, topic, score, report, and submission data in the cancelled episode for audit/history.
3. Provide an authenticated server-side way to list eligible cancelled episodes for the destination grade. Eligibility is based on matching destination grade and `cancelledAt` within the last three calendar months.
4. Show the eligible subjects as unselected choices and state the student's current plan subject capacity. The student explicitly selects which eligible histories to restore. Enforce the selection limit on both client and server.
5. For an opted-in subject, create a new active episode and copy only its `topics` documents and nested `understandingScores`. Preserve provenance to the old episode. Do not copy tutors/staff, lessons, exercises, reports, or other history.
6. For a subject added without opting into an eligible history, create a fresh episode. Keep the old cancelled episode intact.
7. Update `DATABASE_RESTRUCTURE_PLAN.md` so it no longer says grade changes always start with zero topics and no carry-over.

### Phase 3: Tutor assignment and lesson scheduling entitlements — completed

1. Add a shared server-side entitlement check that reads the student's effective subscription, including the active renewal window and any valid payment/grace status. The subscription/payment record remains authoritative for payment and plan status. Each active student-subject document is the source of truth for that subject's lesson quota and usage, and stores the active quota window ID, window start, and renewal date so scheduling can validate and update the quota at the subject level.
2. In `assignStudentToTutor`, reject new assignments when the student's effective plan is Free or the paid plan is not active for the requested subject. Keep the existing admin and approved-tutor checks.
3. Keep useful immediate UI feedback in the tutor/admin pages, but treat the server check as authoritative.
4. Enforce lesson access for every student in a session:
   - Free: reject group and one-on-one scheduling.
   - Circle: allow group only.
   - Personalized: allow group or one-on-one.
5. Enforce the lesson date inside the effective plan's `[activation time, renewal date)` window. If a downgrade is pending, use the current plan through its renewal date; do not use the pending plan early.
6. Store per-mode quota and usage fields on each active student-subject document. Include the current cycle grant, any carried-forward balance, scheduled/used amount, remaining amount, window start, renewal date, and cycle identifier. A tutor's successful lesson scheduling atomically reserves/decrements one lesson from that student's subject quota. Completion and missed status keep that reservation consumed; cancellation releases it. A group lesson updates each participating student's own subject document. Lesson rows remain the audit trail, but do not replace the subject document as the quota source of truth.
7. On successful initial payment or activation, initialize the quota ledger and window fields on every active subject document. On a successful renewal, atomically advance each active subject's cycle and add its remaining unused quota to the new cycle's allowance, split by lesson mode. Do not roll quota forward before payment succeeds. Pending downgrades retain the old plan's quota and access through the paid renewal date; after renewal, apply the renewed plan's mode restrictions while preserving the carried quota in the subject ledger.
8. Move only the security-sensitive planned-session creation and roster/quota mutations behind trusted Functions. Keep lesson completion, tutor score entry, and score review in the frontend where existing Firestore permissions safely allow them.
9. Add or tighten Firestore rules so clients cannot bypass plan or quota checks by writing lesson schedule rows or quota fields directly.

## Verification checklist

- Grade change leaves no active old-grade subject episodes, creates no replacements automatically, and retains old episode records.
- History candidates are limited to the destination grade and the three-calendar-month cutoff; an unchecked candidate is never copied.
- Restoring copies topics and understanding scores only, without staff, lesson, exercise, report, or submission documents.
- The subject limit is enforced for restored and fresh subjects, including a one-subject subscription.
- Free assignment and scheduling are rejected server-side. Circle rejects one-on-one; Personalized accepts both modes.
- The active subject document is authoritative for each student's per-subject, per-mode quota, usage, remaining balance, window start, and renewal date; scheduling updates it atomically and lesson rows provide the audit trail.
- Quotas are calculated from activation through renewal, reserve planned lessons, keep completed/missed lessons consumed, release cancelled lessons, and are applied independently per student and subject.
- Successful renewal advances each active subject's quota window and adds unused per-mode quota to the new cycle; failed or pending renewal never advances the quota window.
- A pending downgrade preserves the current plan's scheduling rights until renewal; no lesson may be scheduled beyond the current renewal date under the current plan.
- Frontend, Functions, Paystack initialization/verification, renewal charging, and access validation produce identical prices for 1, 2, and additional subjects on monthly and annual billing.
- Build, frontend lint, Functions lint, and quote-parity checks passed on 2026-10-04. Frontend lint reports five existing warnings and no errors; Functions lint is clean.
- Firestore rules and required indexes deployed on 2026-10-04. Only affected Functions were deployed, followed by Hosting at https://examifying.web.app; the live Hosting URL returned HTTP 200 and the deployed callable/scheduled function list includes the new endpoints.
- Live account flows still need a user-created test account: grade change, opt-in restoration, tutor assignment, each lesson mode/quota limit, cancellation refund, and renewal rollover.
