# Database Restructure Plan

## Purpose

This document outlines the student-centered Firestore layout where each subject enrollment episode owns all subject-specific learning and assessment data. It is the approved architectural plan for restructuring the Examifying database. The application now uses this model as its authoritative database architecture. Legacy top-level learning, assignment, peer-marking, and billing collections have been removed from application code.

---

## Core Domain Rules & Design Principles

1. **Maths Only & Single Primary Tutor:** Each student has one primary Maths tutor per subject episode (`primaryTutorId`), managed under the subject episode.
2. **Students Pay / Parents Pay for Students:** Subscription state, payment authorizations, and transaction records are student-scoped under `users/{studentId}` (with `payerId` for parent payers).
3. **Tutors Manage Students:** Tutors track attendance, complete lessons, grade exercise submissions, and review peer-marking work.
4. **Authoritative Subject Episode:** A student's active subject episode (`users/{studentId}/subjects/{subjectInstanceId}`) is the single authority for current grade, curriculum, assigned staff, completed topics, lessons, exercises, submissions, and generation runs.
5. **Topics as Unique Topic Documents (No Duplicates):** Within a subject episode, each canonical topic has exactly **one** document under `topics/{canonicalTopicKey}`. Multiple lessons may cover or repeat the same topic over time, but the topic document itself is never duplicated.
6. **Understanding Scores Scoped to Topics:** Scores belong to topics, not lessons. Each topic document maintains an `understandingScores` subcollection recording score events from three distinct sources:
   - `Lesson`: logged when a lesson covering that topic is completed.
   - `Exercise`: logged when a tutor marks a student's exercise submission.
   - `markingReview`: logged when a tutor evaluates the student's peer-marking work on another student's submission.
7. **Exercises Depend on Completed Topics (Max 5 Daily Exercises):** Daily exercise count scales with the student's completed topic count:
   - 1 topic completed → 1 exercise/day
   - 2 topics completed → 2 exercises/day
   - Up to a hard maximum of **5 exercises/day**.
   - If more than 5 topics have been completed, AI generation selects and balances topics according to curriculum weights, keeping the daily cap at 5.
8. **Students Only Do Today's Exercise & Missed Exercises Locked:** Historical unsubmitted exercises lock; future exercises unlock on their assignment date.
9. **Handwritten Answers Uploaded as Images:** Answer submissions, peer-marked annotations, and tutor-marked work are stored in Firebase Storage and referenced under the exercise.
10. **Re-addition & Topic Restoration (3-Month Window):**
    - Cancelling a subject sets `status: 'cancelled'` and records `cancelledAt`. The episode remains archived in history.
    - If re-added within **3 calendar months** for the **same grade**, learning history (topics, understanding scores, and topic reports) is restored into the new episode.
    - **Tutors and staff roles are NOT carried over on re-add:** Staff access is kept unassigned on re-add so that tutor assignments and roles can be configured fresh.
    - **Grade changes** always start completely fresh with zero topics and no topic carry-over.

---

## Proposed Firestore Layout

