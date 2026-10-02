# Database Restructure Plan

## Purpose

This document proposes a student-centered Firestore layout where each subject enrollment episode owns the subject-specific data for that period. It is a review plan only. No application code, Firestore data, or deployment configuration has been changed as part of writing it.

The implementation should be approved and delivered phase by phase. The data model and paths are to be finalized before implementation begins.

## Design Goals

- A student's active subject episode is the authoritative context for access, grade, topics, lessons, exercises, submissions, marking, and generation state.
- Adding or re-adding a subject creates a new episode document. Removing a subject cancels its current episode; historical episodes are retained.
- Subject-specific collections are nested under the subject episode, rather than being scattered across top-level collections.
- Subscription state, payment records, and payment authorizations are user-owned subcollections under the student profile.
- Shared question papers, paper analyses, topic resolver mappings, and global settings remain shared collections.
- Firestore writes that affect counts, access, payment state, or lesson/topic consistency are performed by trusted Functions/callables.
- Existing student/tutor data is not migrated if the planned data reset is completed. Question-paper data and analysis must remain untouched.

## Proposed Firestore Layout

```text
users/{uid}
  // Authentication-linked profile and role data only:
  // role, displayName, email, avatar, grade, parentId, WhatsApp number,
  // tutor qualifications/approved subjects, preferences, and agreements.

  subjects/{subjectInstanceId}
    // One document per enrollment period, not one permanent document per subject.
    // studentId, subjectKey, subjectName, grade, curriculum
    // status: active | cancelled
    // startedAt, cancelledAt, previousSubjectInstanceId
    // completedTopicCount, dailyExerciseTarget
    // primaryTutorId, staffByUid, activeStaffIds, historicalStaffIds,
    // staffMemberships, initialReport, studentName, createdAt, updatedAt
    topics/{canonicalTopicKey}
      // Episode-specific topic progress, tutorReport text, and score summary.
      understandingScores/{scoreId}
        // sourceType: markingReview | Lesson | Exercise; score and source refs.
    lessons/{lessonId}
      // Scheduled, completed, or missed lesson for this student and episode.
    exercises/{exerciseId}
      // Generated exercise and marking state, scoped to this episode.
      submissions/{submissionId}
        // Student work image paths, upload timestamps, and submission status.
      peerReviews/{reviewId}
        // Completed peer review of this exercise/submission.
      peerMarkingAssignments/{assignmentId}
        // Assignment belongs to this exercise; stores reviewer and source refs.
    generationRuns/{dateKey}
      // Idempotency, target count, status, and generation audit for a day.

  subscriptions/current
    // Current plan, status, subject capacity, renewal/cancellation state,
    // latest payment reference, pending plan changes, and grace period.
    history/{eventId}
      // Append-only plan/lifecycle snapshots or events.
  subscriptionAuthorizations/current
    // Reusable Paystack authorization; server-only access.
  subscriptionAuthorizations/history/{authorizationId}
    // Optional audit of authorization replacement/revocation; never card details.
  payments/{paystackReference}
    // Per-student payment attempt/receipt with payerId, amount, currency,
    // status, plan quote, Paystack reference, and timestamps.
  guideQuizResults/{resultId}
  notifications/{notificationId}
  notificationTokens/{tokenId}
  notificationLogs/{logId}

questionPapers/{paperId}
  analysisRuns/{runId}
    batches/{batchId}
topicResolverMappings/{mappingId}
settings/{settingId}
```

The `users/{uid}` profile stays the shared identity record for students, tutors, teachers, parents, and admins. The active subject episode is the authority for the student's current subject state. Profile fields such as `subjects`, `assignedTutorIds`, or `subscriptionStatus` may be retained temporarily as display/cache fields during implementation, but must not remain competing authorities after cutover.

