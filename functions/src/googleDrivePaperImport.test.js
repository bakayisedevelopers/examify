import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  comparePaperMetadata,
  createDrivePaperImportRunner,
  DRIVE_PAPER_IMPORT_SCHEDULE,
  parseGoogleDrivePaperMetadata,
  paperFileIdentityKey,
  paperIdentityKey,
  sha256Buffer,
  summarizeDriveFolderPapers,
} from './googleDrivePaperImportCore.js';
import { PAPER_MONTHS } from '../../src/lib/constants.js';
import { detectUploaderPaperMonth } from '../../src/utils/paperMonth.js';

const pdfBuffer = Buffer.from('%PDF-1.7\nfixture pdf bytes');
const paperFile = (id = 'drive-paper-1', name = 'Mathematics - Grade 12 - National - November - 2024 - Paper 1.pdf') => ({
  id,
  name,
  mimeType: 'application/pdf',
  modifiedTime: '2025-01-01T00:00:00.000Z',
  version: '1',
  size: String(pdfBuffer.length),
  md5Checksum: `md5-${id}`,
  folderPath: ['Past Papers'],
});

const createHarness = ({
  files = [paperFile()],
  existingPapers = [],
  inspectPdf = async () => ({}),
  downloadFile = async () => pdfBuffer,
  downloadExisting = async () => pdfBuffer,
  inspectExistingStorage = async () => null,
} = {}) => {
  const tracking = new Map();
  const calls = { upload: [], create: [], attachMemo: [], logs: [] };
  const runner = createDrivePaperImportRunner({
    rootFolderId: 'configured-past-papers-folder',
    acquireLease: async () => ({ acquired: true, owner: 'lease-test' }),
    releaseLease: async () => {},
    listFiles: async () => files,
    readTracking: async (id) => tracking.get(id) ?? null,
    writeTracking: async (id, fields) => tracking.set(id, { ...(tracking.get(id) ?? {}), ...fields }),
    loadExistingPapers: async () => existingPapers,
    downloadFile,
    downloadExisting,
    inspectExistingStorage,
    inspectPdf,
    uploadPdf: async ({ file, fileType, contentSha256 }) => {
      calls.upload.push({ driveFileId: file.id, fileType, contentSha256 });
      return { path: `questionPapers/google-drive/${fileType}/${file.id}.pdf`, url: `https://storage.example/${fileType}/${file.id}` };
    },
    createPaperIfAbsent: async ({ paperId, paperRecord }) => {
      calls.create.push({ paperId, paperRecord });
      return { created: true };
    },
    attachMemoIfMissing: async ({ paperId, memo, uploaded }) => {
      calls.attachMemo.push({ paperId, driveFileId: memo.file.id, uploaded });
      return { attached: true };
    },
    logger: {
      info: (...args) => calls.logs.push(args),
      warn: (...args) => calls.logs.push(args),
      error: (...args) => calls.logs.push(args),
    },
  });
  return { runner, tracking, calls };
};

test('parses question-paper and memo names with the exam month in the filename', () => {
  const question = parseGoogleDrivePaperMetadata({
    fileName: 'Mathematics - Grade 8 - Gauteng - November - 2020 - Paper 1.pdf',
  });
  const memo = parseGoogleDrivePaperMetadata({
    fileName: 'Maths - Grade 8 - GP - Nov - 2020 - Paper 1 - Memo.pdf',
  });

  assert.equal(question.ok, true);
  assert.deepEqual(question.metadata, {
    subject: 'Mathematics',
    grade: 'Grade 8',
    region: 'Gauteng',
    month: 'November',
    year: 2020,
    paperNumber: 'Paper 1',
    paperType: 'question',
  });
  assert.equal(memo.ok, true);
  assert.deepEqual(memo.metadata, question.metadata && {
    ...question.metadata,
    paperType: 'memo',
  });
});