```text
users/{uid}
  // User profile and role identity (student, tutor, teacher, parent, admin)
  // role, displayName, email, avatar, grade, parentId, WhatsApp number,
  // tutor qualifications/approved subjects, preferences, agreements.

  subjects/{subjectInstanceId}
    // One document per enrollment episode (active or cancelled)
    // studentId, subjectKey, subjectName, grade, curriculum
    // status: 'active' | 'cancelled'
    // startedAt, cancelledAt, previousSubjectInstanceId
    // completedTopicCount, dailyExerciseTarget (1 to 5)
    // primaryTutorId, staffByUid, activeStaffIds, historicalStaffIds,
    // staffMemberships (embedded audit: uid, role, grantedAt, endedAt),
    // studentName, createdAt, updatedAt

    topics/{canonicalTopicKey}
      // UNIQUE per canonical topic in this episode (NO DUPLICATES)
      // canonicalTopicKey, topicName, firstCompletedAt, lastCoveredAt
      // understandingLevel (derived overall average: 0-10)
      // scoreCount, latestScore, tutorReport (current topic note)
      understandingScores/{scoreId}
        // Immutable score log
        // sourceType: 'Lesson' | 'Exercise' | 'markingReview'
        // score: number (0-10)
        // sourceId: lessonId | exerciseId | peerAssignmentId
        // tutorId: uid of tutor who graded or reviewed
        // createdAt: timestamp

    lessons/{lessonId}
      // Lesson session event (scheduled, completed, or missed)
      // lessonDate, lessonType ('online' | 'inPerson'), status ('planned' | 'completed' | 'missed')
      // topics: string[] (topics covered in this session)
      // tutorId, groupSessionId (shared if group session), studentAttendanceStatus
      // whatsappLessonLink, locationDetails, completedAt

    exercises/{exerciseId}
      // Generated exercise document for a specific assignment date
      // assignmentDate, subject, grade, title, topic, topics
      // questionReferences, questionLinks, paperIds, status, generationBatchId
      submissions/{submissionId}
        // Student submission
        // submittedImages: [{ url, fileName, pageNumber }]
        // submittedAt, submissionStatus ('submitted' | 'graded')
      peerReviews/{reviewId}
        // Completed peer review written for this exercise
        // reviewerId, reviewerSubjectInstanceId
        // reviewImages: [{ url, fileName, pageNumber }]
        // reviewedAt, status
      peerMarkingAssignments/{assignmentId}
        // Assignment delegating this exercise to a peer reviewer
        // reviewerId, reviewerSubjectInstanceId, reviewerExerciseId
        // status ('assigned' | 'completed')
        // reviewImageUrl, reviewImages, completedAt

    generationRuns/{dateKey}
      // Daily generation audit and idempotency record
      // dateKey (YYYY-MM-DD), targetCount (1 to 5), status, generatedAt

  subscriptions/current
    // Current active subscription document
    // planId ('free' | 'circle' | 'orbit'), status ('active' | 'past_due' | 'cancelled')
    // subjectCount, billingPeriod ('monthly' | 'annual')
    // renewalDate, graceEndsAt, latestReference, autoRenew, cancelAtPeriodEnd
    history/{eventId}
      // Append-only audit of plan changes and lifecycle transitions

  subscriptionAuthorizations/current
    // Paystack reusable authorization (server-only access, no client read/write)
    // authorizationCode, email, cardType, last4, expMonth, expYear
    history/{authorizationId}

  payments/{paystackReference}
    // Payment record for this student
    // payerId (parent or self), amount, currency ('ZAR'), status, planId, reference, paidAt

  guideQuizResults/{resultId}
  notifications/{notificationId}
  notificationTokens/{tokenId}
  notificationLogs/{logId}

users/{tutorId}
  tutorMarksDocuments/{documentId}
    // Tutor-owned documents, mark records, and uploads

// Global Collections (Preserved Intact)
questionPapers/{paperId}
  analysisRuns/{runId}
    batches/{batchId}
topicResolverMappings/{mappingId}
settings/{settingId}
```

---

## Detailed Topic & Understanding Score Architecture

### 1. Topics Are Unique Within an Episode
- Each topic covered by the student exists as **one and only one document** under `users/{studentId}/subjects/{subjectInstanceId}/topics/{canonicalTopicKey}`.
- When a tutor marks a lesson as completed, the system checks whether the topic document exists:
  - If it does **not** exist: creates the topic document (`firstCompletedAt: now`, `lastCoveredAt: now`).
  - If it **already exists**: updates `lastCoveredAt: now` and updates summary rollups. It **never** creates a duplicate topic document.
- The total document count of the `topics` subcollection is the student’s true `completedTopicCount`.

### 2. Understanding Scores Belong to Topics
Understanding scores are kept in the subcollection `topics/{canonicalTopicKey}/understandingScores/{scoreId}`. Every score record tracks its origin:

| Source Type | Trigger | Linked Entity Reference |
| --- | --- | --- |
| `Lesson` | Tutor marks a lesson completed and logs an understanding rating | `lessonId` |
| `Exercise` | Tutor grades a student's handwritten exercise submission | `exerciseId` |
| `markingReview` | Tutor evaluates the quality of peer-marking done by this student for another peer | `peerAssignmentId` |

- **Parent Topic Rollup:** Each time a score document is added to `understandingScores`, the parent topic document updates its cached summary:
  - `understandingLevel`: weighted/arithmetic average of recent score entries (0–10 scale).
  - `scoreCount`: total scores logged for this topic.
  - `latestScore`: most recently logged score value.
  - `tutorReport`: current tutor feedback/note on this specific topic.

### 3. Topic Count Drives Daily Exercise Target (Up to 5)
- The number of unique topic documents determines the student's daily exercise target:
  - **1 topic completed:** 1 exercise per day.
  - **2 topics completed:** 2 exercises per day.
  - **3 topics completed:** 3 exercises per day.
  - **4 topics completed:** 4 exercises per day.
  - **5 or more topics completed:** capped at **5 exercises per day** (`MAX_DAILY_EXERCISES = 5`).
