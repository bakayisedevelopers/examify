# Examify

Examify is a production-oriented first version of a Mathematics learning platform for South African students using the 70-20-10 model. This repository now contains a complete Vite/React frontend, Tailwind design system, Firebase integration layer, Cloud Functions for Paystack and Firebase AI Logic-backed Gemini usage, and setup documentation.

## What is included

- Modern responsive landing page for the Examify value proposition.
- Role-based authentication flows for students, tutors, and admins.
- Protected student, tutor, and admin dashboards.
- Daily exercise logic enforcing today-only completion and locked missed exercises.
- Image submission upload flow using Firebase Storage.
- Peer review flow with marks and comments.
- Tutor tools for covered-topic tracking, free-text reports, and question-paper metadata.
- Admin overview surfaces for payments, tutors, and platform monitoring.
- Firebase callable functions for secure Paystack initialization, verification, and recurring authorization charging.
- Firebase AI Logic integration for Gemini exercise recommendations from the frontend Firebase app.
- Demo-mode data so the app runs before Firebase credentials are available.

## Tech stack

- React 19 + Vite
- Tailwind CSS
- React Router
- Firebase Authentication
- Cloud Firestore
- Firebase Storage
- Firebase Cloud Functions
- Firebase AI Logic (Gemini)
- Paystack

## Project structure

```text
src/
  components/
  data/
  firebase/
  hooks/
  layouts/
  lib/
  pages/
  routes/
  services/
  utils/
functions/
  src/
docs/
```

## Local setup

### 1. Install dependencies

```bash
npm install
cd functions && npm install && cd ..
```

### 2. Configure environment variables

Copy the example files and add your real values:

```bash
cp .env.example .env
cp functions/.env.example functions/.env
```

Frontend variables:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIRESTORE_DATABASE_ID` (use `(default)` or your named database such as `tutoring`)
- `VITE_FIREBASE_AI_MODEL` (for example `gemini-2.5-flash`)

Functions variables:

- `PAYSTACK_SECRET_KEY`
- `PAYSTACK_BASE_URL`
- `PAYSTACK_CALLBACK_URL`
- `FIRESTORE_DATABASE_ID` (use `(default)` or your named database such as `tutoring`)
- `KILO_BASE_URL` (defaults to `https://api.kilo.ai/api/openrouter`)
- `KILO_TEXT_MODEL` and `KILO_FALLBACK_TEXT_MODEL`
- `KILO_VISION_MODEL` and comma-separated `KILO_FALLBACK_VISION_MODELS`

### 3. Run the app

```bash
npm run dev
```

### 4. Optional: run Firebase Functions locally

```bash
npm run functions:serve
```

## Demo accounts

When Firebase is not configured, the app automatically runs in demo mode. Use these accounts on the login page:

- `student@example.com`
- `tutor@example.com`
- `admin@example.com`

Any password is accepted in demo mode.

## Where to get the credentials

- `PAYSTACK_SECRET_KEY`: In Paystack Dashboard → **Settings** → **API Keys & Webhooks**. Test keys start with `sk_test_`; live keys start with `sk_live_`.
- `PAYSTACK_BASE_URL`: Keep this as `https://api.paystack.co` unless Paystack specifically instructs you to change it.
- `PAYSTACK_CALLBACK_URL`: Use the frontend URL Paystack should send the user back to after payment, for example `http://localhost:5173/student/billing` in local development or your production domain route later.
- `VITE_FIREBASE_AI_MODEL`: Set the Firebase AI Logic Gemini model used by the web app, for example `gemini-2.5-flash`.
- `VITE_FIRESTORE_DATABASE_ID` / `FIRESTORE_DATABASE_ID`: Set these to `(default)` for the default Firestore database, or to your named database such as `tutoring`.

## Production notes

- Paystack secret keys are only used in Firebase Cloud Functions.
- Gemini recommendations are now generated through Firebase AI Logic in the frontend Firebase initialization layer instead of the older direct Gemini Developer API function path.
- Storage uploads create submission documents in Firestore after a successful upload.
- Tutor assignment logic blocks a second active Maths tutor for the same student.
- Question papers enter a shared FIFO Cloud Tasks workflow. One paper completes its preparation, independently retryable two-page vision batches, and finalization before the next paper starts. Deploying functions must be allowed to create and enqueue Cloud Tasks.
- The current app includes realistic structure for future extensions such as AI moderation comparison, analytics, scheduling, and automated recurring renewals.

## Firestore entities modeled

- `users/{studentId}/subjects/{subjectInstanceId}` is the authoritative enrollment episode.
- Episode-owned `topics`, `understandingScores`, `lessons`, `reports`, `exercises`, `submissions`, `peerReviews`, `peerMarkingAssignments`, and `generationRuns` are nested beneath that episode.
- Student billing is isolated under `users/{studentId}/subscriptions`, `subscriptionAuthorizations`, and `payments`.
- User notifications, notification tokens and logs are nested under `users/{uid}`.
- Shared data is limited to `questionPapers`, `topicResolverMappings`, and `settings`.

## Next recommended steps

1. Connect a real Firebase project and set Firestore security rules.
2. Deploy Cloud Functions and configure Paystack callback URLs.
3. Replace demo data loaders with full Firestore queries for each dashboard module.
4. Add scheduled functions for recurring renewals and richer AI exercise orchestration.
5. Add end-to-end tests once deployment credentials and emulator workflows are available.