There are no `access` or `accessHistory` subcollections. Current access and the subject-specific staff membership record live on the subject episode document itself: `primaryTutorId`, `staffByUid`, `activeStaffIds`, `historicalStaffIds`, and `staffMemberships`. `staffMemberships` can retain grant/end timestamps and role changes as embedded entries. `activeStaffIds` is the query/security summary for active episodes; `historicalStaffIds` supports history queries after cancellation. On cancellation the episode becomes read-only, and its staff IDs remain available to see that archived subject history. The primary tutor remains distinct from shared co-owner/marker/viewer roles.

Access is intentionally episode-wide: an authorized member can access the documents belonging to that subject episode, subject to their role's write permissions. Removing a member from an active episode removes their current access; membership history can remain embedded for audit. This avoids separate assignment/access collections, but does not provide per-document visibility boundaries within an episode. Embedded membership history should remain small and structured because it shares the subject document's size and write limits.

Topics use canonical IDs from the grade-and-subject topic catalog. A topic copied during a same-grade re-add is written under the new episode's `topics` subcollection, with `restoredFromSubjectInstanceId`, source topic ID, and restoration timestamp. Old lesson records remain in the old episode; copying progress must not fabricate new lesson events.

For a grade change, create a new episode with zero topics and no topic restoration. Staff transfer should be an explicit operation that writes new embedded `staffMemberships` entries; it must not silently carry old shared roles into a new grade episode.

## Data Placement Decisions

| Existing data or behavior | Proposed location | Notes |
| --- | --- | --- |
| User identity and role | `users/{uid}` | Keep this as the one profile root for every role. |
| Current and historical student subjects | `users/{studentId}/subjects/{subjectInstanceId}` | New document per add/re-add; cancellation retains the document. |
| Primary tutor/shared staff access | Fields on subject episode (`primaryTutorId`, `staffByUid`, staff ID summaries, embedded `staffMemberships`) | No access/access-history subcollections and no separate assignment collections. |
| Covered lessons/topics | Subject `lessons` and `topics` subcollections | Replaces top-level `coveredTopics`; lesson records link to canonical topic IDs. Topic reports and understanding scores live with each topic. |
| Generated exercises and generation status | Subject `exercises` and `generationRuns` subcollections | Replaces top-level `dailyExerciseAssignments` and `exerciseGenerationStatus`. |
| Student work submissions | Under the relevant subject exercise | Includes unmarked work and any tutor/peer-marked image paths and review state. |
| Peer-marking assignments | Under the target exercise's `peerMarkingAssignments` | The assignment belongs to the exercise being marked; store reviewer ID and reviewer subject instance ID. |
| Peer reviews | Under the target exercise's `peerReviews` | Keep the completed review with the work it evaluates, including reviewer ID and review timestamps. |
| Tutor reports | `initialReport` field on the subject; `tutorReport` text field on each topic | No tutor-report collection. Event-specific notes can also remain on their lesson/score source records. |
| Topic understanding scores | `topics/{topicKey}/understandingScores/{scoreId}` | Append one score event with source type `markingReview`, `Lesson`, or `Exercise` and a reference to its source record. |
| Subscription state | `users/{studentId}/subscriptions/current` | Student-specific; parent payer is recorded separately as `payerId`. |
| Subscription payment authorizations | `users/{studentId}/subscriptionAuthorizations/...` | Sensitive authorization data is callable/server-only. |
| Payments | `users/{studentId}/payments/{reference}` | Payment remains attached to the student even when a parent pays. |
| Tutor-owned mark documents | `users/{tutorId}/tutorMarksDocuments/{documentId}` | Tutor-owned, not student-subject data. |
| Guide quiz results | `users/{uid}/guideQuizResults/{resultId}` | Admin reporting can use a collection-group query. |
| Notifications and device tokens | User subcollections | Notifications are already user-nested in the notification Function; logs should follow the recipient. |
| Question papers and analysis | `questionPapers/{paperId}/...` | Global/shared; preserve during student/tutor data cleanup. |
| Topic resolver mappings and app settings | Existing global collections | Admin/global data, not student-owned. |