test('accepts and normalizes all valid calendar months, including November', () => {
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  monthNames.forEach((month) => {
    const parsed = parseGoogleDrivePaperMetadata({
      fileName: `Mathematics - Grade 8 - National - ${month} - 2020 - Paper 1.pdf`,
    });
    assert.equal(parsed.ok, true, `${month} should parse`);
    assert.equal(parsed.metadata.month, month);
  });
  assert.equal(parseGoogleDrivePaperMetadata({
    fileName: 'Mathematics - Grade 8 - National - Nov - 2020 - Paper 1.pdf',
  }).metadata.month, 'November');
});

test('missing, misplaced, malformed, or ambiguous months are review cases and never use folder names', () => {
  const cases = [
    {
      fileName: 'Mathematics - Grade 8 - Gauteng - 2020 - Paper 1.pdf',
      folderPath: ['Past Papers', 'November'],
    },
    { fileName: 'Mathematics - Grade 8 - Gauteng - Noveber - 2020 - Paper 1.pdf' },
    { fileName: 'Mathematics - Grade 8 - Gauteng - November December - 2020 - Paper 1.pdf' },
    { fileName: 'Mathematics - Grade 8 - Gauteng - 2020 - November - Paper 1.pdf' },
  ];

  cases.forEach(({ fileName, folderPath }) => {
    const parsed = parseGoogleDrivePaperMetadata({ fileName, folderPath });
    assert.equal(parsed.ok, false, fileName);
    assert.match(parsed.reason, /exam month/i);
  });
});

test('file identity includes paper versus memo while the shared paper identity pairs them', () => {
  const question = {
    subject: 'Mathematics', grade: 'Grade 8', region: 'Gauteng', month: 'November', year: 2020,
    paperNumber: 'Paper 1', paperType: 'question',
  };
  const memo = { ...question, paperType: 'memo' };

  assert.equal(paperIdentityKey(question), paperIdentityKey(memo));
  assert.notEqual(paperFileIdentityKey(question), paperFileIdentityKey(memo));
});

test('a missing filename month is logged and skipped for review without uploading', async () => {
  const file = paperFile('drive-no-month', 'Mathematics - Grade 12 - National - 2024 - Paper 1.pdf');
  const { runner, calls, tracking } = createHarness({ files: [file] });
  const result = await runner();

  assert.equal(result.reviewFiles, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(tracking.get(file.id).importStatus, 'review');
  assert.match(tracking.get(file.id).reviewReason, /exam month/i);
  assert.ok(calls.logs.some(([message, details]) => (
    message.includes('filename could not be parsed') && /exam month/i.test(details?.error ?? '')
  )));
});

test('a new PDF is stored and creates one paper record that activates the existing analysis trigger', async () => {
  const { runner, calls, tracking } = createHarness();
  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].paperRecord.source, 'google_drive');
  assert.equal(calls.create[0].paperRecord.driveFileId, 'drive-paper-1');
  assert.equal(calls.create[0].paperRecord.analysisStatus, 'Analyzing');
  assert.equal(calls.create[0].paperRecord.month, 'November');
  assert.equal(tracking.get('drive-paper-1').importStatus, 'imported');
});

test('a later run skips the same imported Drive file without a second upload or analysis handoff', async () => {
  const { runner, calls } = createHarness();
  await runner();
  const secondRun = await runner();

  assert.equal(secondRun.skippedFiles, 1);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.create.length, 1);
});