- When more than 5 topics are available, the generation engine balances revision and newly completed topics, distributing across the 5 exercises per day.

---

## Subject Lifecycle, Re-addition & Staff Access

### 1. Active vs Cancelled Episodes
- Adding a subject creates a new `subjects/{subjectInstanceId}` document with `status: 'active'`.
- Removing a subject sets `status: 'cancelled'`, records `cancelledAt: now`, and retains all nested lessons, topics, scores, and exercises for permanent historical audit.
- Cancelled episodes are excluded from active dashboard views and exercise generation.

### 2. Re-addition Within 3 Months (Same Grade)
- If a student re-adds a subject within **3 calendar months** of cancellation at the **same grade**:
  - The new active episode copies all `topics` documents and their nested `understandingScores` entries.
  - Provenance is recorded via `previousSubjectInstanceId` and `restoredAt`.
  - **Staff roles are intentionally reset:** `primaryTutorId` and staff memberships are **not carried over**. The student/parent/admin can assign a tutor fresh.
- If re-added **after 3 calendar months**:
  - Starts fresh with 0 topics. No topic history is copied.

### 3. Grade Changes
- When a student advances to the next grade or changes grade:
  - A brand-new subject episode is created with 0 topics and `grade: newGrade`.
  - Old grade topics are never copied into the new grade episode.
  - Previous grade episodes remain in history as archived read-only records.

---

## Peer-Marking Architecture & Security

1. **Target Exercise Ownership:**
   - The peer-marking assignment document lives directly under the exercise being evaluated:
     `users/{revieweeId}/subjects/{revieweeSubjectId}/exercises/{exerciseId}/peerMarkingAssignments/{assignmentId}`
   - The completed review document lives at:
     `users/{revieweeId}/subjects/{revieweeSubjectId}/exercises/{exerciseId}/peerReviews/{reviewId}`
2. **Reviewer Discovery via Collection-Group Query:**
   - The reviewer (Student B) retrieves their pending marking tasks via a Firestore Collection Group query:
     `collectionGroup(db, 'peerMarkingAssignments').where('reviewerId', '==', studentB.uid).where('status', '==', 'assigned')`
3. **Submission via Cloud Function Callable:**
   - To keep client Firestore security rules clean and prevent cross-student write access into another student's document tree, peer-review submission is executed via a trusted Cloud Function callable (`completePeerMarkingAssignment`).
   - The function verifies that `request.auth.uid === assignment.reviewerId`, writes the `peerReviews` record, updates `peerMarkingAssignments`, and updates the target exercise's status to `peerReviewed: 'Yes'`.
4. **Tutor Peer-Marking Review Logs Score to Reviewer:**
   - When a tutor reviews the accuracy of Student B's peer-marking work, the tutor assigns an understanding rating.
   - The Cloud Function writes an understanding score with `sourceType: 'markingReview'` under **Student B's** topic:
     `users/{studentB}/subjects/{reviewerSubjectId}/topics/{canonicalTopicKey}/understandingScores/{scoreId}`.
   - This rewards the reviewer's demonstrated mastery without fabricating artificial lesson records.

---

## Data Placement Decisions

| Existing / Legacy Location | Proposed Location | Notes |
| --- | --- | --- |
| User profile & roles | `users/{uid}` | Unchanged profile root for students, tutors, parents, admins. |
| Subject enrollment episodes | `users/{studentId}/subjects/{subjectInstanceId}` | Replaces flat subjects list with discrete enrollment episodes. |
| Primary tutor & staff access | Fields on subject episode (`primaryTutorId`, `staffByUid`, `activeStaffIds`) | Replaces `tutorStudentAssignments` and `staffStudentAccess`. |
| Covered lessons | `subjects/{instanceId}/lessons/{lessonId}` | Replaces `coveredTopics` collection. One record per session event. |
| Covered topics | `subjects/{instanceId}/topics/{canonicalTopicKey}` | One unique doc per canonical topic per episode. No duplicates. |
| Understanding scores | `topics/{topicKey}/understandingScores/{scoreId}` | Stores `Lesson`, `Exercise`, and `markingReview` scores. |
| Exercises & generation status | `subjects/{instanceId}/exercises/{exerciseId}` & `generationRuns/{dateKey}` | Replaces `dailyExerciseAssignments` and `exerciseGenerationStatus`. |
| Handwritten submissions | `exercises/{exerciseId}/submissions/{submissionId}` | Replaces top-level `submissions`. |
| Peer reviews & assignments | Under target `exercises/{exerciseId}/...` | Replaces top-level `peerReviews` and `peerMarkingAssignments`. |
| Subscriptions & authorizations | `users/{studentId}/subscriptions/current` & `subscriptionAuthorizations/...` | Replaces top-level billing collections. Authorizations server-only. |
| Payments | `users/{studentId}/payments/{reference}` | Scoped to student document with `payerId` linking. |
| Question papers & analyses | `questionPapers/{paperId}/...` | Shared/global; completely untouched. |
| Topic resolver & settings | `topicResolverMappings` & `settings` | Shared/global; completely untouched. |