Group lessons have one per-student lesson record under each participant's subject episode. Each record shares a `groupSessionId`. If shared scheduling metadata needs one canonical copy, it can live under the creating tutor's user document, with participant lesson records referencing it; it must not replace per-student attendance, report, or score records.

Each topic document stores its current `tutorReport` text directly and has an `understandingScores` subcollection. A completed lesson writes a `Lesson` score for each scored topic; tutor exercise review writes an `Exercise` score; tutor review of a student's peer-marking work writes a `markingReview` score to the marker's own subject/topic. Each score stores the numeric value, `createdAt`, author/reviewer IDs, and source lesson/exercise/peer-marking assignment references. Topic-level averages/counts are derived summaries updated with the score write. The subject episode stores one `initialReport` field, which is carried along with topic data when topic restoration is allowed.

When eligible topics are restored into a same-grade re-added subject, copy all topic fields (including `tutorReport` and score summaries) and all `understandingScores` entries, preserving source subject/topic/score IDs and source dates. Do not copy old lesson or exercise documents into the new episode; retain references to them for provenance. The subject `initialReport` is copied under the same restoration rule. A grade change or re-add outside the three-calendar-month window starts without copied topics, topic scores, or initial report.

Uploaded files remain in Firebase Storage, but their paths should include the subject episode, for example:

```text
users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}/submissions/{fileId}
users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}/peer-reviews/{fileId}
users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}/tutor-marking/{fileId}
users/{tutorId}/tutorMarksDocuments/{fileId}
questionPapers/{paperId}/...
```

Firestore parent reads do not automatically load the parent document's subcollections. Screens must explicitly query only the child collections they need. Tutor lists should use a collection-group query over active `subjects`, filtered by `activeStaffIds`; history lists use `historicalStaffIds`. Keep student display/grade summary fields on the subject document to avoid one profile read per row. Required collection-group and compound indexes must be added to `firestore.indexes.json`.

## Repository Change Map

### Firebase client services

- `src/firebase/schema.js`: define canonical path/collection names for user subcollections and subject episode subcollections; remove obsolete top-level collection constants only after all consumers are migrated.
- `src/services/firestoreService.js`: largest client persistence/read migration. Update subscription/access state, subject add/remove, assigned-student queries, topic report/score writes, lesson CRUD, completed-topic reads, tutor history, exercise reads/writes/generation, submissions, peer marking, guide quiz results, and tutor billing/mark-document queries. Current major entry points include `getStudentSubscriptionState`, `getStudentAccessState`, `saveTutorReport` (replace with topic/initial-report updates), `saveCompletedLesson`, `savePlannedLessonSession`, `completeLessonSession`, `getCompletedLessons`, peer-marking helpers, exercise generation helpers, assignment/access helpers, and tutor history helpers.
- `src/services/storageService.js`: move submission, peer-review, tutor-marking, and tutor-document upload/delete paths. Preserve cleanup of all related files when an exercise is deleted; include `subjectInstanceId` in upload arguments and authorization checks.
- `src/services/authService.js`: keep profile creation at `users/{uid}`; update account deletion to use a trusted recursive cleanup path for nested user data rather than deleting only the profile document.
- `src/services/notificationService.js`: update token paths only if the current notification-token layout changes; it is already nested under the user.
- `src/components/dashboard/ExerciseCard.jsx`: remove its direct top-level `dailyExerciseAssignments` Firestore access and route through the migrated service.

### Cloud Functions

