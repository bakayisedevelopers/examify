import { randomUUID } from 'node:crypto';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { getDb, storage } from './admin.js';
import {
  createDrivePaperImportRunner,
  DRIVE_PAPER_IMPORT_SCHEDULE,
  safeErrorSummary,
  summarizeDriveFolderPapers,
} from './googleDrivePaperImportCore.js';

const GOOGLE_DRIVE_ROOT_ENV = 'GOOGLE_DRIVE_PAPERS_ROOT_ID';
const DRIVE_READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const TRACKING_COLLECTION = 'googleDrivePaperImports';
const LOCK_DOCUMENT = 'googleDrivePaperImportLocks/active';
const LOCK_DURATION_MS = 12 * 60 * 1000;
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const SUBJECT_ALIASES = [
  'Mathematics', 'Maths', 'Math',
  'Mathematical Literacy', 'Maths Literacy', 'Math Literacy', 'Maths Lit', 'Math Lit',
];

let driveTokenCache = { token: '', expiresAt: 0 };

const getRuntimeDriveToken = async () => {
  if (driveTokenCache.token && driveTokenCache.expiresAt > Date.now() + 60_000) return driveTokenCache.token;
  const metadataUrl = new URL('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
  metadataUrl.searchParams.set('scopes', DRIVE_READ_SCOPE);
  const response = await fetch(metadataUrl, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!response.ok) {
    throw new Error('Could not obtain a Google Drive access token from the function runtime identity. Confirm the function runs on Google Cloud and has a runtime service account.');
  }
  const tokenData = await response.json();
  if (!tokenData.access_token) throw new Error('The function runtime identity returned no Google Drive access token.');
  driveTokenCache = {
    token: tokenData.access_token,
    expiresAt: Date.now() + Number(tokenData.expires_in ?? 3600) * 1000,
  };
  return driveTokenCache.token;
};

const driveRequest = async (url, { download = false, maxBytes = MAX_PDF_BYTES } = {}) => {
  const token = await getRuntimeDriveToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, ...(download ? {} : { Accept: 'application/json' }) },
  });
  if (!response.ok) {
    const error = new Error(`Google Drive API request failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  if (!download) return response.json();

  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > maxBytes) throw new Error(`The Drive PDF exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB import limit.`);
  if (!response.body) throw new Error('Google Drive returned an empty PDF response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`The Drive PDF exceeds the ${Math.round(maxBytes / 1024 / 1024)} MiB import limit.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
};

const driveFileFields = 'id,name,mimeType,modifiedTime,version,size,md5Checksum,parents,trashed';
const listDriveFolderPage = async (folderId, pageToken) => {
  const url = new URL(`${DRIVE_API_BASE}/files`);
  url.searchParams.set('q', `'${String(folderId).replaceAll("'", "\\'")}' in parents and trashed = false`);
  url.searchParams.set('pageSize', '1000');
  url.searchParams.set('orderBy', 'name');
  url.searchParams.set('fields', `nextPageToken,files(${driveFileFields})`);
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  if (pageToken) url.searchParams.set('pageToken', pageToken);
  return driveRequest(url);
};

const getDriveFolder = async (folderId) => {
  const url = new URL(`${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}`);
  url.searchParams.set('fields', 'id,name,mimeType,trashed,parents');
  url.searchParams.set('supportsAllDrives', 'true');
  return driveRequest(url);
};

const listDriveFolderChildren = async (folderId) => {
  const files = [];
  let pageToken;
  do {
    const page = await listDriveFolderPage(folderId, pageToken);
    files.push(...(page.files ?? []).filter((file) => !file.trashed));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
};

const requireConfiguredDriveRoot = () => {
  const rootFolderId = String(process.env[GOOGLE_DRIVE_ROOT_ENV] ?? '').trim();
  if (!rootFolderId) {
    throw new Error('Google Drive past-paper import is not configured: set GOOGLE_DRIVE_PAPERS_ROOT_ID to one specific folder ID.');
  }
  return rootFolderId;
};

const getFolderWithinConfiguredRoot = async (folderId) => {
  const rootFolderId = requireConfiguredDriveRoot();
  let folder;
  try {
    folder = await getDriveFolder(folderId);
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      throw new Error(`The selected Google Drive folder is unavailable to the Function runtime identity. Verify folder sharing and GOOGLE_DRIVE_PAPERS_ROOT_ID. (Drive HTTP ${error.status})`);
    }
    throw error;
  }
  if (folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('The selected Drive item is not an available folder.');
  }

  if (folder.id === rootFolderId) return { folder, path: [folder.name], isRoot: true };
  const pathSegments = [folder.name];
  const visited = new Set([folder.id]);
  let currentFolder = folder;
  for (let depth = 0; depth < 50; depth += 1) {
    const parentId = currentFolder.parents?.[0];
    if (!parentId) break;
    if (parentId === rootFolderId) {
      const root = await getDriveFolder(rootFolderId);
      return { folder, path: [root.name, ...pathSegments.reverse()], isRoot: false };
    }
    if (visited.has(parentId)) break;
    visited.add(parentId);
    currentFolder = await getDriveFolder(parentId);
    if (currentFolder.trashed || currentFolder.mimeType !== 'application/vnd.google-apps.folder') break;
    pathSegments.push(currentFolder.name);
  }
  throw new Error('The selected folder is outside the configured past-papers root folder.');
};

const listConfiguredDriveTree = async (rootFolderId) => {
  let root;
  try {
    root = await getDriveFolder(rootFolderId);
  } catch (error) {
    if (error.status === 403 || error.status === 404) {
      throw new Error(`The configured Google Drive folder is unavailable to the function runtime identity. Share only this folder with the function service account as Viewer, confirm the Drive API is enabled, and check GOOGLE_DRIVE_PAPERS_ROOT_ID. (Drive HTTP ${error.status})`);
    }
    throw error;
  }
  if (root.trashed || root.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('GOOGLE_DRIVE_PAPERS_ROOT_ID must refer to an existing, non-trashed Google Drive folder.');
  }

  const results = [];
  const folders = [{ id: root.id, path: [root.name] }];
  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index];
    let pageToken;
    do {
      const page = await listDriveFolderPage(folder.id, pageToken);
      for (const file of page.files ?? []) {
        if (file.trashed) continue;
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          folders.push({ id: file.id, path: [...folder.path, file.name] });
        } else if (file.mimeType === 'application/pdf' || String(file.name ?? '').toLowerCase().endsWith('.pdf')) {
          results.push({ ...file, folderPath: folder.path });
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  return results;
};

const listSelectedFolderPdfs = async (folderId) => {
  const selectedFolder = await getFolderWithinConfiguredRoot(folderId);
  const children = await listDriveFolderChildren(folderId);
  return children
    .filter((file) => file.mimeType === 'application/pdf' || String(file.name ?? '').toLowerCase().endsWith('.pdf'))
    .map((file) => ({ ...file, folderPath: selectedFolder.path }));
};

const extractPdfTextSignals = async (buffer) => {
  const loadingTask = getDocument({ data: new Uint8Array(buffer), disableWorker: true, isEvalSupported: false });
  let pdf;
  try {
    pdf = await loadingTask.promise;
    if (pdf.numPages > 80) {
      return {
        uncertainCombinedDocument: true,
        reason: 'The PDF is longer than the importer can inspect safely for a combined paper and memo; manual review is required.',
      };
    }
    const pageTexts = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items.map((item) => item.str).join(' '));
      page.cleanup();
    }
    const memoPage = /\b(?:memorandum|marking memo(?:randum)?|memo answers|suggested answers)\b/i;
    const questionOnlyPage = /\b(?:answer all questions|all questions must be answered|show all working|question paper)\b/i;
    const hasMemoPage = pageTexts.some((text) => memoPage.test(text));
    const hasQuestionPage = pageTexts.some((text) => questionOnlyPage.test(text));
    if (hasMemoPage && hasQuestionPage) {
      return {
        combinedPaperAndMemo: true,
        reason: 'The PDF contains separate question-paper and memorandum page signals. The repository has no reliable splitter, so this file needs manual review.',
      };
    }
    return { combinedPaperAndMemo: false };
  } catch {
    return {
      uncertainCombinedDocument: true,
      reason: 'The PDF could not be inspected to confirm it contains only one document type; manual review is required.',
    };
  } finally {
    if (pdf) await pdf.destroy().catch(() => {});
    else await loadingTask.destroy().catch(() => {});
  }
};