---

## Repository Change Map

### 1. Client Services & Schemas (`src/`)
- `src/lib/constants.js`: Update `MAX_DAILY_EXERCISES = 5`.
- `src/services/exerciseGenerationPlan.js`: Update default generation cap and daily limit helpers to support up to 5 exercises.
- `src/firebase/schema.js`: Define nested subcollection paths (`subjects`, `topics`, `understandingScores`, `lessons`, `exercises`, `submissions`, `peerReviews`, `peerMarkingAssignments`, `generationRuns`, `subscriptions`, `payments`).
- `src/services/firestoreService.js`:
  - `saveCompletedLesson`: updates or creates unique `topics/{canonicalTopicKey}` and appends `Lesson` score to `understandingScores`.
  - `saveTutorMarkedExercise`: appends `Exercise` score to `topics/{canonicalTopicKey}/understandingScores`.
  - `saveTutorPeerMarkingReview`: appends `markingReview` score to reviewer's topic `understandingScores`.
  - `getTodayExercise`, `getExerciseHistory`, `getCurrentWeekExercises`: query under active subject episode.
  - `getPeerMarkingAssignmentsForStudent`: query collection group `peerMarkingAssignments`.
  - `getAssignedStudentsForTutor`: query collection group `subjects` with `activeStaffIds array-contains tutorId`.
- `src/services/storageService.js`: Update Storage paths to format:
  `users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}/{folder}/{fileId}`.
- `src/components/dashboard/ExerciseCard.jsx`: Route submission and review operations strictly through updated service functions.

### 2. Cloud Functions (`functions/src/`)
- `assignmentHistory.js`: Implement episode lifecycle (create active episode, cancel, same-grade 3-month topic restore without tutor carry-over, grade-change fresh start).
- `paystack.js`: Read/write nested subscription, authorization, and payment documents under `users/{studentId}`.
- `subscriptionRenewals.js`: Query `collectionGroup(db, 'subscriptions').where('status', '==', 'active')` for recurring renewal processing.
- `exerciseAccess.js`: Verify active subject episode status and nested subscription status before allowing generation.
- `peerMarking.js`: Callable `completePeerMarkingAssignment` for secure cross-user review submission.
- `notifications.js`: Update document trigger paths to listen to nested paths (e.g. `users/{studentId}/subjects/{subjectInstanceId}/exercises/{exerciseId}`).

---

## Implementation Verification

### Code audit (2026-10-02)

- Student subject selection, exercise generation checks, tutor dashboards, and admin assignment filters now read active subject episodes.
- Parent-to-student linking uses a trusted callable. Primary tutor/teacher assignment updates the active episode transactionally and prevents a second primary assignment.
- Student, parent, tutor, and teacher signup/login profile paths are aligned with the role rules. A login without its Firestore profile fails with a clear account-link error.
- Lesson, exercise-marking, and peer-marking scores are read from topic score events. New lesson writes do not store score rollups on lesson documents.
- Peer marking reads reviewer-scoped nested assignments and submits marked image pages through the callable.
- Firestore rules and indexes include the active episode, tutor-history, peer-marking, generation-run, subscription, and analysis access/query paths. Past-paper documents and question-paper analysis remain in their existing collections.
- The application no longer queries the replaced top-level learning, tutor-assignment, peer-marking, or billing collections.

### Local verification

- `npm run build` passes.
- `npm run lint` passes with six existing React hook/refresh warnings.
- `npm run functions:lint` passes.
- `node --test src/services/*.test.js src/utils/*.test.js functions/src/*.test.js` passes all five tests.

### Deployment state

Firestore rules, indexes, Cloud Functions, and Hosting were deployed to project `examifying` on 2026-10-02. Hosting is available at `https://examifying.web.app`. The CLI reported a Firestore rules warning on the first pass; the unsupported `hasNone` call was corrected to a negated `hasAny` check and the rules were redeployed with a clean compile. Live-account smoke tests for parent linking, primary tutor assignment, student subject enrollment, exercise submission, and tutor marking remain to be run.