- `functions/src/assignmentHistory.js`: replace old top-level assignment/access collections with membership fields on subject episode documents. Implement add/cancel/re-add lifecycle, embedded membership updates, subject capacity validation, and grade-change behavior; do not create access subcollections.
- `functions/src/exerciseAccess.js`: authorize generation against the active subject episode and its embedded staff membership fields, plus the student's nested paid-subscription/payment records.
- `functions/src/peerMarking.js`: move submission-triggered assignment logic to nested exercise/submission paths and store each peer-marking assignment under the target exercise; select eligible target work by subject, grade, canonical covered topics, and the existing repeat-marking rules.
- `functions/src/paystack.js`: move subscription, authorization, and payment reads/writes to student user subcollections. Keep parent payer authorization checks. Resolve webhook/verification events by student metadata or a collection-group payment-reference lookup.
- `functions/src/subscriptionRenewals.js`: query nested current subscriptions with a collection-group query; update nested authorization/payment records and nested subscription state.
- `functions/src/notifications.js`: update event paths for exercise submissions, peer-marking, payments, tutor access, reports, and completed lessons. Existing root collection triggers will not fire for the new nested paths.
- `functions/src/index.js`: keep exported callable/trigger names stable where possible while replacing implementations and trigger document patterns.

### Rules, indexes, pages, and operational files

- `firestore.rules`: replace the broad top-level catch-all behavior with explicit rules for profiles, subject episodes, their subcollections, billing, and global collections. Authorize subject data through the subject's membership fields and episode status; enforce viewer/marker/co-owner write limits. Exclude users' nested data from any permissive catch-all; overlapping permissive matches would otherwise defeat narrower rules. Sensitive authorizations and all billing writes stay server-only.
- `storage.rules`: authorize new subject-episode paths using the owning student and current tutor/staff access; keep question-paper upload permissions separate.
- `firestore.indexes.json`: add collection-group indexes for active subject staff lists, lessons, exercises, submissions, peer assignments/reviews, guide results, and due subscriptions. Remove old indexes only after their queries are gone.
- Student screens: `StudentDashboardPage`, `StudentExercisesPage`, `StudentExerciseDetailsPage`, `StudentLessonsPage`, `StudentPeerReviewsPage`, `StudentBillingPage`, and student profile pages should resolve data from the active subject episode and nested billing paths.
- Tutor/teacher screens: `TutorDashboardPage`, `TutorStudentsPage`, `TutorStudentDetailsPage`, `TutorLessonsPage`, `TutorLessonDetailsPage`, `TutorExercisesPage`, `TutorExerciseDetailsPage`, and `TutorReportsPage` should query active subject episodes by `activeStaffIds` and cancelled history by `historicalStaffIds`; reports display the subject/topic report fields.
- Billing and account screens: `ProfileSubjectsPage`, `ProfileBillingPage`, `SubscriptionLifecyclePanel`, `ParentDashboardPage`, `AdminPaymentsPage`, `AdminDashboardPage`, and `AdminUsersPage` need updated paths and access behavior.
- `README.md` and `docs/architecture.md`: update collection maps and architecture notes after the implemented model is verified.

## Implementation Phases

### Phase 1: Paths And Persistence Writes

Scope: establish the new path and document-write layer without changing existing workflow decisions. This phase changes where payloads are persisted, not when a lesson is considered complete, how topic eligibility is decided, who may access a student, or how many exercises are generated.

- Add centralized path helpers and subject/billing path constants.
- Add document builders and Firebase service write adapters for subject episodes, embedded staff membership fields, lessons, topic report/score records, exercises, submissions, peer-marking records under exercises, and user-scoped billing documents. Preserve existing payload meaning and expose `subjectInstanceId` where a caller will need it later.
- Prepare the subject create/cancel persistence contract, but leave the add/cancel/re-add rules and authorization decisions for Phase 3.
- Change Storage upload and deletion paths to include the subject episode ID.
- Ensure records include stable ownership fields: `studentId`, `subjectInstanceId`, `subjectKey`, `grade`, canonical topic IDs, and relevant tutor/reviewer IDs.
- Make low-level write operations idempotent where retries are possible. Keep sensitive payment/access writes in Functions; do not loosen client access to make the new paths writable.
- Build emulator tests for path correctness, document fields, image references, and parent-payer/payment association.