test('a matching front-end paper is recorded as a duplicate without upload or relabeling', async () => {
  const existing = {
    id: 'frontend-paper-123',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'Nov',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper',
    memoUrl: '',
  };
  const { runner, calls, tracking } = createHarness({ existingPapers: [existing] });
  const result = await runner();

  assert.equal(result.duplicateFiles, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(calls.create.length, 0);
  assert.equal(tracking.get('drive-paper-1').duplicateTargetPaperId, 'frontend-paper-123');
  assert.equal(existing.source, undefined);
});

test('duplicate checks use matching Firebase Storage metadata even for a front-end record', async () => {
  const existing = {
    id: 'frontend-paper-storage-metadata',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper%2Fpaper.pdf',
    memoUrl: '',
  };
  const { runner, calls, tracking } = createHarness({
    existingPapers: [existing],
    inspectExistingStorage: async () => ({
      objectPath: 'questionPapers/user/paper/paper.pdf',
      metadata: { contentSha256: sha256Buffer(pdfBuffer), fileType: 'question' },
    }),
    downloadExisting: async () => { throw new Error('Storage metadata should provide the comparison hash.'); },
  });
  const result = await runner();

  assert.equal(result.duplicateFiles, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(tracking.get('drive-paper-1').duplicateTargetPaperId, existing.id);
});

test('a memo duplicate is compared against the memo Storage slot, not the question-paper slot', async () => {
  const memo = paperFile('drive-existing-memo', 'Mathematics - Grade 12 - National - November - 2024 - Paper 1 - Memo.pdf');
  const existing = {
    id: 'frontend-paper-with-memo',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper%2Fpaper.pdf',
    memoUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fmemo%2Fmemo.pdf',
    paperSha256: sha256Buffer(Buffer.from('question paper bytes')),
  };
  const { runner, calls, tracking } = createHarness({
    files: [memo],
    existingPapers: [existing],
    inspectExistingStorage: async () => ({
      objectPath: 'questionPapers/user/memo/memo.pdf',
      metadata: { contentSha256: sha256Buffer(pdfBuffer), fileType: 'memo' },
    }),
    downloadExisting: async () => { throw new Error('The memo Storage hash should provide the comparison.'); },
  });
  const result = await runner();

  assert.equal(result.duplicateFiles, 1);
  assert.equal(calls.upload.length, 0);
  assert.equal(tracking.get(memo.id).duplicateTargetPaperId, existing.id);
});

test('the same metadata with a different month is not a duplicate', async () => {
  const existing = {
    id: 'frontend-paper-other-month',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'October',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper',
    memoUrl: '',
  };
  const { runner, calls } = createHarness({ existingPapers: [existing] });
  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(result.duplicateFiles, 0);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].paperRecord.month, 'November');
});

test('an existing record with no month is uncertain rather than treated as an identity match', () => {
  const incoming = parseGoogleDrivePaperMetadata({
    fileName: 'Mathematics - Grade 12 - National - November - 2024 - Paper 1.pdf',
  }).metadata;
  assert.deepEqual(comparePaperMetadata(incoming, {
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: '',
    paperNumber: 'Paper 1',
  }), { status: 'uncertain', fields: ['month'] });
});

test('a missing memo is attached to the matched paper without creating or reanalyzing a paper record', async () => {
  const memo = paperFile('drive-memo-1', 'Mathematics - Grade 12 - National - November - 2024 - Paper 1 - Memo.pdf');
  const existing = {
    id: 'frontend-paper-456',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperUrl: 'https://firebasestorage.googleapis.com/v0/b/example/o/questionPapers%2Fuser%2Fpaper',
    memoUrl: '',
    analysisStatus: 'Analyzed',
  };
  const { runner, calls } = createHarness({ files: [memo], existingPapers: [existing] });
  const result = await runner();

  assert.equal(result.importedFiles, 1);
  assert.equal(calls.upload.length, 1);
  assert.equal(calls.upload[0].fileType, 'memo');
  assert.equal(calls.attachMemo.length, 1);
  assert.equal(calls.create.length, 0);
  assert.equal(result.duplicateFiles, 0);
  assert.equal(existing.analysisStatus, 'Analyzed');
});

test('a memo seen before its question paper waits and attaches on a later scan', async () => {
  const files = [paperFile('drive-memo-later', 'Mathematics - Grade 12 - National - November - 2024 - Paper 1 - Memo.pdf')];
  const { runner, calls, tracking } = createHarness({ files });
  const firstRun = await runner();
  assert.equal(firstRun.waitingFiles, 1);
  assert.equal(tracking.get('drive-memo-later').importStatus, 'waiting');

  files.unshift(paperFile('drive-question-later'));
  const secondRun = await runner();
  assert.equal(secondRun.importedFiles, 2);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.attachMemo.length, 1);
});