const storageBucket = () => storage.bucket();
const storageObjectPath = (driveFileId, fileType) => `questionPapers/google-drive/${fileType}/${encodeURIComponent(driveFileId)}.pdf`;
const getStorageDownloadUrl = ({ bucket, path, token }) => `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}/o/${encodeURIComponent(path)}?alt=media&token=${encodeURIComponent(token)}`;

const uploadDrivePdf = async ({ file, buffer, fileType, contentSha256 }) => {
  const bucket = storageBucket();
  const path = storageObjectPath(file.id, fileType);
  const object = bucket.file(path);
  try {
    const [metadata] = await object.getMetadata();
    const custom = metadata.metadata ?? {};
    if (custom.driveFileId !== file.id || custom.contentSha256 !== contentSha256 || custom.fileType !== fileType) {
      throw new Error('A Firebase Storage object already exists at the importer path with different identity or contents. It was not replaced.');
    }
    if (!custom.firebaseStorageDownloadTokens) throw new Error('The existing importer object has no Firebase download token; manual review is required.');
    return { path, url: getStorageDownloadUrl({ bucket, path, token: custom.firebaseStorageDownloadTokens }) };
  } catch (error) {
    if (error.message?.includes('already exists at the importer path') || error.message?.includes('no Firebase download token')) throw error;
    const status = Number(error.code ?? error.statusCode);
    if (status !== 404) throw error;
  }

  const downloadToken = randomUUID();
  await object.save(buffer, {
    resumable: false,
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: {
      contentType: 'application/pdf',
      metadata: {
        firebaseStorageDownloadTokens: downloadToken,
        driveFileId: file.id,
        contentSha256,
        fileType,
        source: 'google_drive',
        sourceFilename: String(file.name ?? '').slice(0, 512),
      },
    },
  });
  return { path, url: getStorageDownloadUrl({ bucket, path, token: downloadToken }) };
};