Completion gate: new writes land only at the agreed paths, but no production cutover occurs while the app still reads only old paths. Use the Emulator Suite or a dedicated test project until read paths are ready; do not publish a writer-only release that makes new records invisible to existing screens.

### Phase 2: Read Services And Screens

Scope: move reads and subscriptions to the new hierarchy without changing topic-selection or generation rules.

- Update student subject lists, tutor active-student lists, subject detail/history views, lessons, topic reports/scores, exercises, submissions, peer-marking assignments/reviews, and billing reads.
- Load child collections on demand; do not read every lesson, exercise, and submission when rendering a subject list.
- Use collection-group queries for tutor/student lists, admin payment summaries, guide-result reports, and other cross-user views.
- Update parent flows to read a linked student's nested subscription and active subject episodes while preserving parent authorization.
- Add required indexes and pagination/limits to history-heavy views.
- Remove direct Firestore collection access from UI components and route all operations through services.

Completion gate: all role views can read current and historical records from the new model in the emulator, with no dependency on old assignment or lesson collections.

### Phase 3: Subject Lifecycle, Access, Rules, And Subscription Capacity

Scope: make the new subject episode authoritative for current access and subject enrollment.

- Implement server-side add, cancel, re-add, and grade-change operations. Enforce one active episode per student/subject and paid subject capacity.
- Restore topics only for a same-grade re-add within three calendar months; start grade changes with no inherited topics.
- Store primary tutor and co-owner/marker/viewer memberships on the subject document. Maintain active and historical staff ID summaries plus embedded membership entries with grant/end metadata; do not create access/access-history collections.
- Update every authorization helper and rule to check the episode status and embedded staff membership fields; preserve marker/viewer/co-owner restrictions.
- Cancelled subject episodes retain their staff IDs and historical data for history access. Define that membership grants access to the whole episode; do not claim per-document date isolation for a staff member within one episode.
- Update Firestore rules, including the generic catch-all, so nested user data does not accidentally remain broadly readable/writable.

Completion gate: students can only use active subject episodes for current work; current staff membership grants access to active episodes; recorded historical staff can read cancelled episodes as history, which is read-only except for authorized administration.

### Phase 4: Lessons, Topics, Submissions, Peer Marking, And Exercise Generation

Scope: move domain logic to active subject episodes after persistence and read paths are stable.

- Save per-student scheduled/completed/missed lesson records in the subject's `lessons` subcollection. For group sessions, preserve one attendance/report/score record per student and a shared `groupSessionId`.
- On attended lesson completion, update topic records transactionally and count each canonical topic at most once per episode. Append a `Lesson` understanding score under each scored topic. Missed lessons do not update topic history.
- Store the subject's initial report as a subject field and the tutor's topic report as a text field on the topic document. Append score events under `topics/{topicKey}/understandingScores` with `sourceType` exactly `markingReview`, `Lesson`, or `Exercise` and a reference to the source record.
- When a tutor reviews peer-marking work, write a `markingReview` score to the reviewer's own subject/topic. Exercise marking writes an `Exercise` score to the student's subject/topic. Keep score event history append-only and update topic score summaries consistently.
- Store peer-marking assignment documents under the target `exercises/{exerciseId}/peerMarkingAssignments` path, with reviewer subject and student references.
- Make active subject topic documents the input to generation. Use the approved topic-count-to-daily-target rule, enforce no more than five exercises/day, and record an idempotent `generationRuns/{dateKey}` document.
- Preserve tutor manual regeneration and initial-generation trigger behavior while changing their source of truth to the active episode.
- Move image submissions and tutor/peer markings under the right exercise; move peer assignment triggers to nested paths and retain grade/subject/topic eligibility and repeat-marking protections.
- Update exercise deletion and replacement to remove or retain all nested submissions, reviews, and Storage files according to the existing business rules.

Completion gate: emulator tests prove repeated topics do not inflate the distinct-topic count, new topics do, missed attendees add none, generation respects the cap, and no exercise or peer assignment crosses a subject/grade boundary.