test('ambiguous metadata and combined paper/memo PDFs are held for review', async () => {
  const ambiguous = paperFile('drive-ambiguous', 'Mathematics - Grade 11 and Grade 12 - National - November - 2024 - Paper 1.pdf');
  const combined = paperFile('drive-combined');
  const { runner, calls, tracking } = createHarness({
    files: [ambiguous, combined],
    inspectPdf: async (buffer) => buffer.equals(pdfBuffer)
      ? { combinedPaperAndMemo: true, reason: 'Question and memo pages detected.' }
      : {},
  });
  const result = await runner();

  assert.equal(result.reviewFiles, 2);
  assert.equal(calls.upload.length, 0);
  assert.equal(tracking.get('drive-ambiguous').importStatus, 'review');
  assert.equal(tracking.get('drive-combined').importStatus, 'review');
});

test('one failed file does not block a later valid file in the same scan', async () => {
  const files = [paperFile('drive-fails'), paperFile('drive-succeeds', 'Mathematics - Grade 11 - Gauteng - October - 2023 - Paper 2.pdf')];
  const { runner, calls, tracking } = createHarness({
    files,
    downloadFile: async (file) => {
      if (file.id === 'drive-fails') throw new Error('temporary download failure');
      return pdfBuffer;
    },
  });
  const result = await runner();

  assert.equal(result.failedFiles, 1);
  assert.equal(result.importedFiles, 1);
  assert.equal(tracking.get('drive-fails').importStatus, 'failed');
  assert.equal(tracking.get('drive-succeeds').importStatus, 'imported');
  assert.equal(calls.create.length, 1);
});

test('a retry after Storage succeeds but Firestore creation fails reuses one object and creates one paper record', async () => {
  const file = paperFile('drive-partial-failure');
  const tracking = new Map();
  const storedObjects = new Set();
  let createAttempts = 0;
  const runner = createDrivePaperImportRunner({
    rootFolderId: 'configured-past-papers-folder',
    acquireLease: async () => ({ acquired: true, owner: 'lease-test' }),
    releaseLease: async () => {},
    listFiles: async () => [file],
    readTracking: async (id) => tracking.get(id) ?? null,
    writeTracking: async (id, fields) => tracking.set(id, { ...(tracking.get(id) ?? {}), ...fields }),
    loadExistingPapers: async () => [],
    downloadFile: async () => pdfBuffer,
    downloadExisting: async () => pdfBuffer,
    inspectPdf: async () => ({}),
    uploadPdf: async ({ file: sourceFile, fileType }) => {
      storedObjects.add(`${sourceFile.id}:${fileType}`);
      return { path: `questionPapers/google-drive/${fileType}/${sourceFile.id}.pdf`, url: `https://storage.example/${sourceFile.id}` };
    },
    createPaperIfAbsent: async () => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error('temporary Firestore failure');
      return { created: true };
    },
    attachMemoIfMissing: async () => ({ attached: true }),
  });

  const firstRun = await runner();
  const retry = await runner();

  assert.equal(firstRun.failedFiles, 1);
  assert.equal(retry.importedFiles, 1);
  assert.equal(storedObjects.size, 1);
  assert.equal(createAttempts, 2);
  assert.equal(tracking.get(file.id).importStatus, 'imported');
});

test('an overlapping run exits while another scan owns the lease', async () => {
  let leaseHeld = false;
  let notifyListing;
  const listingStarted = new Promise((resolve) => { notifyListing = resolve; });
  let releaseListing;
  const listingGate = new Promise((resolve) => { releaseListing = resolve; });
  const harness = createHarness();
  const overlapRunner = createDrivePaperImportRunner({
    rootFolderId: 'configured-past-papers-folder',
    acquireLease: async () => {
      if (leaseHeld) return { acquired: false };
      leaseHeld = true;
      return { acquired: true, owner: 'shared' };
    },
    releaseLease: async () => { leaseHeld = false; },
    listFiles: async () => { notifyListing(); await listingGate; return []; },
    readTracking: async () => null,
    writeTracking: async () => {},
    loadExistingPapers: async () => [],
    downloadFile: async () => pdfBuffer,
    downloadExisting: async () => pdfBuffer,
    inspectPdf: async () => ({}),
    uploadPdf: async () => ({}),
    createPaperIfAbsent: async () => ({ created: true }),
    attachMemoIfMissing: async () => ({ attached: true }),
  });
  const firstRun = overlapRunner();
  await listingStarted;
  const concurrentRun = await overlapRunner();
  releaseListing();
  await firstRun;

  assert.equal(concurrentRun.skipped, true);
  assert.equal(harness.calls.create.length, 0);
});