const getExistingFirebaseStorageObject = (url) => {
  const parsed = new URL(url);
  if (parsed.hostname !== 'firebasestorage.googleapis.com') throw new Error('The existing file URL is not a supported Firebase Storage URL.');
  const pathMatch = parsed.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
  if (!pathMatch) throw new Error('The existing Firebase Storage URL does not contain a known object path.');
  const bucketName = decodeURIComponent(pathMatch[1]);
  const objectPath = decodeURIComponent(pathMatch[2]);
  const bucket = storageBucket();
  if (bucketName !== bucket.name || !objectPath.startsWith('questionPapers/')) {
    throw new Error('The existing paper is stored outside the configured Firebase question-paper bucket.');
  }
  return { objectPath, object: bucket.file(objectPath) };
};

const inspectExistingFirebaseStorage = async (url) => {
  const { objectPath, object } = getExistingFirebaseStorageObject(url);
  const [metadata] = await object.getMetadata();
  return { objectPath, metadata: metadata.metadata ?? {} };
};

const downloadExistingFirebaseFile = async (url) => {
  const { object } = getExistingFirebaseStorageObject(url);
  const [buffer] = await object.download();
  return buffer;
};

const loadExistingQuestionPapers = async () => {
  const db = getDb();
  const snapshots = await Promise.all([
    db.collection('questionPapers').where('subject', 'in', SUBJECT_ALIASES.slice(0, 3)).select(
      'subject', 'grade', 'region', 'province', 'year', 'month', 'paperNumber', 'language', 'examSession', 'session',
      'paperUrl', 'memoUrl', 'paperFileName', 'memoFileName', 'paperSha256', 'memoSha256', 'source', 'driveFileId', 'driveImport',
    ).get(),
    db.collection('questionPapers').where('subject', 'in', SUBJECT_ALIASES.slice(3)).select(
      'subject', 'grade', 'region', 'province', 'year', 'month', 'paperNumber', 'language', 'examSession', 'session',
      'paperUrl', 'memoUrl', 'paperFileName', 'memoFileName', 'paperSha256', 'memoSha256', 'source', 'driveFileId', 'driveImport',
    ).get(),
  ]);
  const uniquePapers = new Map();
  snapshots.forEach((snapshot) => snapshot.docs.forEach((doc) => uniquePapers.set(doc.id, { id: doc.id, ...doc.data() })));
  return [...uniquePapers.values()];
};