### Phase 5: Billing Automation, Triggers, Cutover, And Retirement

Scope: finish server integrations, deploy a consistent release, and retire old paths.

- Update Paystack initialization, verification, plan changes, cancellation, stored-authorization charging, payment verification, and renewal retries to use student-owned subcollections.
- Update scheduled renewal queries to collection-group subscription records and ensure webhook/payment notifications resolve the student and payer correctly.
- Update Functions event triggers and notification recipient lookup for every nested document path.
- Run rules tests, callable authorization tests, billing lifecycle tests, and end-to-end student/tutor/teacher/parent/admin workflows in a Firebase test project.
- Export Firestore before cleanup. Preserve `questionPapers` and their analysis runs/batches, `topicResolverMappings`, and `settings`; verify Firebase Auth accounts are handled intentionally because deleting Firestore profiles does not delete Auth accounts.
- Deploy indexes and rules, then Functions and Hosting as one coordinated cutover. Confirm renewal scheduling, Paystack callbacks, Storage access, and triggers against the deployed paths.
- After production verification, remove obsolete top-level collections/constants/indexes and update `README.md` and `docs/architecture.md`.

Completion gate: production reads and writes use only the approved nested model, payment and lesson triggers fire successfully, and the preserved global paper data is verified intact.

## Legacy Paths To Retire After Cutover

- Assignment/access: `tutorStudentAssignments`, `tutorStudentAssignmentPeriods`, `staffStudentAccess`, `staffStudentAccessPeriods`; current membership and bounded membership history move onto each subject episode document.
- Learning/exercises: `coveredTopics`, `dailyExerciseAssignments`, `exerciseGenerationStatus`, and any unused top-level `lessons` or `exercises` collections after a reference audit.
- Marking: top-level `submissions`, `peerReviews`, and `peerMarkingAssignments`; submissions/reviews move under exercises, and peer-marking assignments move under the target exercise.
- Reports and billing: top-level `tutorReports`, `subscriptions`, `subscriptionAuthorizations`, and `payments`; reports move to topic/subject fields and scores to topic subcollections, billing to user subcollections.
- User-owned extras: top-level `guideQuizResults`, `notificationLogs`, and `tutorMarksDocuments` after their nested replacements are verified.
- Legacy `students`, `tutors`, `studentProfiles`, and `studentPerformance` collections only if a full-repository reference audit confirms they are unused or safely replaced.

Do not delete cancelled subject episodes as part of normal subject removal. Firestore does not automatically delete subcollections when a parent document is deleted; account erasure needs an explicit recursive cleanup process.

## Verification Checklist

- A student can add, cancel, and re-add a subject without reusing or overwriting the prior episode.
- Same-grade topic restoration works only inside the approved three-month window; a grade change starts with zero topics.
- Subject limits are checked against the nested active-subject records and the current paid subscription.
- Primary tutor, co-owner, marker, viewer, parent, student, and admin permissions match existing role behavior.
- Active tutor lists use active subject membership; cancelled subject history remains available to its recorded staff IDs with the intended read-only behavior.
- Group lesson roster changes and attendance remain correct per student; only attendees' topics advance.
- Lesson, exercise, and marking-review scores are stored under the correct student's subject/topic with the correct source type and source reference.
- Topic carry-forward copies topic report text, all topic fields, understanding-score records, score summaries, and the subject initial report only when the restoration rule permits it.
- Submission images, tutor markings, peer markings, and deletion cleanup preserve correct subject/exercise references.
- Generation is idempotent, uses only the active episode's topics, and respects the approved daily target and cap.
- Paystack payer/student separation, payment verification, authorizations, renewals, cancellations, upgrades, and downgrades still work.
- Collection-group indexes, Firestore rules, Storage rules, notification triggers, and admin reporting work for nested paths.
- Preserved question papers and analysis are unchanged after the planned user-data cleanup.
