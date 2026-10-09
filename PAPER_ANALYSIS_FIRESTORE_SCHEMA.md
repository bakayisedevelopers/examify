# Examifying past-paper analysis: Firestore schema and JSON handoff

This document describes how the current paper analyzer reads a paper, stages its work, and saves the final analyzed question data. It is intended as a specification for preparing JSON analysis files that a future trusted backend importer could validate and save without calling an AI model.

> **Implementation note:** JSON-file ingestion is not implemented by this document or by the current analyzer. The example below is a proposed handoff format based on the existing final Firestore fields. A future importer must validate it, derive server-owned fields, and write through a trusted backend. Do not let a browser client write analyzed-paper records directly.

## 1. Overview

The current flow is:

```text
PDF uploaded to Firebase Storage
  -> questionPapers/{paperId} created with analysisStatus = "Analyzing"
  -> analyzeQuestionPaper creates a queued analysis run
  -> dispatcher claims one run and queues PDF preparation
  -> PDF pages are rendered to temporary JPEGs in Storage
  -> one analysis batch is stored per analyzed page
  -> batches are combined and normalized
  -> global subject/grade topics are merged
  -> final analyzed fields are written to questionPapers/{paperId}
  -> temporary rendered JPEGs are deleted
```

The application reads the final question index from the **top-level `questionPapers/{paperId}` document**. It does not use one Firestore document per question. `questions` is an array embedded in that paper document.

The analyzer uses the question-paper PDF (`paperUrl`) as its visual source. The memo is kept as a separate file on the same paper record; the current preparation flow does not render or analyze the memo PDF.

## 2. Firestore paths

| Path | Purpose | Lifecycle |
| --- | --- | --- |
| `questionPapers/{paperId}` | Paper metadata, Storage links, analysis status, and the final analyzed question index | Long-lived application record |
| `questionPapers/{paperId}/analysisRuns/{runId}` | Queue/run state, source fingerprints, topic options, counts, models, and timestamps | Operational history retained after completion |
| `questionPapers/{paperId}/analysisRuns/{runId}/batches/{batchId}` | Per-page AI extraction output and processing state | Operational history retained after completion |
| `questionPaperAnalysisQueue/{runId}` | Waiting analysis runs | Queue row is removed when claimed by the dispatcher |
| `questionPaperAnalysisState/worker` | Single active run lease/state for the serialized analysis worker | Current operational state |
| `questionPaperAnalysisControl/global` | Admin pause/resume control | Operational setting |
| `subjects/{subject}/grades/{grade}` | Shared topic catalogue for a subject and grade | Long-lived global reference data |

The values `paperId`, `runId`, and `batchId` are identifiers, not analysis content. A future import backend should assign or resolve them; an AI-authored analysis JSON file should not invent Firestore document IDs.

## 3. Source paper document

The frontend uploads the question paper and optional memo separately, then creates the paper record. Google Drive imports use the same `questionPapers` collection and the same analysis trigger, with Drive-specific source fields.

### 3.1 Identity and file fields

The paper document has these established source fields:

| Field | Meaning |
| --- | --- |
| `subject` | Canonical subject name, such as `Mathematics` or `Accounting` |
| `grade` | Grade label, commonly `Grade 10` |
| `region` | Province or `National` |
| `month` | Exam month string, such as `November` |
| `year` | Numeric exam year |
| `paperNumber` | Paper identifier such as `Paper 1`; preserve Paper 1 and Paper 2 separately |
| `paperUrl` | Firebase Storage download URL for the question-paper PDF; required by the analyzer trigger |
| `paperFileName` | Original question-paper filename |
| `paperMimeType` | Question-paper MIME type, normally `application/pdf` |
| `memoUrl` | Firebase Storage download URL for the optional memo PDF, or an empty string |
| `memoFileName` | Original memo filename, or an empty string |
| `memoMimeType` | Memo MIME type, or an empty string |
| `displayName` | Human-readable paper label used by the application |
| `paperTitle` | Display title; importer records may store the same title here |
| `copyNumber` | Number used by the existing duplicate/copy display convention |
| `copySuffix` | Display suffix such as `(1)`, or an empty string |
| `createdBy` | Uploader identity or importer label |
| `createdAt` | Firestore timestamp for record creation |

The frontend's Firebase Storage paths follow `questionPapers/{uploaderId}/paper` and `questionPapers/{uploaderId}/memo`. The Drive importer uses its own non-overwriting path under `questionPapers/google-drive/{fileType}/{driveFileId}.pdf`. In either case, the analyzer consumes the stored `paperUrl`, not a hard-coded Storage path.

