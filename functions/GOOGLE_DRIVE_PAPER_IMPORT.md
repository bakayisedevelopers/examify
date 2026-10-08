# Google Drive past-paper import setup

The importer reads Drive as the scheduled/manual Function's runtime service account. It does not use a developer's local `gcloud` login or any credential file.

## Required configuration

1. Enable the Google Drive API in the same Google Cloud project as Firebase Functions.
2. Add the ID of the one past-papers root folder to the Functions environment as `GOOGLE_DRIVE_PAPERS_ROOT_ID`. The importer only traverses that folder and its subfolders.
3. Share that folder with the deployed Function's runtime service account as **Viewer**. Do not make the folder or papers public.
4. Ensure the Function identity can obtain Drive read-only OAuth scope. The code requests `https://www.googleapis.com/auth/drive.readonly` from the Google Cloud metadata server; it stores no token or key.

Check the deployed runtime identity with:

```sh
gcloud functions describe importGoogleDrivePastPapers --gen2 --region=us-central1 --format='value(serviceConfig.serviceAccountEmail)'
```

Use the actual deployed region if it differs from `us-central1`. The identity to share with Drive is the returned `serviceAccountEmail`, not the account signed in to `gcloud` on a developer machine.

In this Firebase project, the existing Gen 2 paper-analysis functions currently report `598489092395-compute@developer.gserviceaccount.com`. The importer does not override the project runtime identity, so verify the new scheduled function after deployment and share the configured folder with its reported identity.

For Firebase CLI deployments, set `GOOGLE_DRIVE_PAPERS_ROOT_ID` in the Functions environment file for the project (for example `functions/.env.examifying`) before deployment. Keep the folder ID out of frontend environment files. It is a folder identifier, not an authentication credential.

If Drive is in a Shared Drive, the runtime identity still needs Viewer membership/access to the configured root. The listing requests support for shared-drive items and follows folder children only.

## Import behavior

- The scheduled scan runs every two hours at minute 0 in `Africa/Johannesburg`.
- `googleDrivePaperImports/{driveFileId}` stores per-file progress, checksums, status, and target record IDs.
- A Firestore lease prevents scheduled and manual runs from importing concurrently.
- Question paper records are created with `source: "google_drive"` and `analysisStatus: "Analyzing"`. The existing `questionPapers/{paperId}` write trigger starts analysis.
- Memos use the existing `memoUrl` fields. If a matching paper has no memo, the importer fills only the memo fields; it does not change the existing source or analysis status.
- Ambiguous names, uncertain metadata matches, changed Drive revisions, and combined paper/memo PDFs are held for manual review.
- A memo whose matching question-paper record has not appeared yet stays in a waiting state and is retried on a later run.