test('manual imports are constrained to the selected direct folder files', async () => {
  const files = [paperFile('folder-paper-1'), paperFile('folder-paper-2', 'Mathematics - Grade 11 - Gauteng - October - 2023 - Paper 2.pdf')];
  const { runner, calls } = createHarness({ files });
  const result = await runner({ requestedBy: 'admin:test', folderId: 'selected-folder', fileIds: ['folder-paper-2'] });

  assert.equal(result.importedFiles, 1);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].paperRecord.driveFileId, 'folder-paper-2');
});

test('folder preview groups paper and memo and reports their Firebase storage state', () => {
  const question = paperFile();
  const memo = paperFile('drive-memo-preview', 'Mathematics - Grade 12 - National - November - 2024 - Paper 1 - Memo.pdf');
  const existing = {
    id: 'frontend-paper-preview',
    subject: 'Mathematics',
    grade: 'Grade 12',
    region: 'National',
    year: 2024,
    month: 'November',
    paperNumber: 'Paper 1',
    paperUrl: 'https://storage.example/paper',
    memoUrl: '',
  };
  const [group] = summarizeDriveFolderPapers({ files: [question, memo], existingPapers: [existing] });

  assert.equal(group.paperStatus, 'uploaded');
  assert.equal(group.memoStatus, 'missing');
  assert.deepEqual(group.importFileIds, ['drive-memo-preview']);
  assert.equal(group.targetPaperId, 'frontend-paper-preview');
});

test('schedule is daily at midnight in South African time', () => {
  assert.deepEqual(DRIVE_PAPER_IMPORT_SCHEDULE, {
    schedule: '0 0 * * *',
    timeZone: 'Africa/Johannesburg',
  });
});

test('the existing front-end upload and save path remains in place', async () => {
  const storageSource = await readFile(new URL('../../src/services/storageService.js', import.meta.url), 'utf8');
  const papersPageSource = await readFile(new URL('../../src/pages/PastExamPapersPage.jsx', import.meta.url), 'utf8');
  const firestoreSource = await readFile(new URL('../../src/services/firestoreService.js', import.meta.url), 'utf8');
  const analysisSource = await readFile(new URL('./questionPaperAnalysis.js', import.meta.url), 'utf8');

  assert.deepEqual(PAPER_MONTHS, ['March', 'June', 'September', 'November']);
  assert.equal(detectUploaderPaperMonth('Mathematics November 2020 Paper 1.pdf'), 'November');
  assert.equal(detectUploaderPaperMonth('Mathematics December 2020 Paper 1.pdf'), 'November');
  assert.equal(detectUploaderPaperMonth('Mathematics Paper 1.pdf'), 'March');
  assert.match(papersPageSource, /detectUploaderPaperMonth\(name\)/);
  assert.match(papersPageSource, /value\.month && !PAPER_MONTHS\.includes\(value\.month\)/);
  assert.match(storageSource, /questionPapers\/\$\{uploaderId\}\/paper/);
  assert.match(storageSource, /questionPapers\/\$\{uploaderId\}\/memo/);
  assert.match(papersPageSource, /uploadQuestionPaperDocuments/);
  assert.match(papersPageSource, /saveQuestionPaper\(/);
  assert.match(firestoreSource, /analysisRequestedAt: serverTimestamp\(\)/);
  assert.match(analysisSource, /document: 'questionPapers\/\{paperId\}'/);
  assert.match(analysisSource, /PAPER_QUEUE_COLLECTION = 'questionPaperAnalysisQueue'/);
});