Drive-created records additionally use fields such as `source: "google_drive"`, `driveFileId`, and a `driveImport` tracking map. Those describe ingestion provenance; they are not AI analysis fields. Existing records from the frontend are not relabeled by the Drive importer.

### 3.2 Analysis lifecycle fields

The document trigger starts a run only when `analysisStatus` is `Analyzing`, `paperUrl` is present, and the status, URL, or `analysisRevision` changed. It then sets or updates fields including:

```json
{
  "analysisStatus": "Analyzing",
  "analysisStage": "Queued",
  "analysisProgressMessage": "Waiting for earlier question papers to finish",
  "analysisProgressCurrent": 0,
  "analysisProgressTotal": 1,
  "analysisError": "",
  "analysisStartedAt": "Firestore Timestamp",
  "activeAnalysisRunId": "backend-generated run id or null",
  "queuedAnalysisRunId": "backend-generated run id or null",
  "availableForGeneration": false
}
```

After successful analysis, the important final state is:

```json
{
  "analysisStatus": "Analyzed",
  "analysisStage": "Completed",
  "availableForGeneration": true,
  "analysisCompletedAt": "Firestore Timestamp",
  "analysisProgressMessage": "Analyzed N questions",
  "analysisProgressCurrent": 2,
  "analysisProgressTotal": 2,
  "analysisError": ""
}
```

`availableForGeneration` is true only when at least one question was saved. Failure sets `analysisStatus` to `Failed`, stores an error summary, and keeps the paper unavailable for generation. A pre-analyzed JSON import must not claim `Analyzed` until validation and all required Firestore writes have succeeded.

## 4. Final analysis fields on `questionPapers/{paperId}`

On completion, the analyzer writes the following application-facing fields to the paper document:

| Field | Shape / meaning |
| --- | --- |
| `paperMetadata` | Normalized and partly derived metadata object, specified below |
| `questions` | Array of normalized question objects, specified below |
| `questionCount` | Number of saved normalized questions |
| `topics` | Unique topic labels retained for this analyzed paper |
| `topicMetadata` | Array of `{ topic, difficulty }` records for retained topics |
| `paperAnalysisSummary` | Combined short summary from page batches |
| `analysisReadabilityNotes` | Unique readability notes from page batches |
| `paperDocumentAnalysis` | Concatenated page-batch text, capped at 45,000 characters |
| `memoDocumentAnalysis` | Concatenated memo-batch text, capped at 25,000 characters; currently normally empty because memo pages are not analyzed |
| `paperDocumentAnalysisModel` | Comma-separated unique models that analyzed paper batches |
| `memoDocumentAnalysisModel` | Comma-separated unique models for memo batches; currently normally empty |
| `paperDocumentAnalysisPageCount` | Number of question-paper pages analyzed (up to 40) |
| `memoDocumentAnalysisPageCount` | Memo page count; currently 0 in the existing preparation path |
| `analysisTextModel` | Currently an empty string |
| `analysisVisionModels` | Unique model names used for question-paper vision analysis |
| `analysisSourcePaperFingerprint` | SHA-256 of the source question-paper PDF bytes |
| `analysisSourceMemoFingerprint` | Currently an empty string in the existing preparation path |
| `updatedAt` | Firestore timestamp for final update |

The original source fields (`subject`, `grade`, `year`, file URLs, and others) remain at the top level of the paper document. `paperMetadata` is a separate nested normalized snapshot for display and analysis; it does not replace the source fields or file references.

### 4.1 `paperMetadata`

The current analyzer constructs this object from the source paper record and final questions:

```json
{
  "year": 2024,
  "month": "November",
  "subject": "Mathematics",
  "grade": "Grade 8",
  "region": "Gauteng",
  "paperNumber": "Paper 1",
  "copySuffix": "",
  "paperTitle": "Mathematics • Grade 8 • Gauteng • November • 2024 • Paper 1",
  "totalMarks": 100,
  "confidence": "medium",
  "topicMetadata": [
    { "topic": "Fractions | Fraction Concepts", "difficulty": "medium" }
  ]
}
```

`totalMarks` is derived by summing the saved questions' `marks`. `confidence` is currently `medium` when there is at least one saved question and `low` when there are none. The backend should recompute these derived values instead of accepting inconsistent AI-provided totals or confidence values.

The `topicMetadata` array is intentionally repeated at the top level and inside `paperMetadata`, matching the current writer.

### 4.2 `questions[]`

Each item represents one question or sub-question from the PDF. The current normalization writes:

