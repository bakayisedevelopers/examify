import { createHash } from 'node:crypto';
import { canonicalDrivePaperSubject, getDrivePaperSubjectCandidates } from './drivePaperSubjects.js';

export const DRIVE_PAPER_IMPORT_SCHEDULE = Object.freeze({
  schedule: '0 */2 * * *',
  timeZone: 'Africa/Johannesburg',
});

const normalizeWords = (value) => String(value ?? '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const unique = (values) => [...new Set(values.filter(Boolean))];
const filenameSegments = (fileName) => String(fileName ?? '')
  .replace(/\.pdf$/i, '')
  .split(/\s+(?:-|–|—)\s+|\s*\|\s*/)
  .map((item) => item.trim())
  .filter(Boolean);

const findTextMatches = (segment, patterns) => patterns
  .filter(({ pattern }) => pattern.test(normalizeWords(segment)))
  .map(({ value }) => value);

const PROVINCE_PATTERNS = [
  { value: 'Eastern Cape', pattern: /\b(?:eastern cape|ec)\b/ },
  { value: 'Free State', pattern: /\b(?:free state|fs)\b/ },
  { value: 'Gauteng', pattern: /\b(?:gauteng|gp)\b/ },
  { value: 'KwaZulu-Natal', pattern: /\b(?:kwazulu natal|kwa zulu natal|kzn)\b/ },
  { value: 'Limpopo', pattern: /\b(?:limpopo|lp)\b/ },
  { value: 'Mpumalanga', pattern: /\b(?:mpumalanga|mp)\b/ },
  { value: 'North West', pattern: /\b(?:north west|nw)\b/ },
  { value: 'Northern Cape', pattern: /\b(?:northern cape|nc)\b/ },
  { value: 'Western Cape', pattern: /\b(?:western cape|wc)\b/ },
  { value: 'National', pattern: /\bnational\b/ },
];

const MONTH_PATTERNS = [
  { value: 'January', pattern: /\b(?:january|jan)\b/ },
  { value: 'February', pattern: /\b(?:february|feb)\b/ },
  { value: 'March', pattern: /\b(?:march|mar)\b/ },
  { value: 'April', pattern: /\b(?:april|apr)\b/ },
  { value: 'May', pattern: /\bmay\b/ },
  { value: 'June', pattern: /\b(?:june|jun)\b/ },
  { value: 'July', pattern: /\b(?:july|jul)\b/ },
  { value: 'August', pattern: /\b(?:august|aug)\b/ },
  { value: 'September', pattern: /\b(?:september|sept|sep)\b/ },
  { value: 'October', pattern: /\b(?:october|oct)\b/ },
  { value: 'November', pattern: /\b(?:november|nov)\b/ },
  { value: 'December', pattern: /\b(?:december|dec)\b/ },
];

const LANGUAGE_PATTERNS = [
  { value: 'Afrikaans', pattern: /\b(?:afrikaans|afr)\b/ },
  { value: 'English', pattern: /\b(?:english|eng)\b/ },
  { value: 'isiNdebele', pattern: /\b(?:isindebele|ndebele)\b/ },
  { value: 'isiXhosa', pattern: /\b(?:isixhosa|xhosa)\b/ },
  { value: 'isiZulu', pattern: /\b(?:isizulu|zulu)\b/ },
  { value: 'Sepedi', pattern: /\b(?:sepedi|pedi)\b/ },
  { value: 'Sesotho', pattern: /\bsesotho\b/ },
  { value: 'Setswana', pattern: /\bsetswana\b/ },
  { value: 'siSwati', pattern: /\b(?:siswati|swati)\b/ },
  { value: 'Tshivenda', pattern: /\b(?:tshivenda|venda)\b/ },
  { value: 'itsonga', pattern: /\b(?:itsonga|tsonga)\b/ },
];

const SESSION_PATTERNS = [
  { value: 'Final', pattern: /\bfinal\b/ },
  { value: 'Preliminary', pattern: /\b(?:preliminary|prelim)\b/ },
  { value: 'Supplementary', pattern: /\b(?:supplementary|supp)\b/ },
  { value: 'Trial', pattern: /\btrial\b/ },
];

const parseFilenameField = ({ segments, index, parser, label, errors }) => {
  const segment = segments[index] ?? '';
  const matches = unique(parser(segment));
  if (matches.length > 1) {
    errors.push(`The ${label} is ambiguous in the filename.`);
    return '';
  }
  if (matches.length === 1) return matches[0];
  errors.push(segment
    ? `The ${label} is missing or invalid in its expected filename position.`
    : `The ${label} is missing from the filename.`);
  return '';
};

const parseSubject = (segment) => getDrivePaperSubjectCandidates(segment);

const parseYear = (segment) => {
  const normalized = normalizeWords(segment);
  return /^(?:19|20)\d{2}$/.test(normalized) ? [normalized] : [];
};
const parseGrade = (segment) => {
  const normalized = normalizeWords(segment);
  const gradeMatches = [...normalized.matchAll(/\b(?:grade|gr|g)\s*(4|5|6|7|8|9|10|11|12)\b/g)]
    .map((match) => `Grade ${match[1]}`);
  if (gradeMatches.length) return unique(gradeMatches);
  if (/^\s*(?:4|5|6|7|8|9|10|11|12)\s*$/.test(normalized)) return [`Grade ${normalized.trim()}`];
  return [];
};

const parsePaperNumber = (segment) => {
  const normalized = normalizeWords(segment);
  if (/\b(?:exemplar|examplar)\b/.test(normalized)) return ['Examplar'];
  return [...normalized.matchAll(/\b(?:paper|p)\s*([1-4])\b/g)]
    .map((match) => `Paper ${match[1]}`);
};

const documentTypeSignals = (segments) => {
  const text = normalizeWords(segments.join(' '));
  const memo = /\b(?:memo|memorandum|marking scheme|marking guideline|answer key)\b/.test(text);
  const questionPaper = /\b(?:question paper|questionpaper|qp)\b/.test(text);
  return { memo, questionPaper };
};

export const parseGoogleDrivePaperMetadata = ({ fileName } = {}) => {
  const nameSegments = filenameSegments(fileName);
  const errors = [];
  const subject = parseFilenameField({ segments: nameSegments, index: 0, parser: parseSubject, label: 'subject', errors });
  const grade = parseFilenameField({ segments: nameSegments, index: 1, parser: parseGrade, label: 'grade', errors });
  const region = parseFilenameField({
    segments: nameSegments,
    index: 2,
    parser: (segment) => findTextMatches(segment, PROVINCE_PATTERNS),
    label: 'province or National designation',
    errors,
  });
  const month = parseFilenameField({
    segments: nameSegments,
    index: 3,
    parser: (segment) => findTextMatches(segment, MONTH_PATTERNS),
    label: 'exam month after the province or National designation',
    errors,
  });
  const yearText = parseFilenameField({ segments: nameSegments, index: 4, parser: parseYear, label: 'year', errors });
  const paperNumber = parseFilenameField({
    segments: nameSegments,
    index: 5,
    parser: parsePaperNumber,
    label: 'paper number',
    errors,
  });

  const extraSegments = nameSegments.slice(6);
  const filenameType = documentTypeSignals(extraSegments);
  if (filenameType.memo && filenameType.questionPaper) {
    errors.push('The filename labels this PDF as both a question paper and a memo.');
  }
  const typeSegmentIndexes = extraSegments
    .map((segment, index) => ({ segment, index, signals: documentTypeSignals([segment]) }))
    .filter(({ signals }) => signals.memo || signals.questionPaper)
    .map(({ index }) => index);
  if (typeSegmentIndexes.length > 1) errors.push('The paper type is ambiguous in the filename.');
  if (typeSegmentIndexes.length === 1 && typeSegmentIndexes[0] !== extraSegments.length - 1) {
    errors.push('The paper type must be the final filename segment.');
  }

  const typeSegmentIndex = typeSegmentIndexes[0] ?? -1;
  const optionalSegments = extraSegments.filter((_, index) => index !== typeSegmentIndex);
  const languageValues = unique(optionalSegments.flatMap((segment) => findTextMatches(segment, LANGUAGE_PATTERNS)));
  const sessionValues = unique(optionalSegments.flatMap((segment) => findTextMatches(segment, SESSION_PATTERNS)));
  if (languageValues.length > 1) errors.push('The language is ambiguous in the filename.');
  if (sessionValues.length > 1) errors.push('The exam session is ambiguous in the filename.');
  const recognizedOptionalSegments = optionalSegments.filter((segment) => (
    findTextMatches(segment, LANGUAGE_PATTERNS).length > 0 || findTextMatches(segment, SESSION_PATTERNS).length > 0
  ));
  if (recognizedOptionalSegments.length !== optionalSegments.length) {
    errors.push('The filename contains an unexpected segment after the paper number.');
  }

  if (!month || /ambiguous/i.test(errors.find((error) => error.includes('exam month')) ?? '')) {
    errors.push('The exam month must appear in the filename between the province or National designation and the year; it is not inferred from Drive dates or folders.');
  }
  if (errors.length) return { ok: false, reason: unique(errors).join(' ') };

  return {
    ok: true,
    metadata: {
      subject,
      grade,
      region,
      year: Number(yearText),
      month,
      paperNumber,
      paperType: filenameType.memo ? 'memo' : 'question',
      ...(languageValues[0] ? { language: languageValues[0] } : {}),
      ...(sessionValues[0] ? { examSession: sessionValues[0] } : {}),
    },
  };
};

export const getDriveFileFingerprint = (file = {}) => JSON.stringify({
  modifiedTime: String(file.modifiedTime ?? ''),
  version: String(file.version ?? ''),
  size: String(file.size ?? ''),
  md5Checksum: String(file.md5Checksum ?? ''),
});

const canonicalSubject = (value) => canonicalDrivePaperSubject(value);

const canonicalRegion = (value) => {
  const normalized = normalizeWords(value);
  return findTextMatches(normalized, PROVINCE_PATTERNS)[0] ?? normalized;
};

const canonicalGrade = (value) => parseGrade(value)[0] ?? normalizeWords(value);
const canonicalPaperNumber = (value) => parsePaperNumber(value)[0] ?? normalizeWords(value);
const canonicalMonth = (value) => findTextMatches(value, MONTH_PATTERNS)[0] ?? normalizeWords(value);
const canonicalPaperType = (value) => /\b(?:memo|memorandum)\b/.test(normalizeWords(value)) ? 'memo' : 'question';

export const getExistingPaperMetadata = (paper = {}) => {
  const stored = paper.paperMetadata ?? {};
  return {
    subject: paper.subject ?? stored.subject ?? '',
    grade: paper.grade ?? stored.grade ?? '',
    region: paper.region ?? paper.province ?? stored.region ?? stored.province ?? '',
    year: paper.year ?? stored.year ?? '',
    month: paper.month ?? stored.month ?? '',
    paperNumber: paper.paperNumber ?? stored.paperNumber ?? '',
    language: paper.language ?? stored.language ?? '',
    examSession: paper.examSession ?? paper.session ?? stored.examSession ?? stored.session ?? '',
  };
};

export const comparePaperMetadata = (incoming = {}, existingPaper = {}) => {
  const existing = getExistingPaperMetadata(existingPaper);
  const canonicalizers = {
    subject: canonicalSubject,
    grade: canonicalGrade,
    region: canonicalRegion,
    year: (value) => String(Number(value) || ''),
    paperNumber: canonicalPaperNumber,
    month: canonicalMonth,
    language: normalizeWords,
    examSession: normalizeWords,
  };
  const uncertainFields = [];

  for (const field of ['subject', 'grade', 'region', 'month', 'year', 'paperNumber']) {
    if (!incoming[field] || !existing[field]) uncertainFields.push(field);
    else if (field === 'subject') {
      const incomingSubjects = getDrivePaperSubjectCandidates(incoming.subject);
      const existingSubjects = getDrivePaperSubjectCandidates(existing.subject);
      if (incomingSubjects.length > 1 || existingSubjects.length > 1) uncertainFields.push(field);
      else if (canonicalizers.subject(incoming.subject) !== canonicalizers.subject(existing.subject)) {
        return { status: 'different', field };
      }
    } else if (canonicalizers[field](incoming[field]) !== canonicalizers[field](existing[field])) {
      return { status: 'different', field };
    }
  }

  for (const field of ['language', 'examSession']) {
    const incomingValue = String(incoming[field] ?? '').trim();
    const existingValue = String(existing[field] ?? '').trim();
    if (incomingValue && existingValue && canonicalizers[field](incomingValue) !== canonicalizers[field](existingValue)) {
      return { status: 'different', field };
    }
    if (Boolean(incomingValue) !== Boolean(existingValue)) uncertainFields.push(field);
  }

  return uncertainFields.length
    ? { status: 'uncertain', fields: uncertainFields }
    : { status: 'match' };
};

export const paperIdentityKey = (metadata = {}) => [
  canonicalSubject(metadata.subject),
  canonicalGrade(metadata.grade),
  canonicalRegion(metadata.region),
  String(Number(metadata.year) || ''),
  canonicalPaperNumber(metadata.paperNumber),
  canonicalMonth(metadata.month),
  normalizeWords(metadata.language),
  normalizeWords(metadata.examSession),
].join('|');

// Firestore stores question papers and memos on separate file fields of one
// questionPapers record. Use this key when comparing a particular stored file.
export const paperFileIdentityKey = (metadata = {}) => [
  paperIdentityKey(metadata),
  canonicalPaperType(metadata.paperType),
].join('|');

export const summarizeDriveFolderPapers = ({ files = [], trackingByFileId = {}, existingPapers = [] } = {}) => {
  const groups = new Map();
  for (const file of files) {
    if (!isPdfDriveFile(file)) continue;
    const parsed = parseGoogleDrivePaperMetadata({ fileName: file.name, folderPath: file.folderPath });
    if (!parsed.ok) {
      groups.set(`review:${file.id}`, {
        identityKey: `review:${file.id}`,
        metadata: null,
        files: [{ id: file.id, name: file.name, importStatus: trackingByFileId[file.id]?.importStatus ?? '' }],
        questionFiles: [],
        memoFiles: [],
        paperStatus: 'review',
        memoStatus: 'review',
        reviewReason: parsed.reason,
        targetPaperId: '',
        importFileIds: [],
      });
      continue;
    }
    const identityKey = paperIdentityKey(parsed.metadata);
    const group = groups.get(identityKey) ?? {
      identityKey,
      metadata: parsed.metadata,
      files: [],
      questionFiles: [],
      memoFiles: [],
      reviewReason: '',
      targetPaperId: '',
    };
    const tracking = trackingByFileId[file.id] ?? {};
    const driveFile = {
      id: file.id,
      name: file.name,
      importStatus: tracking.importStatus ?? '',
      importStage: tracking.importStage ?? '',
      updatedAt: tracking.updatedAt ?? null,
      errorSummary: tracking.errorSummary ?? '',
    };
    group.files.push(driveFile);
    (parsed.metadata.paperType === 'memo' ? group.memoFiles : group.questionFiles).push(driveFile);
    if (tracking.importStatus === 'review') group.reviewReason ||= tracking.reviewReason || tracking.errorSummary || 'This Drive file needs manual review.';
    groups.set(identityKey, group);
  }

  return [...groups.values()].map((group) => {
    if (!group.metadata) return group;
    const matches = matchingRecordsFor(group.metadata, existingPapers);
    const exactMatches = matches.filter(({ comparison }) => comparison.status === 'match');
    const uncertainMatches = matches.filter(({ comparison }) => comparison.status === 'uncertain');
    const duplicateDriveItems = group.questionFiles.length > 1 || group.memoFiles.length > 1;
    const uncertainRecord = exactMatches.length > 1 || uncertainMatches.length > 0;
    const existingPaper = exactMatches.length === 1 && !uncertainRecord ? exactMatches[0].paper : null;
    if (uncertainRecord) group.reviewReason ||= 'Existing paper metadata is incomplete or has more than one possible match.';
    if (duplicateDriveItems) group.reviewReason ||= 'This folder contains multiple files of the same type with the same paper metadata.';
    if (existingPaper && !existingPaper.paperUrl) group.reviewReason ||= 'The matching Firestore paper record has no question-paper file URL.';

    group.targetPaperId = existingPaper?.id ?? '';
    const questionImporting = group.questionFiles.some((file) => isDrivePaperImportActive(file));
    const memoImporting = group.memoFiles.some((file) => isDrivePaperImportActive(file));
    const questionImportStalled = group.questionFiles.some((file) => activeImportStatuses.has(file.importStatus) && !isDrivePaperImportActive(file));
    const memoImportStalled = group.memoFiles.some((file) => activeImportStatuses.has(file.importStatus) && !isDrivePaperImportActive(file));
    const questionImportFailed = group.questionFiles.some((file) => file.importStatus === 'failed');
    const memoImportFailed = group.memoFiles.some((file) => file.importStatus === 'failed');
    const analysisState = existingPaper?.analysisStatus === 'Analyzing'
      ? 'analyzing'
      : existingPaper?.analysisStatus === 'Analyzed'
        ? 'analyzed'
        : ['Failed', 'Cancelled'].includes(existingPaper?.analysisStatus)
          ? 'analysis-failed'
          : '';
    group.paperStatus = group.reviewReason
      ? 'review'
      : questionImporting
        ? 'importing'
      : questionImportStalled
        ? 'stalled'
      : questionImportFailed
        ? 'import-failed'
      : existingPaper
        ? (existingPaper.paperUrl ? (analysisState || 'uploaded') : 'review')
        : (group.questionFiles.length ? 'missing' : 'missing');
    group.memoStatus = group.reviewReason
      ? 'review'
      : memoImporting
        ? 'importing'
      : memoImportStalled
        ? 'stalled'
      : memoImportFailed
        ? 'import-failed'
      : existingPaper?.memoUrl
        ? 'uploaded'
        : group.memoFiles.length
          ? (existingPaper || group.questionFiles.length ? 'missing' : 'waiting')
          : 'no-file';

    const importedWithoutPaperRecord = [...group.questionFiles, ...group.memoFiles]
      .some((file) => ['imported', 'duplicate'].includes(file.importStatus)) && !existingPaper;
    if (importedWithoutPaperRecord) {
      group.reviewReason ||= 'A prior import is tracked but its target paper record is unavailable.';
      group.paperStatus = 'review';
      group.memoStatus = group.memoFiles.length ? 'review' : group.memoStatus;
    }

    const importableQuestion = group.questionFiles.length === 1
      && !isDrivePaperImportActive(group.questionFiles[0])
      && group.questionFiles[0].importStatus !== 'review'
      && ['missing', 'stalled', 'import-failed'].includes(group.paperStatus);
    const importableMemo = group.memoFiles.length === 1
      && !isDrivePaperImportActive(group.memoFiles[0])
      && group.memoFiles[0].importStatus !== 'review'
      && ['missing', 'stalled', 'import-failed'].includes(group.memoStatus);
    group.importFileIds = !group.reviewReason && (existingPaper || importableQuestion)
      ? [
        ...(importableQuestion ? [group.questionFiles[0].id] : []),
        ...(importableMemo ? [group.memoFiles[0].id] : []),
      ]
      : [];
    return group;
  });
};

export const safeErrorSummary = (error) => String(error?.message ?? error ?? 'Unknown import error')
  .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
  .replace(/(access_token\s*[=:]\s*)[^&\s,;]+/gi, '$1[redacted]')
  .replace(/(token=)[^&\s,;]+/gi, '$1[redacted]')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 500);