### 3. Rules & Indexes
- `firestore.rules`:
  - Enforce access to `subjects/{subjectInstanceId}` based on `request.auth.uid in resource.data.activeStaffIds || request.auth.uid == studentId`.
  - Allow collection-group read on `peerMarkingAssignments` where `resource.data.reviewerId == request.auth.uid`.
  - Keep `subscriptionAuthorizations` and payment writes strictly server-only.
- `storage.rules`:
  - Protect exercise submission and review uploads based on owning student or assigned tutor credentials.
- `firestore.indexes.json`:
  - Collection group `subjects`: `activeStaffIds` (array-contains) + `status` (ascending).
  - Collection group `subjects`: `historicalStaffIds` (array-contains) + `status` (ascending).
  - Collection group `peerMarkingAssignments`: `reviewerId` (ascending) + `status` (ascending) + `assignmentDate` (descending).
  - Collection group `subscriptions`: `status` (ascending) + `renewalDate` (ascending).

---

## Phased Implementation Plan

### Phase 1: Constants, Paths, and Persistence Layer [COMPLETED]
- Update `MAX_DAILY_EXERCISES = 5` in `src/lib/constants.js`.
- Define path helpers and subcollection constants in `src/firebase/schema.js`.
- Implement write adapters in `src/services/firestoreService.js` for subject episodes, unique topics, understanding scores, lessons, exercises, and nested billing documents.
- Update Storage paths in `src/services/storageService.js`.

### Phase 2: Read Services, Collection Groups, and Screen Migration [COMPLETED]
- Update student dashboard, lessons, exercises, and billing views to read from the active episode and nested billing subcollections. (Done)
- Implement collection-group query for tutor student lists (`subjects` filtered by `activeStaffIds`). (Done)
- Implement collection-group query for student peer-review tasks (`peerMarkingAssignments` filtered by `reviewerId`). (Done)
- Deploy required composite indexes to `firestore.indexes.json`. (Done)

### Phase 3: Subject Lifecycle, Access Control, and Rules [COMPLETED]
- Implement server-side add, cancel, and re-add in `functions/src/assignmentHistory.js`: (Done)
  - Enforce single active episode per subject. (Done)
  - Implement same-grade 3-month topic restoration (copying topics and scores, resetting tutor/staff). (Done)
  - Implement grade-change clean slate (zero topics via `changeStudentGrade`). (Done)
  - Sync tutor assignments and staff access to active subject episode documents. (Done)
- Update `firestore.rules` and `storage.rules` with strict scoped access. (Done)

### Phase 4: Topics, Lessons, Scoring, Peer Marking & Generation [COMPLETED]
- Update lesson completion: creates/updates single unique topic doc and appends `Lesson` score.
- Update exercise marking: appends `Exercise` score.
- Update peer marking: submission callable and tutor review appending `markingReview` score.
- Update AI exercise generation:
  - Generate 1 to 5 exercises based on completed topic count.
  - Cap daily target at 5.
  - Record idempotent `generationRuns/{dateKey}`.

### Phase 5: Billing Automation, Cloud Function Triggers & Deployment [COMPLETED; LIVE SMOKE TESTS PENDING]
- Move Paystack transaction initiation, verification, and renewals to nested billing subcollections.
- Update Cloud Function Firestore event triggers in `notifications.js` to match nested document patterns.
- Deploy rules, indexes, Functions, and Hosting. (Done 2026-10-02)
- Verify global question-paper data remains untouched.

---

## Verification Checklist

- [x] Each topic has exactly one document in `subjects/{instanceId}/topics/{canonicalTopicKey}` regardless of how many lessons cover it.
- [x] Completing a lesson appends a `Lesson` score in `understandingScores`.
- [x] Marking an exercise appends an `Exercise` score in `understandingScores`.
- [x] Tutor reviewing peer-marking appends a `markingReview` score in the reviewer's topic `understandingScores`.
- [x] Daily exercise generation scales from 1 up to a maximum of 5 based on completed topic count.
- [x] Missed exercises remain locked; only today's exercise can be worked on.
- [x] Cancelling a subject marks the episode cancelled; re-adding within 3 months restores topic progress but resets tutors/staff roles.
- [x] Changing grades creates a clean subject episode with zero topics.
- [x] Reviewers query assigned peer reviews via collection-group query and submit via callable function.
- [x] Subscriptions, authorizations, and payments are student-nested and server-protected.
- [x] All question papers, analysis runs, topic resolver mappings, and settings are preserved intact.