```json
{
  "id": "backend-generated-paperId-questionReference",
  "paperId": "backend-generated-paperId",
  "questionReference": "2.3",
  "parentQuestion": "2",
  "subject": "Mathematics",
  "topic": "Fractions | Fraction Concepts",
  "topics": ["Fractions | Fraction Concepts"],
  "difficulty": "medium",
  "pageNumber": 4,
  "marks": 5,
  "section": "Section B",
  "instruction": "",
  "memoSummary": "",
  "sourceDocumentType": "paper",
  "sourceBatchId": "paper-4"
}
```

Field requirements and rules:

| Field | JSON authoring guidance |
| --- | --- |
| `questionReference` | Required. Preserve the printed number, including hierarchy such as `2`, `2.1`, `2.1(a)`. Keep it unique within one paper after case and whitespace normalization. |
| `parentQuestion` | Recommended. Top-level number for the question, for example `2` for `2.3`. The backend can derive it from the reference when omitted. |
| `topic` | Required for classified questions. Should equal the first item in `topics`. Use a known canonical topic label where available. |
| `topics` | Required array of one or more canonical topic labels. Each label should use `Child | Parent`. Do not use child-only legacy labels. |
| `difficulty` | Required per question: exactly `easy`, `medium`, or `hard`, including questions whose topic could not be classified. This field is used by downstream exercise selection. |
| `pageNumber` | Required positive integer pointing to the page in the original question-paper PDF, not a page in a memo. |
| `marks` | Required non-negative number for the question/sub-question allocation. Use the printed available mark value, not a student's achieved score. |
| `section` | Optional short section label such as `Section A`; use an empty string when absent. |
| `subject` | The canonical source paper subject. The current normalizer fills it from the paper record if omitted. |
| `id`, `paperId` | Backend-generated from the target paper document and question reference. Do not author these in a source JSON file. |
| `sourceDocumentType`, `sourceBatchId` | Pipeline provenance generated by the current page-batch analyzer. For an import that bypasses batches, the future backend should set a consistent source such as `paper` and may omit the batch ID if no batch exists. |
| `instruction`, `memoSummary` | The current analyzer deliberately saves empty strings; it does not store full question text or answers in these fields. Do not put answer keys or full copyrighted question text here. |

The current analyzer merges repeated question references across batches into one question row, merges their topic arrays without duplicates, and keeps one normalized question record per reference. It caps the final question index at 180 items. Keep each actual sub-question as its own reference when the paper prints it separately.

### 4.3 `topics` and `topicMetadata`

Paper-level `topics` is a unique array of labels found in the normalized question records or extracted batch topics. The finalizer retains topics that have an associated difficulty record.

Use canonical labels in the form:

```text
Child topic | Parent topic
```

For example:

```json
{
  "topics": [
    "Fractions | Fraction Concepts",
    "Equivalent Fractions | Fraction Concepts"
  ],
  "topicMetadata": [
    { "topic": "Fractions | Fraction Concepts", "difficulty": "medium" },
    { "topic": "Equivalent Fractions | Fraction Concepts", "difficulty": "easy" }
  ]
}
```

Difficulty must be one of `easy`, `medium`, or `hard`. If a topic already has difficulty saved in the global catalogue, the analyzer preserves that existing value. Otherwise it chooses the most common difficulty among questions associated with that topic. When tied, the current code prefers `medium`, then uses alphabetical order for the remaining tie.

If one question genuinely covers multiple topics, list each label in `topics`. Its primary `topic` should be the first label. A future importer should reject or review labels that do not match the global catalogue conventions rather than quietly saving malformed topic strings.

## 5. Shared subject/grade topic catalogue

When analysis yields topic labels, the finalizer merges them into:

```text
subjects/{subject}/grades/{grade}
```

The grade document contains:

```json
{
  "subjectName": "Mathematics",
  "gradeName": "Grade 8",
  "topics": [
    "Fractions | Fraction Concepts",
    "Equivalent Fractions | Fraction Concepts"
  ],
  "topicMetadata": [
    { "topic": "Fractions | Fraction Concepts", "difficulty": "medium" },
    { "topic": "Equivalent Fractions | Fraction Concepts", "difficulty": "easy" }
  ],
  "updatedAt": "Firestore Timestamp"
}
```

This is a shared catalogue for all papers of that subject and grade, not a paper-specific subcollection. The merge preserves existing topic labels and difficulty values, adds new canonical labels, and avoids duplicate labels by normalized identity. A future JSON importer that writes an analyzed paper should also call the existing trusted global-topic merge helper (or equivalent transaction) so the paper and catalogue stay in sync.

