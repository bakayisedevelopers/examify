# Grade Changes, Lesson Entitlements, and Subscription Pricing Plan

## Status and scope

- Subscription pricing and the one-subject minimum/default are implemented in this change, as approved for the development reset.
- Grade-change subject cancellation, optional history restoration, tutor assignment restrictions, lesson-mode restrictions, and lesson quotas remain planned work. They have not been implemented in this change.
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

## Existing implementation findings

- `changeStudentGrade` currently cancels active subject episodes but immediately creates fresh active episodes for all the same subject names at the new grade. It does not ask the student to choose subjects or restore history.
- `updateStudentSubjects` already has a three-month, same-grade restoration path. Its `copyTopicHistory` helper copies topics and understanding-score records only, but restoration currently happens automatically when a matching subject is re-added. The planned change must make that restoration explicit opt-in.
- `assignStudentToTutor` currently validates the admin, tutor, and active subject episode, but does not validate the student's current paid plan.
- `savePlannedLessonSession` currently creates planned lesson rows from the frontend. It does not check plan, mode, renewal-window, or remaining lesson quotas. The group roster update path also needs the same authorization checks.
- Both frontend and Functions currently maintain subscription pricing calculations. The active paid subject minimum is 2, with Circle at R249 for 2 included subjects plus R50 per extra subject, and Personalized at R1699 for 2 included subjects plus R600 per extra subject.
- Paystack verification and exercise-access checks recompute expected amounts using the Functions pricing calculator. The development data reset is important because old payment records have amounts and subject counts from the old pricing rules.

## Implementation plan

### Phase 1: Pricing engine and validation

This phase is approved for implementation now.

1. Update the frontend and Functions plan definitions with the confirmed prices and allowances in the table above.
2. Change the paid subject minimum and default from 2 to 1, preserving the 20-subject maximum. Update signup query defaults, billing-page fallbacks, the subject-count control, frontend effective-subscription validation, and Functions quote validation so all entry points agree.
3. Keep the frontend quote and Functions quote equivalent. Functions remain authoritative for Paystack initialization, payment amount verification, renewal charges, subject-capacity validation, and paid exercise access.
4. Update the plan selector copy and quote output so it displays the new subject rates and the Circle/Personalized lesson allowances per subscription window. Add separate group and one-on-one allowance values to the quote instead of presenting Personalized as only one-on-one.
5. Keep the existing annual discount. Do not migrate or delete existing data. Because payment verification recomputes the quote from the current pricing rules, old test subscriptions and payment records must be cleared before testing the new prices; the developer will perform that reset separately.

### Phase 2: Grade change and explicit history restoration

1. Change the grade-transition operation to cancel each active subject episode, end its active tutor/staff membership, and update the student's grade without automatically creating replacement episodes.
2. Cancel future planned lessons associated with the old active episodes as part of the transition. Leave completed lesson, exercise, topic, score, report, and submission data in the cancelled episode for audit/history.
3. Provide an authenticated server-side way to list eligible cancelled episodes for the destination grade. Eligibility is based on matching destination grade and `cancelledAt` within the last three calendar months.
4. Show the eligible subjects as unselected choices and state the student's current plan subject capacity. The student explicitly selects which eligible histories to restore. Enforce the selection limit on both client and server.
5. For an opted-in subject, create a new active episode and copy only its `topics` documents and nested `understandingScores`. Preserve provenance to the old episode. Do not copy tutors/staff, lessons, exercises, reports, or other history.
6. For a subject added without opting into an eligible history, create a fresh episode. Keep the old cancelled episode intact.
7. Update `DATABASE_RESTRUCTURE_PLAN.md` so it no longer says grade changes always start with zero topics and no carry-over.

### Phase 3: Tutor assignment and lesson scheduling entitlements

1. Add a shared server-side entitlement check that reads the student's effective subscription, including the active renewal window and any valid payment/grace status. Store an explicit `entitlementWindowStartAt` at successful activation and advance it on successful renewals; pair it with `renewalDate` to form the quota window.
2. In `assignStudentToTutor`, reject new assignments when the student's effective plan is Free or the paid plan is not active for the requested subject. Keep the existing admin and approved-tutor checks.
3. Keep useful immediate UI feedback in the tutor/admin pages, but treat the server check as authoritative.
4. Enforce lesson access for every student in a session:
   - Free: reject group and one-on-one scheduling.
   - Circle: allow group only.
   - Personalized: allow group or one-on-one.
5. Enforce the lesson date inside the effective plan's `[activation time, renewal date)` window. If a downgrade is pending, use the current plan through its renewal date; do not use the pending plan early.
6. Count the student's non-cancelled lesson rows under that subject episode, split by `sessionMode`. Planned, completed, and missed rows consume quota; cancelled rows do not. Each participant's own group lesson row consumes one group allowance for that student.
7. Move only the security-sensitive planned-session creation and roster/quota mutations behind trusted Functions. Keep lesson completion, tutor score entry, and score review in the frontend where existing Firestore permissions safely allow them.
8. Add or tighten Firestore rules so clients cannot bypass plan or quota checks by writing lesson schedule rows directly.
9. At renewal, switch the effective plan and its lesson allowances only after the new payment/plan activation succeeds. A pending downgrade must not remove the benefits already paid through the current renewal date.

## Verification checklist for the remaining phases

- Grade change leaves no active old-grade subject episodes, creates no replacements automatically, and retains old episode records.
- History candidates are limited to the destination grade and the three-calendar-month cutoff; an unchecked candidate is never copied.
- Restoring copies topics and understanding scores only, without staff, lesson, exercise, report, or submission documents.
- The subject limit is enforced for restored and fresh subjects, including a one-subject subscription.
- Free assignment and scheduling are rejected server-side. Circle rejects one-on-one; Personalized accepts both modes.
- Quotas are calculated from activation through renewal, count planned/completed/missed, exclude cancelled, and are applied independently per student and subject.
- A pending downgrade preserves the current plan's scheduling rights until renewal; no lesson may be scheduled beyond the current renewal date under the current plan.
- Frontend, Functions, Paystack initialization/verification, renewal charging, and access validation produce identical prices for 1, 2, and additional subjects on monthly and annual billing.
- Build, frontend lint, Functions lint, and quote-parity checks pass for Phase 1. Phase 1 can be deployed for the clean development reset; deploy only the Functions affected by each later phase when that phase is complete.