const getFolderPaperPreview = async (folderId) => {
  const selectedFolder = await getFolderWithinConfiguredRoot(folderId || requireConfiguredDriveRoot());
  const children = await listDriveFolderChildren(selectedFolder.folder.id);
  const pdfs = children
    .filter((file) => file.mimeType === 'application/pdf' || String(file.name ?? '').toLowerCase().endsWith('.pdf'))
    .map((file) => ({ ...file, folderPath: selectedFolder.path }));
  const [existingPapers, ...trackingResults] = await Promise.all([
    loadExistingQuestionPapers(),
    ...pdfs.map(async (file) => ({ id: file.id, tracking: await readTracking(file.id).catch(() => null) })),
  ]);
  const trackingByFileId = Object.fromEntries(trackingResults.map(({ id, tracking }) => [id, tracking ?? {}]));
  const paperGroups = summarizeDriveFolderPapers({ files: pdfs, trackingByFileId, existingPapers });
  return {
    folder: { id: selectedFolder.folder.id, name: selectedFolder.folder.name, isRoot: selectedFolder.isRoot },
    folders: children
      .filter((item) => item.mimeType === 'application/vnd.google-apps.folder')
      .map(({ id, name }) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    papers: paperGroups.map((group) => ({
      identityKey: group.identityKey,
      metadata: group.metadata,
      files: group.files,
      questionFiles: group.questionFiles,
      memoFiles: group.memoFiles,
      paperStatus: group.paperStatus,
      memoStatus: group.memoStatus,
      reviewReason: group.reviewReason,
      targetPaperId: group.targetPaperId,
      importFileIds: group.importFileIds,
    })),
  };
};

const requireAdminCaller = async (request) => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in as an administrator to manage the Drive import.');
  const profile = await getDb().collection('users').doc(request.auth.uid).get();
  if (!profile.exists || String(profile.get('role') ?? '').toLowerCase() !== 'admin') {
    throw new HttpsError('permission-denied', 'Only administrators can manage the Drive import.');
  }
  return request.auth.uid;
};

const createQuestionPaperIfAbsent = async ({ paperId, paperRecord }) => {
  const db = getDb();
  const reference = db.collection('questionPapers').doc(paperId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.exists) {
      const existing = { id: snapshot.id, ...snapshot.data() };
      return {
        created: false,
        sameDriveRecord: existing.source === 'google_drive' && existing.driveFileId === paperRecord.driveFileId,
        existing,
      };
    }
    transaction.create(reference, {
      ...paperRecord,
      createdAt: FieldValue.serverTimestamp(),
      analysisRequestedAt: FieldValue.serverTimestamp(),
    });
    return { created: true };
  });
};

const attachMemoIfMissing = async ({ paperId, memo, uploaded }) => {
  const db = getDb();
  const reference = db.collection('questionPapers').doc(paperId);
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (!snapshot.exists) return { attached: false, paper: null };
    const paper = { id: snapshot.id, ...snapshot.data() };
    if (paper.memoUrl) return { attached: false, paper };
    transaction.update(reference, {
      memoUrl: uploaded.url,
      memoFileName: memo.file.name,
      memoMimeType: 'application/pdf',
      memoSha256: memo.contentSha256,
      memoUpdatedAt: FieldValue.serverTimestamp(),
    });
    return { attached: true, paper: { ...paper, memoUrl: uploaded.url, memoSha256: memo.contentSha256 } };
  });
};