## 6. Analysis run and batch documents

These records support progress, retry, and audit of the current AI pipeline. They are not the canonical question index consumed by the application.

### 6.1 Run document

Path: `questionPapers/{paperId}/analysisRuns/{runId}`.

It includes fields such as:

```json
{
  "paperId": "...",
  "runId": "...",
  "status": "Queued | Preparing | Rendering | BatchesQueued | Structuring | Analyzed | Failed | Cancelled",
  "sourcePaperUrl": "...",
  "sourceMemoUrl": "...",
  "topicOptions": [{ "topic": "...", "difficulty": "medium" }],
  "requestedRevision": null,
  "paperFingerprint": "sha256 hex string",
  "memoFingerprint": "",
  "paperPageCount": 12,
  "paperAnalyzedPageCount": 12,
  "memoPageCount": 0,
  "memoAnalyzedPageCount": 0,
  "batchCount": 12,
  "completedBatchCount": 12,
  "questionCount": 38,
  "visionModels": ["model name"],
  "createdAt": "Firestore Timestamp",
  "startedAt": "Firestore Timestamp",
  "completedAt": "Firestore Timestamp",
  "updatedAt": "Firestore Timestamp"
}
```

Actual run records contain more worker fields, including queue/lease progress. `topicOptions` is a snapshot of the global subject/grade topics supplied to AI so the run uses a stable catalogue.

### 6.2 Batch document

Path: `questionPapers/{paperId}/analysisRuns/{runId}/batches/{batchId}`. Current IDs look like `paper-1`, `paper-2`, etc., because analysis is batched one page at a time.

A completed batch has fields including:

```json
{
  "batchId": "paper-4",
  "documentType": "paper",
  "pages": [
    {
      "label": "Question paper",
      "pageNumber": 4,
      "totalPages": 12,
      "storagePath": "questionPaperAnalysis/{paperId}/{runId}/Question-paper/page-4.jpg",
      "text": "Optional embedded PDF text",
      "sourceFingerprint": "sha256 hex string"
    }
  ],
  "status": "Completed",
  "attemptCount": 1,
  "model": "model name",
  "fallbackUsed": false,
  "fallbackFrom": "",
  "text": "AI extraction text for this page, capped at 6,000 characters",
  "questions": [],
  "topics": [],
  "topicMetadata": [],
  "summary": "Short summary",
  "readabilityNotes": [],
  "parseWarning": "",
  "completedAt": "Firestore Timestamp",
  "updatedAt": "Firestore Timestamp"
}
```

The page JPEGs are temporary Storage objects under `questionPaperAnalysis/{paperId}/{runId}/...`. They are deleted after finalization, cancellation, or terminal failure. The page descriptors and extraction batches remain in Firestore as operational history. Do not use temporary JPEG paths as paper viewer URLs.

## 7. Recommended JSON handoff for future pre-analyzed imports

For each question paper, an AI-created file can use this versioned shape. This is a **recommended input contract**, not a schema that the current function automatically accepts.

```json
{
  "schemaVersion": 1,
  "paper": {
    "subject": "Mathematics",
    "grade": "Grade 8",
    "region": "Gauteng",
    "month": "November",
    "year": 2024,
    "paperNumber": "Paper 1",
    "displayName": "Mathematics • Grade 8 • Gauteng • November • 2024 • Paper 1"
  },
  "analysis": {
    "questions": [
      {
        "questionReference": "1.1",
        "parentQuestion": "1",
        "topic": "Fractions | Fraction Concepts",
        "topics": ["Fractions | Fraction Concepts"],
        "difficulty": "easy",
        "pageNumber": 2,
        "marks": 2,
        "section": "Section A"
      },
      {
        "questionReference": "1.2",
        "parentQuestion": "1",
        "topic": "Equivalent Fractions | Fraction Concepts",
        "topics": ["Equivalent Fractions | Fraction Concepts"],
        "difficulty": "medium",
        "pageNumber": 2,
        "marks": 3,
        "section": "Section A"
      }
    ],
    "topics": [
      "Fractions | Fraction Concepts",
      "Equivalent Fractions | Fraction Concepts"
    ],
    "topicMetadata": [
      { "topic": "Fractions | Fraction Concepts", "difficulty": "easy" },
      { "topic": "Equivalent Fractions | Fraction Concepts", "difficulty": "medium" }
    ],
    "summary": "Questions assess fraction operations and equivalence.",
    "readabilityNotes": []
  }
}
```

### 7.1 Required validation for a future importer

