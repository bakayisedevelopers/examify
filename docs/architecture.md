# Examify architecture

## Frontend
- React + Vite + Tailwind CSS.
- React Router controls the landing page, auth flows, and role-based workspaces.
- Firebase client SDK handles authentication, Firestore, Storage, and callable functions.
- Demo-mode fallbacks keep the app runnable before credentials are configured.

## Backend
- Firebase Cloud Functions provide secure Paystack initialization, verification, and stored-authorization charging.
- Firebase AI Logic provides Gemini-powered exercise recommendations from the web app through the shared Firebase client configuration.
- Firestore stores users, tutor assignments, covered topics, question papers, subscriptions, payments, submissions, tutor reports, and peer reviews.
- Firebase Storage stores uploaded image submissions.

### Question-paper analysis pipeline

Question-paper analysis uses five separate Cloud Functions so long-running AI work is not performed in the Firestore trigger:

1. `analyzeQuestionPaper` creates an immutable analysis run and places the paper at the end of the shared FIFO queue.
2. `dispatchQuestionPaperAnalysis` claims only the oldest paper when no other paper owns the analysis slot.
3. `prepareQuestionPaperAnalysis` validates the claimed PDF, fingerprints the source bytes, renders pages to private working objects, creates two-page batch records, and enqueues the batches.
4. `analyzeQuestionPaperBatch` sends the active paper's batches to the configured Kilo vision model with bounded concurrency and independent retries.
5. `finalizeQuestionPaperAnalysis` runs only after every batch completes, validates the text model's JSON, publishes the question index, deletes temporary page images, releases the analysis slot, and dispatches the next paper.

Run and batch records live below `questionPapers/{paperId}/analysisRuns/{runId}`. Source fingerprints prevent results from one uploaded file being treated as results for another. A new retry creates a new run, so it performs a full vision analysis rather than silently reusing stale page output.

Initial uploads and manual retries use the same queue. Each request receives a server timestamp: the first request starts as soon as the shared slot is free, while later retry clicks wait behind every earlier request.

Only one paper is prepared or analyzed at a time. Two-page batches within that active paper can use up to three concurrent dispatches; all tasks use five attempts with exponential backoff. The Cloud Functions runtime service account must have permission to enqueue Cloud Tasks when deploying this pipeline.

## Key business rules implemented
- Maths-only positioning is reflected across landing copy, role flows, and backend metadata.
- Students can access only today's exercise for completion; missed work is locked and upcoming work is unavailable.
- Tutors can record covered topics and reports.
- A tutor-to-student assignment check prevents more than one active Maths tutor relationship.
- Subscription quotes derive from the latest mark and session type.
- Gemini recommendations are architected to use grade, region, completed topics, tutor reports, past marks, and question paper metadata.