const acquireImportLease = async ({ requestedBy }) => {
  const db = getDb();
  const reference = db.doc(LOCK_DOCUMENT);
  const owner = randomUUID();
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const activeLease = snapshot.data();
    if (activeLease?.leaseUntil?.toMillis?.() > Date.now()) return { acquired: false };
    const leaseUntil = Timestamp.fromMillis(Date.now() + LOCK_DURATION_MS);
    transaction.set(reference, {
      owner,
      requestedBy,
      startedAt: FieldValue.serverTimestamp(),
      leaseUntil,
    });
    return { acquired: true, owner };
  });
};

const releaseImportLease = async (lease) => {
  if (!lease?.owner) return;
  const db = getDb();
  const reference = db.doc(LOCK_DOCUMENT);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.data()?.owner === lease.owner) transaction.delete(reference);
  });
};

const readTracking = async (driveFileId) => {
  const snapshot = await getDb().collection(TRACKING_COLLECTION).doc(driveFileId).get();
  return snapshot.exists ? snapshot.data() : null;
};

const writeTracking = async (driveFileId, fields) => {
  await getDb().collection(TRACKING_COLLECTION).doc(driveFileId).set(fields, { merge: true });
};

const runDrivePaperImport = createDrivePaperImportRunner({
  rootFolderId: process.env[GOOGLE_DRIVE_ROOT_ENV],
  acquireLease: acquireImportLease,
  releaseLease: releaseImportLease,
  listFiles: listConfiguredDriveTree,
  listFolderFiles: listSelectedFolderPdfs,
  readTracking,
  writeTracking,
  loadExistingPapers: loadExistingQuestionPapers,
  downloadFile: (file, maxBytes) => driveRequest(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(file.id)}?alt=media`,
    { download: true, maxBytes },
  ),
  downloadExisting: downloadExistingFirebaseFile,
  inspectExistingStorage: inspectExistingFirebaseStorage,
  inspectPdf: extractPdfTextSignals,
  uploadPdf: uploadDrivePdf,
  createPaperIfAbsent: createQuestionPaperIfAbsent,
  attachMemoIfMissing,
  logger,
  maxFileBytes: MAX_PDF_BYTES,
});

export const importGoogleDrivePastPapers = onSchedule({
  ...DRIVE_PAPER_IMPORT_SCHEDULE,
  timeoutSeconds: 540,
  memory: '1GiB',
}, async () => runDrivePaperImport({ requestedBy: 'schedule' }));

export const startGoogleDrivePastPaperImport = onCall({
  timeoutSeconds: 540,
  memory: '1GiB',
}, async (request) => {
  const uid = await requireAdminCaller(request);
  const folderId = String(request.data?.folderId ?? '').trim();
  const fileIds = request.data?.fileIds;
  if (!folderId || !Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 2) {
    throw new HttpsError('invalid-argument', 'Choose one paper or paper/memo pair from one folder before importing.');
  }
  try {
    await getFolderWithinConfiguredRoot(folderId);
    return await runDrivePaperImport({ requestedBy: `admin:${uid}`, folderId, fileIds });
  } catch (error) {
    const message = safeErrorSummary(error);
    logger.error('Manual Google Drive past-paper import failed', { uid, folderId, error: message });
    throw new HttpsError('internal', message);
  }
});

export const getGoogleDrivePastPaperFolderContents = onCall({ timeoutSeconds: 180 }, async (request) => {
  await requireAdminCaller(request);
  const folderId = String(request.data?.folderId ?? '').trim();
  try {
    return await getFolderPaperPreview(folderId);
  } catch (error) {
    const message = safeErrorSummary(error);
    logger.warn('Google Drive folder preview failed', { folderId: folderId || 'configured-root', error: message });
    throw new HttpsError('failed-precondition', message);
  }
});