Before any Firestore write, the backend should:

1. Validate `schemaVersion` and reject unknown versions.
2. Match `paper` identity fields to the already-uploaded paper document: `subject`, `grade`, `region`, `month`, `year`, and `paperNumber`. The PDF and memo Storage URLs must come from the existing import/upload record, not from AI JSON.
3. Validate each `questionReference`, positive integer `pageNumber`, and non-negative numeric `marks`; enforce a sensible maximum question count (the analyzer currently stores at most 180).
4. Require a valid difficulty on every question. Normalize aliases only if the importer deliberately follows the analyzer's `easy` / `medium` / `hard` normalization.
5. Require canonical topic labels and ensure every per-question topic appears in the paper-level `topics` list and in `topicMetadata`.
6. Recompute `parentQuestion`, normalized question `id`, per-question `paperId`, `questionCount`, `paperMetadata.totalMarks`, and `paperMetadata.confidence` on the server.
7. Validate page numbers against the uploaded PDF's actual page count. Do not infer page numbers from question numbering.
8. Deduplicate by normalized `questionReference` using the same rule as the analyzer (lowercase and remove whitespace); reject conflicting duplicates for manual review rather than silently dropping different questions.
9. Merge `topics` and `topicMetadata` into `subjects/{subject}/grades/{grade}` with existing catalogue semantics.
10. Write analysis content first and mark `analysisStatus: "Analyzed"` with `availableForGeneration` only after the content and topic catalogue writes succeed. Use a transaction or recoverable import state to avoid exposing a partially saved paper.
11. Preserve the original paper record's uploader/source fields and Storage references. Do not overwrite a different existing paper or its source labels as a side effect of deduplication.

The future importer should assign the Firestore paper document ID (or use a known importer ID), then set each question's `id` and `paperId` consistently. It should also set `sourceDocumentType: "paper"` for every question. `sourceBatchId` is only meaningful if the future importer retains a page/batch provenance scheme; otherwise it can be omitted or assigned by a documented convention.

### 7.2 Fields the AI JSON should not supply

Do not trust or accept AI-authored values for:

- Firestore document IDs (`paperId`, run IDs, batch IDs, or question `id`).
- Storage URLs, bucket paths, download tokens, Drive IDs, or source labels.
- Queue, run, worker, lease, retry, analysis progress, status, or error fields.
- `createdAt`, `updatedAt`, `analysisStartedAt`, or `analysisCompletedAt` timestamps.
- `availableForGeneration`, `questionCount`, `paperMetadata.totalMarks`, or duplicate/copy counters.
- Model names, source fingerprints, or ingestion tracking fields.
- Scores for a student, understanding-score records, tutor marks, or any user/account data.

Those fields are backend-owned, sourced from the actual PDF/import context, or derived from validated analysis content.

## 8. Reliability and compatibility notes

- The analysis trigger currently requires `paperUrl` and the `Analyzing` status. Creating a paper record directly as `Analyzed` bypasses that pipeline, which is appropriate only for a future trusted importer that fully validates and writes the final schema itself.
- If a future import wants the existing queue to run, it should create/update the paper record with `analysisStatus: "Analyzing"`; the Firestore trigger then queues it. It must not also create a second analysis queue item manually.
- The analyzer currently analyzes only the question-paper PDF. Keep memo PDFs attached in `memoUrl`/`memoFileName` and do not merge memo answers into question records unless a separately reviewed pipeline explicitly supports that behavior.
- Topic labels and difficulty are used by exercise generation. Incorrect topics, marks, question references, page numbers, or difficulty values can affect lessons and generated exercises even if the Firestore write itself succeeds.
- The analyzer's page limit is 40 pages per document, one page per extraction batch, and its final question array is limited to 180 questions.
- `analysisBatchOutputs` and full extraction text are diagnostic/history data. The application-facing source of truth for analyzed questions remains `questionPapers/{paperId}.questions`.

## 9. Code references

- `functions/src/questionPaperAnalysis.js` — queue lifecycle, PDF page rendering, AI batch parsing, normalization, final paper writes.
- `functions/src/globalTopicCatalog.js` — global topic labels, difficulty metadata, and safe merge behavior.
- `src/pages/PastExamPapersPage.jsx` — frontend manual and bulk paper upload flow.
- `src/services/storageService.js` — frontend question paper and memo Storage paths.
- `src/services/firestoreService.js` — paper record creation and reads.
- `functions/src/googleDrivePaperImportCore.js` and `functions/src/googleDrivePaperImport.js` — Drive importer record fields and Storage conventions.