export const sha256Buffer = (buffer) => createHash('sha256').update(buffer).digest('hex');

export const destroyPdfLoadingTaskSafely = async (loadingTask) => {
  if (typeof loadingTask?.destroy !== 'function') return;
  try {
    await loadingTask.destroy();
  } catch {
    // Cleanup failures should not turn a successfully inspected PDF into an import failure.
  }
};

export const listDrivePdfsRecursively = async ({ root, listFolderPage } = {}) => {
  const results = [];
  const folders = [{ id: root.id, path: [root.name] }];
  const visitedFolderIds = new Set([root.id]);

  for (let index = 0; index < folders.length; index += 1) {
    const folder = folders[index];
    let pageToken;
    do {
      const page = await listFolderPage(folder.id, pageToken);
      for (const file of page.files ?? []) {
        if (file.trashed) continue;
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          if (file.id && !visitedFolderIds.has(file.id)) {
            visitedFolderIds.add(file.id);
            folders.push({ id: file.id, path: [...folder.path, file.name] });
          }
        } else if (file.mimeType === 'application/pdf' || String(file.name ?? '').toLowerCase().endsWith('.pdf')) {
          results.push({ ...file, folderPath: folder.path });
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  return results;
};
export const isPdfBuffer = (buffer) => Buffer.isBuffer(buffer)
  && buffer.length >= 5
  && buffer.subarray(0, 5).toString('ascii') === '%PDF-';

const isPdfDriveFile = (file = {}) => String(file.mimeType ?? '').toLowerCase() === 'application/pdf'
  || String(file.name ?? '').toLowerCase().endsWith('.pdf');
const terminalStatuses = new Set(['imported', 'duplicate', 'review']);
const activeImportStatuses = new Set(['importing', 'processing']);
const importingStatusStaleAfterMs = 10 * 60 * 1000;
const getDrivePaperId = (driveFileId) => `google-drive-${createHash('sha256').update(String(driveFileId)).digest('hex').slice(0, 32)}`;
const fileHash = (item) => item.contentSha256 ?? '';

const timestampMillis = (value) => value?.toMillis?.()
  ?? value?.toDate?.()?.getTime?.()
  ?? (value instanceof Date ? value.getTime() : Number.isFinite(Number(value)) ? Number(value) : Date.parse(String(value ?? '')));

export const isDrivePaperImportActive = (tracking, now = new Date()) => {
  if (!activeImportStatuses.has(String(tracking?.importStatus ?? ''))) return false;
  const updatedAt = timestampMillis(tracking?.updatedAt ?? tracking?.importStartedAt);
  const nowMillis = timestampMillis(now);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(nowMillis)) return false;
  const age = nowMillis - updatedAt;
  return age >= 0 && age < importingStatusStaleAfterMs;
};

const trackingFieldsFor = (item, now) => ({
  driveFileId: item.file.id,
  sourceFilename: item.file.name ?? '',
  modifiedTime: item.file.modifiedTime ?? null,
  revision: item.file.version ?? null,
  size: item.file.size ?? null,
  checksum: item.file.md5Checksum ?? null,
  driveFingerprint: item.fingerprint,
  parsedMetadata: item.metadata ?? null,
  lastSeenAt: now(),
});

const matchingRecordsFor = (metadata, papers) => papers
  .map((paper) => ({ paper, comparison: comparePaperMetadata(metadata, paper) }))
  .filter(({ comparison }) => comparison.status !== 'different');

const normalizePaperFileType = (value) => {
  const normalized = normalizeWords(value);
  if (/^(?:memo|memorandum)$/.test(normalized)) return 'memo';
  if (/^(?:question|question paper|paper)$/.test(normalized)) return 'question';
  return '';
};

const inferPaperFileTypeFromStoragePath = (objectPath = '') => {
  const segments = String(objectPath).split('/');
  if (segments[0] !== 'questionPapers') return '';
  return normalizePaperFileType(segments[2]);
};

const compareStoredFile = async ({ item, paper, paperType, inspectExistingStorage, downloadExisting }) => {
  if (paperFileIdentityKey(item.metadata) !== paperFileIdentityKey({
    ...getExistingPaperMetadata(paper),
    paperType,
  })) {
    return { status: 'different', reason: 'The stored file does not match the complete paper identity, including document type.' };
  }
  const isMemo = paperType === 'memo';
  const kind = isMemo ? 'memo' : 'question paper';
  const url = isMemo ? paper.memoUrl : paper.paperUrl;
  if (!url) return { status: 'missing', reason: `The matching Firebase record has no ${kind} file.` };
  const storedHash = isMemo
    ? (paper.memoSha256 ?? paper.driveImport?.memoSha256)
    : (paper.paperSha256 ?? paper.driveImport?.paperSha256);
  try {
    const storageFile = await inspectExistingStorage(url);
    const storageFileType = normalizePaperFileType(storageFile?.metadata?.fileType)
      || inferPaperFileTypeFromStoragePath(storageFile?.objectPath);
    if (storageFileType && storageFileType !== paperType) {
      return { status: 'different', reason: `The existing ${kind} URL points to a ${storageFileType} Storage object.` };
    }
    const storageHash = String(storageFile?.metadata?.contentSha256 ?? '').trim();
    if (storedHash && storageHash && storedHash !== storageHash) {
      return { status: 'uncertain', reason: `Firestore and Firebase Storage hashes disagree for the existing ${kind}.` };
    }
    const digest = storageHash || storedHash || sha256Buffer(await downloadExisting(url));
    return digest === fileHash(item) ? { status: 'same' } : { status: 'different' };
  } catch {
    return { status: 'uncertain', reason: `The existing ${kind} could not be downloaded for a safe comparison.` };
  }
};

const displayNameFor = (metadata) => [metadata.subject, metadata.grade, metadata.region, metadata.month, metadata.year, metadata.paperNumber]
  .filter(Boolean)
  .join(' • ');

const createStatusWriter = ({ writeTracking, now }) => async (item, importStatus, patch = {}) => {
  const fields = {
    ...trackingFieldsFor(item, now),
    importStatus,
    ...(importStatus === 'importing' ? {} : { importStage: '' }),
    ...patch,
    updatedAt: now(),
  };
  await writeTracking(item.file.id, fields);
  item.tracking = { ...item.tracking, ...fields };
  item.status = importStatus;
};

/**
 * A dependency-injected runner keeps Drive, Storage, and Firestore effects
 * testable. Memo files are processed after question papers so they can attach
 * to an existing front-end paper or one created earlier in the same scan.
 */
export const createDrivePaperImportRunner = (dependencies) => {
  const {
    rootFolderId,
    acquireLease,
    releaseLease,
    listFiles,
    listFolderFiles = listFiles,
    readTracking,
    writeTracking,
    loadExistingPapers,
    downloadFile,
    downloadExisting,
    inspectExistingStorage = async () => null,
    inspectPdf,
    uploadPdf,
    createPaperIfAbsent,
    attachMemoIfMissing,
    now = () => new Date(),
    logger = { info() {}, warn() {}, error() {} },
    maxFileBytes = 50 * 1024 * 1024,
  } = dependencies ?? {};

  const run = async ({ requestedBy = 'schedule', folderId = '', fileIds = [] } = {}) => {
    if (!String(rootFolderId ?? '').trim()) {
      throw new Error('Google Drive past-paper import is not configured: set GOOGLE_DRIVE_PAPERS_ROOT_ID to one specific folder ID.');
    }

    const lease = await acquireLease({ requestedBy, now: now() });
    if (!lease?.acquired) return { skipped: true, reason: 'already_running' };

    const summary = {
      skipped: false,
      discoveredPdfFiles: 0,
      importedFiles: 0,
      duplicateFiles: 0,
      reviewFiles: 0,
      waitingFiles: 0,
      failedFiles: 0,
      skippedFiles: 0,
    };
    const writeStatus = createStatusWriter({ writeTracking, now });

    const markReview = async (item, reason) => {
      await writeStatus(item, 'review', { reviewReason: reason, errorSummary: reason });
      summary.reviewFiles += 1;
    };

    try {
      let files;
      if (folderId || fileIds.length) {
        if (!folderId || !Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 2) {
          throw new Error('A manual Drive import must specify one folder and one question paper or paper/memo pair.');
        }
        const directFiles = await listFolderFiles(folderId);
        const directFileIds = new Set(directFiles.map((file) => file.id));
        const selectedFileIds = [...new Set(fileIds.map((fileId) => String(fileId)))];
        if (selectedFileIds.length !== fileIds.length || selectedFileIds.some((fileId) => !directFileIds.has(fileId))) {
          throw new Error('The selected Drive file is no longer a PDF directly inside the selected folder. Refresh the folder and try again.');
        }
        const directFilesById = new Map(directFiles.map((file) => [file.id, file]));
        files = selectedFileIds.map((fileId) => directFilesById.get(fileId));
      } else {
        files = await listFiles(rootFolderId);
      }
      const candidates = [];

      for (const file of files) {
        if (!isPdfDriveFile(file)) continue;
        summary.discoveredPdfFiles += 1;

        let tracking;
        try {
          tracking = await readTracking(file.id);
        } catch (error) {
          summary.failedFiles += 1;
          logger.warn('Drive paper tracking read failed', { driveFileId: file.id, error: safeErrorSummary(error) });
          continue;
        }

        const item = {
          file,
          fingerprint: getDriveFileFingerprint(file),
          tracking: tracking ?? {},
          metadata: null,
          contentSha256: '',
          buffer: null,
          status: tracking?.importStatus ?? '',
          attemptCount: Number(tracking?.retryCount ?? 0) + 1,
        };

        if (tracking?.driveFingerprint && tracking.driveFingerprint !== item.fingerprint) {
          await markReview(item, 'This Drive file changed after it was seen. The stored Firebase paper was left untouched; review the new Drive revision manually.');
          continue;
        }
        if (tracking && tracking.driveFingerprint === item.fingerprint && terminalStatuses.has(tracking.importStatus)) {
          summary.skippedFiles += 1;
          continue;
        }
        if (isDrivePaperImportActive(tracking, now())) {
          summary.skippedFiles += 1;
          logger.info('Drive file already has an active import status; skipping this attempt', {
            driveFileId: file.id,
            importStage: tracking?.importStage ?? '',
          });
          continue;
        }

        const parsed = parseGoogleDrivePaperMetadata({ fileName: file.name, folderPath: file.folderPath });
        if (!parsed.ok) {
          item.metadata = null;
          await writeStatus(item, 'review', {
            retryCount: Number(tracking?.retryCount ?? 0),
            reviewReason: parsed.reason,
            errorSummary: parsed.reason,
          });
          summary.reviewFiles += 1;
          logger.warn('Drive paper filename could not be parsed; file needs review', {
            driveFileId: file.id,
            filename: file.name,
            error: parsed.reason,
          });
          continue;
        }
        item.metadata = parsed.metadata;

        try {
          const declaredSize = Number(file.size ?? 0);
          if (declaredSize > maxFileBytes) {
            await markReview(item, `The PDF exceeds the ${Math.round(maxFileBytes / 1024 / 1024)} MiB import limit.`);
            continue;
          }

          await writeStatus(item, 'importing', {
            importStage: 'downloading',
            importStartedAt: now(),
            retryCount: item.attemptCount,
            errorSummary: '',
            reviewReason: '',
          });
          item.buffer = await downloadFile(file, maxFileBytes);
          await writeStatus(item, 'importing', { importStage: 'validating' });
          if (!isPdfBuffer(item.buffer)) {
            await markReview(item, 'The downloaded file does not have a valid PDF signature.');
            continue;
          }
          if (item.buffer.length > maxFileBytes) {
            await markReview(item, `The PDF exceeds the ${Math.round(maxFileBytes / 1024 / 1024)} MiB import limit.`);
            continue;
          }
          item.contentSha256 = sha256Buffer(item.buffer);
          const pdfCheck = await inspectPdf(item.buffer, item.metadata);
          if (pdfCheck?.combinedPaperAndMemo || pdfCheck?.uncertainCombinedDocument) {
            await writeStatus(item, 'review', {
              contentSha256: item.contentSha256,
              retryCount: item.attemptCount,
              reviewReason: pdfCheck.reason || 'This PDF may contain both a question paper and memo. No safe split is available, so review it manually.',
              errorSummary: pdfCheck.reason || 'The PDF may combine a question paper and memo.',
            });
            summary.reviewFiles += 1;
            continue;
          }
          await writeStatus(item, 'importing', {
            importStage: 'checking_existing_records',
            contentSha256: item.contentSha256,
          });
          candidates.push(item);
        } catch (error) {
          const reason = safeErrorSummary(error);
          await writeStatus(item, 'failed', { retryCount: item.attemptCount, errorSummary: reason });
          summary.failedFiles += 1;
          logger.warn('Drive paper could not be downloaded or inspected', { driveFileId: file.id, error: reason });
        }
      }

      if (!candidates.length) return summary;
      const existingPapers = await loadExistingPapers();
      candidates.sort((left, right) => (left.metadata.paperType === 'memo' ? 1 : 0) - (right.metadata.paperType === 'memo' ? 1 : 0));

      for (const item of candidates) {
        try {
          const possibleMatches = matchingRecordsFor(item.metadata, existingPapers);
          const exactMatches = possibleMatches.filter(({ comparison }) => comparison.status === 'match');
          const uncertainMatches = possibleMatches.filter(({ comparison }) => comparison.status === 'uncertain');

          if (exactMatches.length > 1 || (!exactMatches.length && uncertainMatches.length) || (exactMatches.length && uncertainMatches.length)) {
            const reason = exactMatches.length > 1
              ? 'More than one existing paper has this metadata, so the importer cannot select a safe record.'
              : 'An existing paper may match, but its optional metadata is incomplete or conflicts; manual review is required.';
            await markReview(item, reason);
            continue;
          }

          const existingPaper = exactMatches[0]?.paper;
          if (item.metadata.paperType === 'memo') {
            if (!existingPaper) {
              const reason = 'Waiting for a matching question-paper record before attaching this memo.';
              await writeStatus(item, 'waiting', {
                waitingReason: reason,
                errorSummary: reason,
                retryCount: item.attemptCount,
              });
              summary.waitingFiles += 1;
              continue;
            }
            if (existingPaper.memoUrl) {
              const comparison = await compareStoredFile({ item, paper: existingPaper, paperType: 'memo', inspectExistingStorage, downloadExisting });
              if (comparison.status === 'same') {
                await writeStatus(item, 'duplicate', {
                  targetPaperId: existingPaper.id,
                  duplicateTargetPaperId: existingPaper.id,
                  errorSummary: '',
                });
                summary.duplicateFiles += 1;
              } else {
                await markReview(item, comparison.status === 'different'
                  ? 'A memo is already stored for this question paper, but its contents differ from the Drive PDF.'
                  : comparison.reason || 'The existing memo could not be confidently compared with this Drive PDF.');
              }
              continue;
            }

            await writeStatus(item, 'importing', { importStage: 'uploading_memo' });
            const uploaded = await uploadPdf({ file: item.file, buffer: item.buffer, fileType: 'memo', contentSha256: item.contentSha256 });
            await writeStatus(item, 'importing', { importStage: 'saving_memo_reference' });
            const attached = await attachMemoIfMissing({ paperId: existingPaper.id, memo: item, uploaded });
            if (attached?.attached) {
              existingPaper.memoUrl = uploaded.url;
              existingPaper.memoFileName = item.file.name;
              existingPaper.memoSha256 = item.contentSha256;
              await writeStatus(item, 'imported', {
                targetPaperId: existingPaper.id,
                storagePath: uploaded.path,
                contentSha256: item.contentSha256,
                errorSummary: '',
              });
              summary.importedFiles += 1;
            } else if (attached?.paper) {
              const comparison = await compareStoredFile({ item, paper: attached.paper, paperType: 'memo', inspectExistingStorage, downloadExisting });
              if (comparison.status === 'same') {
                await writeStatus(item, 'duplicate', {
                  targetPaperId: attached.paper.id,
                  duplicateTargetPaperId: attached.paper.id,
                  errorSummary: '',
                });
                summary.duplicateFiles += 1;
              } else {
                await markReview(item, 'A memo was added concurrently with this import and does not match the Drive PDF. The existing record was left unchanged.');
              }
            } else {
              await markReview(item, 'The memo could not be attached because the question-paper record changed during import.');
            }
            continue;
          }

          if (existingPaper) {
            const comparison = await compareStoredFile({ item, paper: existingPaper, paperType: 'question', inspectExistingStorage, downloadExisting });
            if (comparison.status === 'same') {
              const alreadyDriveRecord = existingPaper.source === 'google_drive'
                && (existingPaper.driveFileId === item.file.id || existingPaper.driveImport?.paperDriveFileId === item.file.id);
              await writeStatus(item, alreadyDriveRecord ? 'imported' : 'duplicate', {
                targetPaperId: existingPaper.id,
                ...(alreadyDriveRecord ? {} : { duplicateTargetPaperId: existingPaper.id }),
                errorSummary: '',
              });
              summary[alreadyDriveRecord ? 'importedFiles' : 'duplicateFiles'] += 1;
            } else {
              await markReview(item, comparison.status === 'different'
                ? 'Paper metadata matches an existing record, but the PDF contents differ. The existing record was left unchanged.'
                : comparison.reason || 'A paper may match an existing record, but the files could not be confidently compared.');
            }
            continue;
          }

          await writeStatus(item, 'importing', { importStage: 'uploading_question_paper' });
          const uploaded = await uploadPdf({ file: item.file, buffer: item.buffer, fileType: 'question', contentSha256: item.contentSha256 });
          await writeStatus(item, 'importing', { importStage: 'saving_paper_record' });
          const metadata = item.metadata;
          const displayName = displayNameFor(metadata);
          const paperId = getDrivePaperId(item.file.id);
          const paperRecord = {
            subject: metadata.subject,
            grade: metadata.grade,
            region: metadata.region,
            year: metadata.year,
            month: metadata.month,
            paperNumber: metadata.paperNumber,
            ...(metadata.language ? { language: metadata.language } : {}),
            ...(metadata.examSession ? { examSession: metadata.examSession } : {}),
            paperUrl: uploaded.url,
            memoUrl: '',
            paperFileName: item.file.name,
            memoFileName: '',
            paperMimeType: 'application/pdf',
            memoMimeType: '',
            paperSha256: item.contentSha256,
            memoSha256: '',
            displayName,
            paperTitle: displayName,
            copyNumber: 0,
            copySuffix: '',
            analysisStatus: 'Analyzing',
            analysisRequestedAt: now(),
            analysisProgressMessage: 'Queued for analysis',
            analysisProgressCurrent: 0,
            analysisProgressTotal: 1,
            availableForGeneration: false,
            source: 'google_drive',
            driveFileId: item.file.id,
            driveModifiedTime: item.file.modifiedTime ?? null,
            driveRevision: item.file.version ?? null,
            driveMd5Checksum: item.file.md5Checksum ?? '',
            driveImport: {
              source: 'google_drive',
              paperDriveFileId: item.file.id,
              paperSha256: item.contentSha256,
              importedAt: now(),
            },
            createdBy: 'google-drive-importer',
            createdAt: now(),
          };
          const created = await createPaperIfAbsent({ paperId, paperRecord });
          if (!created?.created) {
            const reason = created?.sameDriveRecord
              ? 'This Drive file already has a paper record, but its stored contents could not be confirmed.'
              : 'A paper record appeared during import. The existing record was left unchanged for review.';
            await markReview(item, reason);
            continue;
          }

          const savedPaper = { id: paperId, ...paperRecord };
          existingPapers.push(savedPaper);
          await writeStatus(item, 'imported', {
            targetPaperId: paperId,
            storagePath: uploaded.path,
            contentSha256: item.contentSha256,
            errorSummary: '',
          });
          summary.importedFiles += 1;
          logger.info('Drive question paper imported and analysis trigger activated', { driveFileId: item.file.id, paperId });
        } catch (error) {
          const reason = safeErrorSummary(error);
          await writeStatus(item, 'failed', {
            retryCount: item.attemptCount,
            errorSummary: reason,
            ...(item.contentSha256 ? { contentSha256: item.contentSha256 } : {}),
          });
          summary.failedFiles += 1;
          logger.warn('Drive paper file import failed', { driveFileId: item.file.id, error: reason });
        }
      }

      return summary;
    } finally {
      await releaseLease(lease);
      logger.info('Google Drive past-paper scan finished', { requestedBy, ...summary });
    }
  };

  return run;
};
