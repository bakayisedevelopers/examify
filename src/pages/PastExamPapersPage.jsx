import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, Folder, HardDriveDownload, ListChecks, LoaderCircle, Pause, Play, RotateCcw, Save, Search, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/common/AppShell';
import { LoadingState } from '../components/common/LoadingState';
import { SectionHeader } from '../components/common/SectionHeader';
import { useAuth } from '../hooks/useAuth';
import { useOperationStatus } from '../hooks/useOperationStatus';
import { DEFAULT_SUBJECT, PAPER_MONTHS, PAPER_NUMBERS, REGIONS, ROLES, SOUTH_AFRICAN_GRADES, SUBJECTS } from '../lib/constants';
import { cancelQuestionPaperAnalysis, cleanupGlobalTopicCatalog, getGlobalTopicList, getGoogleDrivePastPaperFolderContents, getGoogleDrivePastPaperImportStatuses, getQuestionPaperAnalysisControl, getTopicResolverMappings, getTopicResolverSourceRecords, initializeGlobalTopicCatalog, resolveTopicsWithGemini, saveQuestionPaper, saveTopicResolverMappings, setQuestionPaperAnalysisPaused, startGoogleDrivePastPaperImport, subscribeQuestionPapers, updateQuestionPaper } from '../services/firestoreService';
import { uploadQuestionPaperDocuments } from '../services/storageService';
import { getApprovedTutorSubjects, getUserSubjects } from '../utils/tutorSubjects';
import { buildTopicResolverRows } from '../services/topicResolver';
import { detectUploaderPaperMonth } from '../utils/paperMonth';

const paperStatusStyles = {
  Analyzing: 'bg-amber-400/15 text-amber-300 border border-amber-400/30',
  Analyzed: 'bg-lime-400/15 text-lime-300 border border-lime-400/30',
  Failed: 'bg-rose-400/15 text-rose-300 border border-rose-400/30',
  Cancelled: 'bg-slate-800 text-slate-400 border border-slate-700',
};

const defaultPaperForm = (profile) => ({
  grade: profile?.grade || SOUTH_AFRICAN_GRADES[0],
  region: profile?.province || REGIONS[0],
  subject: DEFAULT_SUBJECT,
  year: new Date().getFullYear(),
  month: PAPER_MONTHS[0],
  paperNumber: PAPER_NUMBERS[0],
  notes: '',
  paperFile: null,
  memoFile: null,
});

const normalizeFileName = (name = '') => String(name).toLowerCase().replace(/\.[^.]+$/, '').replace(/memo|memorandum|marking|guideline|answers|answer|question|paper|qp/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const isMemoFile = (file) => /memo|memorandum|marking|guideline|answers|answer/i.test(file?.name ?? '');
const fileTokens = (file) => new Set(normalizeFileName(file?.name).split(' ').filter((token) => token.length > 1));

const analysisDriveStatus = (value) => value === 'Analyzing'
  ? 'analyzing'
  : value === 'Analyzed'
    ? 'analyzed'
    : ['Failed', 'Cancelled'].includes(value)
      ? 'analysis-failed'
      : '';

const mergeDriveImportStatuses = (contents, statuses = []) => {
  if (!contents) return contents;
  const statusByFileId = new Map(statuses.map((item) => [item.fileId, item]));
  const importingStatuses = new Set(['importing', 'processing']);
  const completedStatuses = new Set(['imported', 'duplicate', 'review']);
  return {
    ...contents,
    papers: contents.papers.map((group) => {
      const mergeFile = (file) => {
        const nextStatus = statusByFileId.get(file.id);
        return nextStatus ? { ...file, ...nextStatus } : file;
      };
      const files = group.files.map(mergeFile);
      const questionFiles = group.questionFiles.map(mergeFile);
      const memoFiles = group.memoFiles.map(mergeFile);
      const importingQuestion = questionFiles.some((file) => importingStatuses.has(file.importStatus));
      const importingMemo = memoFiles.some((file) => importingStatuses.has(file.importStatus));
      const questionStatus = questionFiles[0];
      const memoStatus = memoFiles[0];
      const targetAnalysisStatus = analysisDriveStatus(questionStatus?.analysisStatus);
      const importing = importingQuestion || importingMemo;
      const importFileIds = importing
        ? []
        : group.importFileIds.filter((fileId) => {
          const status = statusByFileId.get(fileId)?.importStatus;
          return !completedStatuses.has(status);
        });
      return {
        ...group,
        files,
        questionFiles,
        memoFiles,
        paperStatus: group.reviewReason
          ? 'review'
          : importingQuestion
            ? 'importing'
            : ['imported', 'duplicate'].includes(questionStatus?.importStatus)
              ? (targetAnalysisStatus || 'uploaded')
              : questionStatus?.importStatus === 'failed'
                ? 'import-failed'
                : group.paperStatus,
        memoStatus: group.reviewReason
          ? 'review'
          : importingMemo
            ? 'importing'
            : memoStatus?.importStatus === 'imported' || memoStatus?.importStatus === 'duplicate'
              ? 'uploaded'
              : memoStatus?.importStatus === 'failed'
                ? 'import-failed'
                : group.memoStatus,
        importFileIds,
      };
    }),
  };
};

const driveImportStageLabels = {
  downloading: 'Downloading from Drive',
  validating: 'Checking PDF',
  checking_existing_records: 'Checking for duplicates',
  uploading_memo: 'Uploading memo to Storage',
  saving_memo_reference: 'Saving memo reference',
  uploading_question_paper: 'Uploading paper to Storage',
  saving_paper_record: 'Saving paper and starting analysis',
};

const openLocalFilePreview = (file) => {
  if (!file) return;
  const url = URL.createObjectURL(file);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

const overlapScore = (leftFile, rightFile) => {
  const left = fileTokens(leftFile);
  const right = fileTokens(rightFile);
  return [...left].filter((token) => right.has(token)).length;
};

const inferMetadataFromName = (file, profile) => {
  const name = file?.name ?? '';
  const lower = name.toLowerCase();
  const filenameWords = lower.replace(/[^a-z0-9]+/g, ' ');
  const year = Number(lower.match(/\b(20\d{2}|19\d{2})\b/)?.[1]) || new Date().getFullYear();
  const month = detectUploaderPaperMonth(name);
  const examplarDetected = /\b(?:examplar|exemplar)(?=\b|[0-9])/i.test(filenameWords);
  const detectedPaperNumber = PAPER_NUMBERS.find((item) => {
    const number = item.match(/\d/)?.[0];
    return number && new RegExp(`(?:paper|p|paper\\s*)\\s*${number}|${number}[^0-9]*paper`, 'i').test(name);
  });
  const paperNumber = examplarDetected
    ? 'Examplar'
    : detectedPaperNumber ?? PAPER_NUMBERS[0];
  const subject = SUBJECTS.find((item) => lower.includes(item.toLowerCase().replace(/\s+/g, ' '))) ?? DEFAULT_SUBJECT;
  const grade = SOUTH_AFRICAN_GRADES.find((item) => item !== 'Select Grade' && lower.includes(item.toLowerCase())) ?? profile?.grade ?? SOUTH_AFRICAN_GRADES[0];
  const region = REGIONS.find((item) => lower.includes(item.toLowerCase())) ?? profile?.province ?? REGIONS[0];
  return { grade, region, subject, year, month, paperNumber };
};

const makeBulkFileEntry = (file) => ({
  id: `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  file,
});

const pairAvailableBulkMemos = (rows, memoEntries) => {
  const nextRows = rows.map((row) => ({ ...row }));
  const remainingMemos = [];
  memoEntries.forEach((entry) => {
    let bestRowIndex = -1;
    let bestScore = 0;
    nextRows.forEach((row, index) => {
      if (row.memoFile || row.paperFileId === entry.id) return;
      const score = overlapScore(row.paperFile, entry.file);
      if (score > bestScore) {
        bestScore = score;
        bestRowIndex = index;
      }
    });
    if (bestRowIndex >= 0) {
      nextRows[bestRowIndex] = {
        ...nextRows[bestRowIndex],
        memoFile: entry.file,
        memoFileId: entry.id,
      };
    } else {
      remainingMemos.push(entry);
    }
  });
  return { rows: nextRows, memoFiles: remainingMemos };
};

const buildBulkRows = ({ files, profile }) => {
  const allEntries = Array.from(files ?? [], makeBulkFileEntry);
  const memoEntries = allEntries.filter(({ file }) => isMemoFile(file));
  const paperEntries = allEntries.filter(({ file }) => !isMemoFile(file));
  const usedMemoIndexes = new Set();

  const rows = paperEntries.map((paperEntry, index) => {
    let bestMemoIndex = -1;
    let bestScore = 0;
    memoEntries.forEach((memoEntry, memoIndex) => {
      if (usedMemoIndexes.has(memoIndex)) return;
      const score = overlapScore(paperEntry.file, memoEntry.file);
      if (score > bestScore) {
        bestScore = score;
        bestMemoIndex = memoIndex;
      }
    });
    const memoEntry = bestScore > 0 && bestMemoIndex >= 0 ? memoEntries[bestMemoIndex] : null;
    if (bestMemoIndex >= 0) usedMemoIndexes.add(bestMemoIndex);
    return {
      id: paperEntry.id || `bulk-row-${Date.now()}-${index}`,
      paperFileId: paperEntry.id,
      paperFile: paperEntry.file,
      memoFileId: memoEntry?.id ?? '',
      memoFile: memoEntry?.file ?? null,
      ...inferMetadataFromName(paperEntry.file, profile),
      notes: '',
    };
  });
  return {
    rows,
    memoFiles: memoEntries.filter((_, index) => !usedMemoIndexes.has(index)),
  };
};

const PaperAnalysisStatus = ({ paper }) => {
  const status = paper.analysisStatus ?? (paper.availableForGeneration ? 'Analyzed' : 'Analyzing');
  const current = Number(paper.analysisProgressCurrent ?? 0);
  const total = Math.max(1, Number(paper.analysisProgressTotal ?? 1));
  const percentage = status === 'Analyzed' ? 100 : Math.max(0, Math.min(100, Math.round((current / total) * 100)));

  return (
    <div className="mt-4 rounded-2xl bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3 text-xs font-semibold">
        <span className={`rounded-full px-3 py-1 ${paperStatusStyles[status] ?? 'bg-slate-100 text-slate-600'}`}>{status}</span>
        <span className="text-slate-500">{percentage}%</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200">
        <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${percentage}%` }} />
      </div>
      <p className="mt-2 text-xs text-slate-500">{paper.analysisProgressMessage ?? (status === 'Analyzed' ? `${paper.questionCount ?? 0} questions indexed` : 'Waiting for analysis')}</p>
    </div>
  );
};

const canQueuePaperAnalysis = (paper) => paper?.analysisStatus !== 'Analyzing';
const reanalysisButtonLabel = (paper) => paper?.analysisStatus === 'Failed' ? 'Retry analysis' : 'Run analysis again';
const canManagePaperAnalysis = (role) => role === ROLES.ADMIN || role === ROLES.TUTOR;
const canStopPaperAnalysis = (paper) =>
  paper?.analysisStatus === 'Analyzing' || Boolean(paper?.activeAnalysisRunId || paper?.queuedAnalysisRunId);
const getPaperTitle = (paper) => paper.title || paper.paperName || paper.paperFileName?.replace(/\.[^.]+$/, '') ||
  paper.paperTitle || paper.paperMetadata?.paperTitle || paper.displayName || `${paper.subject || 'Question paper'} • ${paper.grade || ''}`;
const getPaperDateValue = (value) => value?.toMillis?.() ?? new Date(value?.toDate?.() ?? value ?? 0).getTime();
const getPaperField = (paper, field) => paper?.[field] ?? paper?.paperMetadata?.[field] ?? '';
const getPaperSubject = (paper) => String(getPaperField(paper, 'subject') ?? '').trim().replace(/\s+/g, ' ');
const normalizePaperSubject = (subject) => String(subject ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
const getPaperSearchText = (paper) => [
  paper.displayName,
  paper.title,
  paper.paperName,
  paper.paperTitle,
  paper.paperFileName,
  paper.memoFileName,
  paper.subject,
  paper.grade,
  paper.region,
  paper.examBoard,
  paper.province,
  paper.month,
  paper.year,
  paper.paperNumber,
  paper.notes,
  ...Object.entries(paper).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([, value]) => value),
  ...Object.values(paper.paperMetadata ?? {}),
].filter(Boolean).join(' ').toLowerCase();

export const PastExamPapersPage = () => {
  const { profile, user, logout } = useAuth();
  const { runOperation } = useOperationStatus();
  const [papers, setPapers] = useState([]);
  const [isLoadingPapers, setIsLoadingPapers] = useState(true);
  const [status, setStatus] = useState('');
  const [driveImportRunning, setDriveImportRunning] = useState(false);
  const [driveImportMessage, setDriveImportMessage] = useState('');
  const [driveExplorerOpen, setDriveExplorerOpen] = useState(false);
  const [driveFolderContents, setDriveFolderContents] = useState(null);
  const [driveFolderTrail, setDriveFolderTrail] = useState([]);
  const [driveFolderLoading, setDriveFolderLoading] = useState(false);
  const [analysisQueuePaused, setAnalysisQueuePaused] = useState(false);
  const [analysisQueueActivePaperId, setAnalysisQueueActivePaperId] = useState('');
  const [analysisQueueControlReady, setAnalysisQueueControlReady] = useState(false);
  const [analysisQueueControlFailed, setAnalysisQueueControlFailed] = useState(false);
  const [analysisQueueControlSaving, setAnalysisQueueControlSaving] = useState(false);
  const [analysisQueueMessage, setAnalysisQueueMessage] = useState('');
  const [uploadTab, setUploadTab] = useState('single');
  const [singleForm, setSingleForm] = useState(defaultPaperForm(profile));
  const [bulkRows, setBulkRows] = useState([]);
  const [bulkMemoFiles, setBulkMemoFiles] = useState([]);
  const bulkAdditionalInputRef = useRef(null);
  const [filters, setFilters] = useState({ subject: 'all', year: 'all' });
  const [adminPaperFilters, setAdminPaperFilters] = useState({
    analyzing: { search: '', subject: 'all', year: 'all' },
    analyzed: { search: '', subject: 'all', year: 'all' },
    failed: { search: '', subject: 'all', year: 'all' },
  });
  const [studentFilterOverrides, setStudentFilterOverrides] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [editingPaper, setEditingPaper] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [expandedPaperIds, setExpandedPaperIds] = useState({});
  const [topicResolverOpen, setTopicResolverOpen] = useState(false);
  const [topicResolverSubject, setTopicResolverSubject] = useState('');
  const [topicResolverGrade, setTopicResolverGrade] = useState('');
  const [topicResolverRows, setTopicResolverRows] = useState([]);
  const [topicResolverCatalog, setTopicResolverCatalog] = useState([]);
  const [topicResolverCorrections, setTopicResolverCorrections] = useState({});
  const [topicResolverMethods, setTopicResolverMethods] = useState({});
  const [topicResolverReviewed, setTopicResolverReviewed] = useState(false);
  const [topicResolverSearch, setTopicResolverSearch] = useState('');
  const [topicResolverStatus, setTopicResolverStatus] = useState('');
  const [topicResolverLoading, setTopicResolverLoading] = useState(false);
  const [topicResolverGeminiLoading, setTopicResolverGeminiLoading] = useState(false);
  const [topicResolverSaveLoading, setTopicResolverSaveLoading] = useState(false);
  const [topicResolverCleanupLoading, setTopicResolverCleanupLoading] = useState(false);

  useEffect(() => {
    if (!topicResolverOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [topicResolverOpen]);

  const role = useMemo(() => profile?.role ?? ROLES.STUDENT, [profile]);
  useEffect(() => {
    if (role !== ROLES.ADMIN) return undefined;
    let active = true;
    setAnalysisQueueControlReady(false);
    setAnalysisQueueControlFailed(false);
    getQuestionPaperAnalysisControl().then((control) => {
      if (!active) return;
      setAnalysisQueuePaused(control.paused === true);
      setAnalysisQueueActivePaperId(String(control.activePaperId ?? ''));
      setAnalysisQueueControlReady(true);
      setAnalysisQueueControlFailed(false);
      setAnalysisQueueMessage('');
    }).catch((error) => {
      if (!active) return;
      setAnalysisQueueControlFailed(true);
      setAnalysisQueueMessage(error.message || 'Could not load the analysis queue status. Refresh the page and try again.');
    });
    return () => { active = false; };
  }, [role]);
  const allowedSubjects = useMemo(() => {
    if (role === ROLES.ADMIN) return SUBJECTS;
    if (role === ROLES.TUTOR) return getApprovedTutorSubjects(profile);
    return getUserSubjects(profile);
  }, [profile, role]);
  const visibleSubjects = allowedSubjects.length ? allowedSubjects : SUBJECTS;
  const isStudentExploring = Boolean(searchTerm.trim()) || Object.keys(studentFilterOverrides).length > 0;
  const studentFilterValues = { subject: 'all', grade: 'all', year: 'all', region: 'all', month: 'all', paperNumber: 'all', ...studentFilterOverrides };

  const handleToggleAnalysisQueue = async () => {
    if (!analysisQueueControlReady || analysisQueueControlSaving) return;
    const paused = !analysisQueuePaused;
    setAnalysisQueueControlSaving(true);
    setAnalysisQueueMessage('');
    try {
      const result = await setQuestionPaperAnalysisPaused(paused);
      setAnalysisQueuePaused(result.paused === true);
      setAnalysisQueueActivePaperId(String(result.activePaperId ?? ''));
      setAnalysisQueueMessage(paused
        ? 'The queue is paused. Any paper already in progress will finish; queued papers are being kept.'
        : 'The queue has resumed. Queued papers will continue in order.');
    } catch (error) {
      setAnalysisQueueMessage(error.message || `Could not ${paused ? 'pause' : 'resume'} question-paper analysis.`);
    } finally {
      setAnalysisQueueControlSaving(false);
    }
  };

  useEffect(() => {
    let active = true;
    setIsLoadingPapers(true);
    const unsubscribe = subscribeQuestionPapers((rows) => {
      if (!active) return;
      setPapers(rows);
      setIsLoadingPapers(false);
    }, (error) => {
      if (!active) return;
      setStatus(error.message || 'Could not load past papers.');
      setIsLoadingPapers(false);
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  const paperSubjects = useMemo(() => {
    const subjectsByKey = new Map();
    papers.forEach((paper) => {
      const subject = getPaperSubject(paper);
      const key = normalizePaperSubject(subject);
      if (key && !subjectsByKey.has(key)) subjectsByKey.set(key, subject);
    });
    return [...subjectsByKey.values()].sort((left, right) => left.localeCompare(right));
  }, [papers]);

  const visiblePapers = useMemo(() => {
    const orderedPapers = [...papers].sort((left, right) =>
      Number(getPaperField(right, 'year') || 0) - Number(getPaperField(left, 'year') || 0) ||
      getPaperDateValue(right.createdAt) - getPaperDateValue(left.createdAt));

    if (role === ROLES.STUDENT) {
      const matchingPapers = orderedPapers
        .filter((paper) => {
          const selectedSubject = studentFilterOverrides.subject ?? 'all';
          const matchesSubject = selectedSubject === 'all' || normalizePaperSubject(getPaperSubject(paper)) === normalizePaperSubject(selectedSubject);
          const matchesGrade = (studentFilterOverrides.grade ?? 'all') === 'all' || getPaperField(paper, 'grade') === studentFilterOverrides.grade;
          const matchesYear = (studentFilterOverrides.year ?? 'all') === 'all' || String(getPaperField(paper, 'year')) === String(studentFilterOverrides.year);
          const matchesRegion = (studentFilterOverrides.region ?? 'all') === 'all' || getPaperField(paper, 'region') === studentFilterOverrides.region;
          const matchesMonth = (studentFilterOverrides.month ?? 'all') === 'all' || getPaperField(paper, 'month') === studentFilterOverrides.month;
          const matchesPaperNumber = (studentFilterOverrides.paperNumber ?? 'all') === 'all' || getPaperField(paper, 'paperNumber') === studentFilterOverrides.paperNumber;
          const tokens = searchTerm.trim().toLowerCase().split(/\s+/).filter(Boolean);
          const searchText = getPaperSearchText(paper);
          const matchesSearch = tokens.every((token) => searchText.includes(token));
          return matchesSubject && matchesGrade && matchesYear && matchesRegion && matchesMonth && matchesPaperNumber && matchesSearch;
        });

      return isStudentExploring ? matchingPapers : orderedPapers.slice(0, 20);
    }

    return orderedPapers
      .filter((paper) => role !== ROLES.PARENT || !visibleSubjects.length || visibleSubjects.includes(getPaperSubject(paper)))
      .filter((paper) => filters.subject === 'all' || normalizePaperSubject(getPaperSubject(paper)) === normalizePaperSubject(filters.subject))
      .filter((paper) => filters.year === 'all' || String(paper.year) === String(filters.year));
  }, [papers, role, visibleSubjects, filters, isStudentExploring, studentFilterOverrides, searchTerm]);
  const adminPaperGroups = useMemo(() => {
    const groups = { analyzing: [], analyzed: [], failed: [] };
    const orderedPapers = [...papers].sort((left, right) =>
      Number(getPaperField(right, 'year') || 0) - Number(getPaperField(left, 'year') || 0) ||
      getPaperDateValue(right.createdAt) - getPaperDateValue(left.createdAt));

    orderedPapers.forEach((paper) => {
      const status = paper.analysisStatus;
      const group = status === 'Failed' || status === 'Cancelled'
        ? 'failed'
        : status === 'Analyzed' || (!status && paper.availableForGeneration)
          ? 'analyzed'
          : 'analyzing';
      groups[group].push(paper);
    });

    return groups;
  }, [papers]);
  const years = useMemo(() => [...new Set(papers.map((paper) => getPaperField(paper, 'year')).filter(Boolean))].sort((a, b) => Number(b) - Number(a)), [papers]);
  const grades = useMemo(() => [...new Set([
    ...SOUTH_AFRICAN_GRADES.filter((grade) => grade !== 'Select Grade'),
    ...papers.map((paper) => getPaperField(paper, 'grade')).filter(Boolean),
  ])].sort((left, right) => {
    const leftOrder = SOUTH_AFRICAN_GRADES.indexOf(left);
    const rightOrder = SOUTH_AFRICAN_GRADES.indexOf(right);
    return (leftOrder < 0 ? Number.MAX_SAFE_INTEGER : leftOrder) - (rightOrder < 0 ? Number.MAX_SAFE_INTEGER : rightOrder) || left.localeCompare(right);
  }), [papers]);
  const regions = useMemo(() => [...new Set([...REGIONS, ...papers.map((paper) => getPaperField(paper, 'region')).filter(Boolean)])], [papers]);
  const months = useMemo(() => [...new Set([...PAPER_MONTHS, ...papers.map((paper) => getPaperField(paper, 'month')).filter(Boolean)])], [papers]);
  const paperNumbers = useMemo(() => [...new Set([...PAPER_NUMBERS, ...papers.map((paper) => getPaperField(paper, 'paperNumber')).filter(Boolean)])], [papers]);

  const updateStudentFilter = (field, value) => setStudentFilterOverrides((current) => ({ ...current, [field]: value }));
  const resetStudentFilters = () => {
    setSearchTerm('');
    setStudentFilterOverrides({});
  };
  const updateAdminPaperFilter = (group, field, value) => setAdminPaperFilters((current) => ({
    ...current,
    [group]: { ...current[group], [field]: value },
  }));

  const searchTopicResolver = async () => {
    if (!topicResolverSubject || !topicResolverGrade) {
      setTopicResolverStatus('Choose both a subject and grade before searching Firestore.');
      return;
    }
    setTopicResolverLoading(true);
    setTopicResolverStatus('Preparing the global topic catalog and searching Firestore…');
    setTopicResolverRows([]);
    setTopicResolverCatalog([]);
    setTopicResolverCorrections({});
    setTopicResolverMethods({});
    setTopicResolverReviewed(false);
    try {
      const migration = await runOperation({ operationName: 'Preparing topic catalog', successMessage: 'The topic catalog is ready.' }, () => initializeGlobalTopicCatalog());
      const [records, savedMappings, catalogTopics] = await Promise.all([
        getTopicResolverSourceRecords({ subject: topicResolverSubject, grade: topicResolverGrade }),
        getTopicResolverMappings({ subject: topicResolverSubject, grade: topicResolverGrade }),
        getGlobalTopicList({ subject: topicResolverSubject, grade: topicResolverGrade }),
      ]);
      const rows = buildTopicResolverRows(records, savedMappings, catalogTopics);
      setTopicResolverRows(rows);
      setTopicResolverCatalog(catalogTopics);
      setTopicResolverReviewed(false);
      const migrationSummary = migration?.alreadyInitialized
        ? 'Global catalog is already initialized.'
        : `Initialized ${migration?.topicCount ?? 0} global topics and backfilled ${migration?.analyzedPaperCount ?? 0} analyzed papers.`;
      setTopicResolverStatus(rows.length
        ? `${migrationSummary} ${rows.length} distinct source topic name${rows.length === 1 ? '' : 's'} found from ${records.length} matching records.`
        : `${migrationSummary} No extracted or covered-lesson topics were found for this subject and grade.`);
    } catch (error) {
      setTopicResolverStatus(error.message || 'Could not search Firestore.');
    } finally {
      setTopicResolverLoading(false);
    }
  };

  const checkGlobalTopicCatalog = async () => {
    if (!topicResolverSubject || !topicResolverGrade || topicResolverCleanupLoading) return;
    setTopicResolverCleanupLoading(true);
    setTopicResolverStatus('Checking saved global topics against analyzed questions and difficulty metadata…');
    try {
      const result = await runOperation({
        operationName: 'Checking global topic catalog',
        message: 'Topics without analyzed questions or difficulty metadata will be removed from the global lesson list.',
        successMessage: 'The global topic catalog check completed.',
      }, () => cleanupGlobalTopicCatalog({
        action: 'reconcile-grade',
        subject: topicResolverSubject,
        grade: topicResolverGrade,
      }));
      const removedKeys = new Set((result.removedTopics ?? []).map((topic) => String(topic).trim().toLocaleLowerCase()));
      setTopicResolverCatalog((current) => current.filter((topic) => !removedKeys.has(String(topic).trim().toLocaleLowerCase())));
      const removedCount = result.removedTopics?.length ?? 0;
      const metadataCount = Number(result.difficultyMetadataUpdatedCount) || 0;
      setTopicResolverStatus(
        `${result.checkedTopicCount ?? 0} stored topics checked. ${removedCount} topic${removedCount === 1 ? '' : 's'} removed${metadataCount ? `; difficulty saved for ${metadataCount} legacy topic${metadataCount === 1 ? '' : 's'}` : ''}. Existing student topic history was kept.`,
      );
    } catch (error) {
      setTopicResolverStatus(error.message || 'Could not check the global topic catalog.');
    } finally {
      setTopicResolverCleanupLoading(false);
    }
  };

  const currentResolverValue = (row) => topicResolverCorrections[row.id] ?? row.suggestedTopic;
  const unresolvedTopicRows = topicResolverRows.filter((row) => !currentResolverValue(row));
  const resolvedTopicRows = topicResolverRows.filter((row) => Boolean(currentResolverValue(row)));
  const suggestedTopicRows = topicResolverRows.filter((row) => {
    const method = topicResolverMethods[row.id] ?? row.matchType;
    return method === 'gemini-suggested' || method === 'saved-suggestion';
  });

  const resolveUnmappedTopicsWithGemini = async () => {
    const unresolved = topicResolverRows.filter((row) => !currentResolverValue(row));
    if (!unresolved.length) {
      setTopicResolverStatus('All topics already have a mapping to review.');
      return;
    }
    setTopicResolverGeminiLoading(true);
    setTopicResolverStatus(`Matching ${unresolved.length} unresolved topic${unresolved.length === 1 ? '' : 's'} to the Firestore topic list and preparing Google Gemini suggestions where needed...`);
    let resolvedCount = 0;
    let suggestedCount = 0;
    try {
      for (let index = 0; index < unresolved.length; index += 25) {
        const rows = unresolved.slice(index, index + 25);
        const result = await runOperation({ operationName: 'Matching topic names', successMessage: 'Topic matching finished.' }, () => resolveTopicsWithGemini({
          subject: topicResolverSubject,
          grade: topicResolverGrade,
          topics: rows.map((row) => row.sourceTopic),
        }));
        const resolved = Array.isArray(result?.topics) ? result.topics : [];
        const resolutionTypes = Array.isArray(result?.resolutionTypes) ? result.resolutionTypes : [];
        setTopicResolverCorrections((current) => {
          const next = { ...current };
          rows.forEach((row, rowIndex) => {
            if (resolved[rowIndex]) next[row.id] = resolved[rowIndex];
          });
          return next;
        });
        setTopicResolverMethods((current) => {
          const next = { ...current };
          rows.forEach((row, rowIndex) => {
            if (resolved[rowIndex]) next[row.id] = resolutionTypes[rowIndex] === 'suggested' ? 'gemini-suggested' : 'gemini';
          });
          return next;
        });
        setTopicResolverReviewed(false);
        resolvedCount += resolved.filter((topic, rowIndex) => Boolean(topic) && resolutionTypes[rowIndex] !== 'suggested').length;
        suggestedCount += resolved.filter((topic, rowIndex) => Boolean(topic) && resolutionTypes[rowIndex] === 'suggested').length;
      }
      setTopicResolverStatus(`Gemini matched ${resolvedCount} topics and suggested ${suggestedCount} new labels. Review every mapping before saving.`);
    } catch (error) {
      setTopicResolverStatus(error.message || 'Gemini could not resolve the topics. Any completed suggestions are still available to review.');
    } finally {
      setTopicResolverGeminiLoading(false);
    }
  };

  const saveReviewedTopicMappings = async () => {
    if (unresolvedTopicRows.length || !topicResolverRows.length || !topicResolverReviewed) return;
    setTopicResolverSaveLoading(true);
    setTopicResolverStatus('Saving reviewed topic mappings...');
    try {
      const mappings = topicResolverRows.map((row) => ({
        sourceTopic: row.sourceTopic,
        canonicalTopic: currentResolverValue(row),
        resolutionType: ['gemini-suggested', 'saved-suggestion'].includes(topicResolverMethods[row.id] ?? row.matchType) ? 'suggested' : 'canonical',
      }));
      const result = await runOperation({ operationName: 'Saving reviewed topic mappings', successMessage: 'The reviewed topic mappings were saved.' }, () => saveTopicResolverMappings({
        subject: topicResolverSubject,
        grade: topicResolverGrade,
        rows: mappings,
        adminId: user?.uid,
      }));
      const savedBySource = new Map(mappings.map((mapping) => [mapping.sourceTopic, mapping]));
      setTopicResolverRows((current) => current.map((row) => {
        const saved = savedBySource.get(row.sourceTopic);
        return {
          ...row,
          suggestedTopic: saved?.canonicalTopic ?? currentResolverValue(row),
          isSaved: true,
          matchType: saved?.resolutionType === 'suggested' ? 'saved-suggestion' : 'saved',
        };
      }));
      setTopicResolverCorrections({});
      setTopicResolverMethods({});
      setTopicResolverReviewed(true);
      setTopicResolverCatalog((current) => [...new Set([
        ...current,
        ...mappings.map((mapping) => String(mapping.canonicalTopic ?? '').trim().replace(/\s*\|\s*/g, ' | ')),
      ].filter(Boolean))].sort((left, right) => left.localeCompare(right)));
      const savedSuggestionCount = mappings.filter((mapping) => mapping.resolutionType === 'suggested').length;
      const savedMessage = savedSuggestionCount
        ? `Saved ${result.savedCount} reviewed mapping${result.savedCount === 1 ? '' : 's'} for ${topicResolverSubject}, ${topicResolverGrade}, including ${savedSuggestionCount} accepted Google Gemini suggestion${savedSuggestionCount === 1 ? '' : 's'}.`
        : `Saved ${result.savedCount} reviewed topic mapping${result.savedCount === 1 ? '' : 's'} for ${topicResolverSubject}, ${topicResolverGrade}.`;
      const catalogMessage = result.globalCatalogSynced
        ? ` Synced ${result.syncedTopicCount} distinct resolved topic${result.syncedTopicCount === 1 ? '' : 's'} to the global grade list; ${result.addedGlobalTopicCount} were newly added and duplicates were skipped.`
        : '';
      setTopicResolverStatus(`${savedMessage}${catalogMessage} Analyzed paper records were left unchanged.`);
    } catch (error) {
      setTopicResolverStatus(error.message || 'Could not save the topic mappings.');
    } finally {
      setTopicResolverSaveLoading(false);
    }
  };

  const visibleTopicResolverRows = topicResolverRows.filter((row) => {
    const searched = topicResolverSearch.trim().toLowerCase();
    if (!searched) return true;
    const selected = topicResolverCorrections[row.id] ?? row.suggestedTopic;
    return `${row.sourceTopic} ${selected} ${row.sources.join(' ')}`.toLowerCase().includes(searched);
  });


  const startEditPaper = (paper) => {
    setEditingPaper(paper);
    setEditForm({
      grade: paper.grade || SOUTH_AFRICAN_GRADES[0],
      region: paper.region || REGIONS[0],
      subject: paper.subject || DEFAULT_SUBJECT,
      year: paper.year || new Date().getFullYear(),
      month: paper.month || PAPER_MONTHS[0],
      paperNumber: paper.paperNumber || PAPER_NUMBERS[0],
      notes: paper.notes || '',
      paperFile: null,
      memoFile: null,
      removeMemo: false,
    });
  };

  const closeEditPaper = () => {
    setEditingPaper(null);
    setEditForm(null);
  };


  const queuePaperReanalysis = async (paper) => {
    if (!paper?.id) return;
    const succeeded = paper.analysisStatus === 'Analyzed' || paper.availableForGeneration;
    if (succeeded && !window.confirm(`This paper has already been analyzed. Run the analysis again for ${paper.displayName || paper.paperFileName || 'this paper'}?`)) return;
    const patch = {
      analysisStatus: 'Analyzing',
      availableForGeneration: false,
      analysisProgressMessage: 'Queued for re-analysis',
      analysisProgressCurrent: 0,
      analysisProgressTotal: 1,
      analysisError: '',
      analysisRevision: Date.now(),
      questions: [],
      topics: [],
      questionCount: 0,
      paperMetadata: {},
      paperAnalysisSummary: '',
      paperDocumentAnalysis: '',
      paperDocumentAnalysisModel: '',
      analysisVisionModels: [],
      analysisBatchOutputs: [],
    };
    setStatus(`Adding ${paper.displayName || paper.paperFileName || 'paper'} to the analysis queue...`);
    try {
      await runOperation({ operationName: 'Queuing paper analysis', successMessage: 'The paper was added to the analysis queue.' }, () => updateQuestionPaper(paper.id, patch));
      setPapers((current) => current.map((item) => item.id === paper.id ? { ...item, ...patch } : item));
      setStatus('Analysis retry queued. It will start immediately if the queue is idle; otherwise it will wait for earlier papers to finish.');
    } catch (error) {
      setStatus(error.message || 'Could not queue paper analysis.');
    }
  };

  const stopPaperAnalysis = async (paper) => {
    if (!paper?.id) return;
    if (!window.confirm(`Stop the analysis for ${paper.displayName || paper.paperFileName || 'this paper'}? Any queued work for this paper will be cancelled.`)) return;
    setStatus(`Stopping analysis for ${paper.displayName || paper.paperFileName || 'paper'}...`);
    try {
      await runOperation({ operationName: 'Stopping paper analysis', successMessage: 'Paper analysis was stopped.' }, () => cancelQuestionPaperAnalysis(paper.id));
    } catch (error) {
      setStatus(error.message || 'Could not stop paper analysis.');
      return;
    }
    const patch = {
      analysisStatus: 'Cancelled',
      analysisStage: 'Cancelled',
      analysisProgressMessage: 'Analysis stopped by user.',
      analysisError: '',
      activeAnalysisRunId: null,
      queuedAnalysisRunId: null,
      availableForGeneration: false,
    };
    setPapers((current) => current.map((item) => item.id === paper.id ? { ...item, ...patch } : item));
    setStatus('Analysis stopped.');
  };

  const handleEditSubmit = async (event) => {
    event.preventDefault();
    if (!editingPaper || !editForm) return;
    try {
      await runOperation({ operationName: 'Updating paper and uploaded documents', successMessage: 'The paper was updated successfully.' }, async () => {
      setStatus(`Updating ${editingPaper.displayName || editingPaper.paperFileName || 'paper'}...`);
      const uploads = editForm.paperFile || editForm.memoFile
        ? await uploadQuestionPaperDocuments({
          paperFile: editForm.paperFile,
          memoFile: editForm.memoFile,
          uploaderId: profile?.uid ?? 'anonymous',
          onProgress: (message) => setStatus(`Update: ${message}`),
        })
        : {};

      const metadataChanged = ['grade', 'region', 'subject', 'year', 'month', 'paperNumber', 'notes']
        .some((field) => String(editForm[field] ?? '') !== String(editingPaper[field] ?? ''));
      const fileChanged = Boolean(editForm.paperFile);
      const needsAnalysis = fileChanged;
      const displayName = `${editForm.subject} • ${editForm.grade} • ${editForm.region} • ${editForm.month} ${editForm.year} • ${editForm.paperNumber}${editingPaper.copySuffix ? ` ${editingPaper.copySuffix}` : ''}`;
      const patch = {
        grade: editForm.grade,
        region: editForm.region,
        subject: editForm.subject,
        year: Number(editForm.year),
        month: editForm.month,
        paperNumber: editForm.paperNumber,
        notes: editForm.notes,
        displayName,
        ...(metadataChanged ? {
          paperMetadata: {
            ...(editingPaper.paperMetadata ?? {}),
            year: Number(editForm.year) || null,
            month: editForm.month,
            subject: editForm.subject,
            grade: editForm.grade,
            region: editForm.region,
            paperNumber: editForm.paperNumber,
            copySuffix: editingPaper.copySuffix ?? '',
            paperTitle: displayName,
          },
        } : {}),
        ...(uploads.paperUrl ? { paperUrl: uploads.paperUrl, paperFileName: uploads.paperFileName, paperMimeType: uploads.paperMimeType } : {}),
        ...(editForm.removeMemo ? { memoUrl: '', memoFileName: '', memoMimeType: '' } : {}),
        ...(uploads.memoUrl ? { memoUrl: uploads.memoUrl, memoFileName: uploads.memoFileName, memoMimeType: uploads.memoMimeType } : {}),
        ...(needsAnalysis ? {
          analysisStatus: 'Analyzing',
          availableForGeneration: false,
          analysisProgressMessage: 'Queued for re-analysis',
          analysisProgressCurrent: 0,
          analysisProgressTotal: 1,
          analysisError: '',
          analysisRevision: Date.now(),
          questions: [],
          topics: [],
          questionCount: 0,
        } : {}),
      };
      await updateQuestionPaper(editingPaper.id, patch);
      setPapers((current) => current.map((paper) => paper.id === editingPaper.id ? { ...paper, ...patch } : paper));
      setStatus(needsAnalysis ? 'Paper file updated. Analysis is running again in the background.' : 'Paper metadata updated without re-analysis.');
      closeEditPaper();
      });
    } catch (error) {
      setStatus(error.message || 'Could not update paper.');
    }
  };

  const saveReviewedPaper = async ({ row, index, total }) => {
    setStatus(`Uploading paper ${index + 1}/${total}: ${row.paperFile.name}`);
    const uploads = await uploadQuestionPaperDocuments({
      paperFile: row.paperFile,
      memoFile: row.memoFile,
      uploaderId: profile?.uid ?? 'anonymous',
      onProgress: (message) => setStatus(`Paper ${index + 1}/${total}: ${message}`),
    });
    return saveQuestionPaper({
      grade: row.grade,
      region: row.region,
      subject: row.subject,
      year: Number(row.year),
      month: row.month,
      paperNumber: row.paperNumber,
      notes: row.notes,
      paperUrl: uploads.paperUrl,
      memoUrl: uploads.memoUrl,
      paperFileName: uploads.paperFileName,
      memoFileName: uploads.memoFileName,
      paperMimeType: uploads.paperMimeType,
      memoMimeType: uploads.memoMimeType,
      analysisStatus: 'Analyzing',
      availableForGeneration: false,
      analysisProgressMessage: 'Queued for analysis',
      analysisProgressCurrent: 0,
      analysisProgressTotal: 1,
      createdBy: profile?.uid ?? 'unknown',
      bulkUploadIndex: index + 1,
      bulkUploadTotal: total,
    });
  };

  const handleSingleSubmit = async (event) => {
    event.preventDefault();
    if (!singleForm.paperFile) {
      setStatus('Choose a question paper first.');
      return;
    }
    try {
      const saved = await runOperation({ operationName: 'Uploading and saving question paper', successMessage: 'The question paper was saved and queued for analysis.' }, () => saveReviewedPaper({ row: singleForm, index: 0, total: 1 }));
      setPapers((current) => [saved, ...current.filter((paper) => paper.id !== saved.id)]);
      setStatus('Past paper saved. Analysis is running in the background.');
      setSingleForm(defaultPaperForm(profile));
      event.target.reset();
    } catch (error) {
      setStatus(error.message || 'Could not save paper.');
    }
  };

  const loadDriveFolderContents = async (folderId = '', nextTrail = null) => {
    setDriveFolderLoading(true);
    setDriveImportMessage('');
    try {
      const contents = await getGoogleDrivePastPaperFolderContents(folderId);
      setDriveFolderContents(contents);
      setDriveFolderTrail(nextTrail ?? [{ id: contents.folder.id, name: contents.folder.name }]);
      return contents;
    } catch (error) {
      setDriveImportMessage(error.message || 'Could not load this Drive folder.');
      return null;
    } finally {
      setDriveFolderLoading(false);
    }
  };

  const handleToggleDriveExplorer = () => {
    if (driveExplorerOpen) {
      setDriveExplorerOpen(false);
      return;
    }
    setDriveExplorerOpen(true);
    if (!driveFolderContents) loadDriveFolderContents();
  };

  const handleDriveImport = async (paperGroup) => {
    const fileIds = paperGroup?.importFileIds ?? [];
    if (!driveFolderContents?.folder?.id || !fileIds.length) return;
    const selectedFolderId = driveFolderContents.folder.id;
    setDriveImportRunning(true);
    setDriveImportMessage('');
    let statusPollInFlight = false;
    let statusPollingStopped = false;
    const refreshImportStatuses = async () => {
      if (statusPollingStopped || statusPollInFlight) return;
      statusPollInFlight = true;
      try {
        const statuses = await getGoogleDrivePastPaperImportStatuses(fileIds);
        if (!statusPollingStopped) setDriveFolderContents((current) => mergeDriveImportStatuses(current, statuses));
      } catch {
        // The import itself remains authoritative; a later folder refresh will show its final status.
      } finally {
        statusPollInFlight = false;
      }
    };
    const statusPoll = window.setInterval(refreshImportStatuses, 2500);
    const stopStatusPolling = () => {
      statusPollingStopped = true;
      window.clearInterval(statusPoll);
    };
    void refreshImportStatuses();
    try {
      const result = await runOperation({
        operationName: 'Importing selected paper from Google Drive',
        successMessage: 'The Google Drive import run completed. Check the per-file statuses for the result.',
      }, () => startGoogleDrivePastPaperImport({ folderId: selectedFolderId, fileIds }));
      stopStatusPolling();
      if (result?.skipped && result.reason === 'already_running') {
        setDriveImportMessage('A Google Drive import is already running.');
      } else {
        const refreshed = await loadDriveFolderContents(selectedFolderId, driveFolderTrail);
        setDriveImportMessage(
          `Selected-folder import finished: ${result?.importedFiles ?? 0} file(s) added, ${result?.duplicateFiles ?? 0} duplicate(s), ${result?.waitingFiles ?? 0} waiting for a matching paper, ${result?.skippedFiles ?? 0} skipped because an import was already active or complete, ${result?.reviewFiles ?? 0} sent for review, ${result?.failedFiles ?? 0} failed.${refreshed ? '' : ' Folder status could not be refreshed.'}`,
        );
      }
    } catch (error) {
      setDriveImportMessage(error.message || 'Could not start the Google Drive import.');
    } finally {
      stopStatusPolling();
      setDriveImportRunning(false);
    }
  };

  const handleBulkFiles = (event) => {
    const files = Array.from(event.target.files ?? []);
    const result = buildBulkRows({ files, profile });
    setBulkRows(result.rows);
    setBulkMemoFiles(result.memoFiles);
    event.target.value = '';
    setStatus(result.rows.length
      ? `${result.rows.length} question paper${result.rows.length === 1 ? '' : 's'} prepared for review.${result.memoFiles.length ? ` ${result.memoFiles.length} memo file${result.memoFiles.length === 1 ? ' is' : 's are'} available to link.` : ''}`
      : result.memoFiles.length
        ? 'No question papers were detected. Memo files are ready to link after you add paper files.'
        : 'No question paper files were detected. Include paper files and optional memo files.');
  };

  const updateBulkRow = (id, patch) => setBulkRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const handleAddMoreBulkFiles = (event) => {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    const additions = buildBulkRows({ files, profile });
    const combinedRows = [...bulkRows, ...additions.rows];
    const candidates = [...bulkMemoFiles, ...additions.memoFiles];
    const paired = pairAvailableBulkMemos(combinedRows, candidates);
    setBulkRows(paired.rows);
    setBulkMemoFiles(paired.memoFiles);
    event.target.value = '';
    setStatus(`${additions.rows.length} paper${additions.rows.length === 1 ? '' : 's'} added from the new files and checked by the detector.${paired.memoFiles.length ? ` ${paired.memoFiles.length} memo file${paired.memoFiles.length === 1 ? ' is' : 's are'} available to link.` : ''}`);
  };

  const changeBulkMemo = (rowId, selectedFileId) => {
    const targetRow = bulkRows.find((row) => row.id === rowId);
    if (!targetRow || selectedFileId === targetRow.memoFileId) return;

    let sourceFile = null;
    let sourceRowId = '';
    let sourceRole = '';
    bulkRows.forEach((row) => {
      if (row.id !== rowId && row.paperFileId === selectedFileId) {
        sourceFile = row.paperFile;
        sourceRowId = row.id;
        sourceRole = 'paper';
      } else if (row.memoFileId === selectedFileId) {
        sourceFile = row.memoFile;
        sourceRowId = row.id === rowId ? '' : row.id;
        sourceRole = 'memo';
      }
    });
    const pooledEntry = bulkMemoFiles.find((entry) => entry.id === selectedFileId);
    if (pooledEntry) {
      sourceFile = pooledEntry.file;
      sourceRole = 'pool';
    }
    if (selectedFileId && !sourceFile) return;

    const nextRows = bulkRows.map((row) => ({ ...row }));
    const nextPool = [...bulkMemoFiles];
    const pushMemoToPool = (id, file) => {
      if (id && file && !nextPool.some((entry) => entry.id === id)) nextPool.push({ id, file });
    };
    if (targetRow.memoFileId) pushMemoToPool(targetRow.memoFileId, targetRow.memoFile);

    if (sourceRole === 'pool') {
      const poolIndex = nextPool.findIndex((entry) => entry.id === selectedFileId);
      if (poolIndex >= 0) nextPool.splice(poolIndex, 1);
    } else if (sourceRole === 'memo' && sourceRowId) {
      const sourceRow = nextRows.find((row) => row.id === sourceRowId);
      if (sourceRow) {
        sourceRow.memoFile = null;
        sourceRow.memoFileId = '';
      }
    } else if (sourceRole === 'paper' && sourceRowId) {
      const sourceRow = nextRows.find((row) => row.id === sourceRowId);
      if (sourceRow?.memoFileId) pushMemoToPool(sourceRow.memoFileId, sourceRow.memoFile);
      const sourceIndex = nextRows.findIndex((row) => row.id === sourceRowId);
      if (sourceIndex >= 0) nextRows.splice(sourceIndex, 1);
    }

    const nextTarget = nextRows.find((row) => row.id === rowId);
    if (nextTarget) {
      nextTarget.memoFile = sourceFile;
      nextTarget.memoFileId = selectedFileId;
    }
    setBulkRows(nextRows);
    setBulkMemoFiles(nextPool.filter((entry) => entry.id !== selectedFileId));
  };

  const addBulkMemoFile = (rowId, event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setStatus(`${file.name} is not a PDF. Memo files must be PDFs.`);
      return;
    }
    const entry = makeBulkFileEntry(file);
    const row = bulkRows.find((item) => item.id === rowId);
    if (!row) return;
    setBulkRows((current) => current.map((item) => item.id === rowId
      ? { ...item, memoFile: file, memoFileId: entry.id }
      : item));
    if (row.memoFileId && row.memoFile) {
      setBulkMemoFiles((current) => [...current.filter((item) => item.id !== row.memoFileId), { id: row.memoFileId, file: row.memoFile }]);
    }
    setStatus(`Memo ${file.name} added for ${row.paperFile.name}. It will not create a separate paper or trigger a second analysis.`);
  };

  const convertBulkMemoToPaper = (rowId) => {
    const row = bulkRows.find((item) => item.id === rowId);
    if (!row?.memoFile || !row.memoFileId) return;
    const newPaperRow = {
      id: row.memoFileId,
      paperFileId: row.memoFileId,
      paperFile: row.memoFile,
      memoFileId: '',
      memoFile: null,
      ...inferMetadataFromName(row.memoFile, profile),
      notes: '',
    };
    setBulkRows((current) => current.flatMap((item) => item.id === rowId
      ? [{ ...item, memoFile: null, memoFileId: '' }, newPaperRow]
      : [item]));
    setBulkMemoFiles((current) => current.filter((entry) => entry.id !== row.memoFileId));
    setStatus(`${newPaperRow.paperFile.name} is now a question paper and will be analyzed when the bulk upload is saved.`);
  };

  const removeBulkRow = (id) => {
    const row = bulkRows.find((item) => item.id === id);
    setBulkRows((current) => current.filter((item) => item.id !== id));
    if (row?.memoFileId && row.memoFile) {
      setBulkMemoFiles((current) => [...current.filter((entry) => entry.id !== row.memoFileId), { id: row.memoFileId, file: row.memoFile }]);
    }
  };

  const handleBulkSubmit = async () => {
    if (!bulkRows.length) {
      setStatus('Choose bulk files first.');
      return;
    }
    try {
      await runOperation({ operationName: `Uploading ${bulkRows.length} question papers`, successMessage: 'The question papers were saved and queued for analysis.' }, async () => {
        const saved = [];
        for (let index = 0; index < bulkRows.length; index += 1) {
          saved.push(await saveReviewedPaper({ row: bulkRows[index], index, total: bulkRows.length }));
        }
        setPapers((current) => [...saved, ...current.filter((paper) => !saved.some((item) => item.id === paper.id))]);
        setBulkRows([]);
        setBulkMemoFiles([]);
        setStatus(`${saved.length} paper${saved.length === 1 ? '' : 's'} saved. Papers will be analyzed one at a time in upload order.`);
      });
    } catch (error) {
      setStatus(error.message || 'Bulk upload failed.');
    }
  };

  const renderPaperCard = (paper) => (
    <div key={paper.id}>
      {role === ROLES.STUDENT ? (
        <div className="panel p-3 md:hidden">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="break-words text-sm font-semibold text-slate-950">{getPaperTitle(paper)}</h3>
              <span className="mt-2 inline-flex max-w-full truncate rounded-full border border-lime-400/20 bg-lime-400/10 px-2.5 py-1 text-xs font-medium text-lime-300">{getPaperField(paper, 'subject') || 'Subject not listed'}</span>
            </div>
            <button
              type="button"
              className="btn-secondary h-10 w-10 flex-none p-0"
              aria-label={`${expandedPaperIds[paper.id] ? 'Hide' : 'Show'} ${paper.displayName || 'paper'} details`}
              aria-expanded={Boolean(expandedPaperIds[paper.id])}
              title={expandedPaperIds[paper.id] ? 'Hide paper details' : 'Show paper details'}
              onClick={() => setExpandedPaperIds((current) => ({ ...current, [paper.id]: !current[paper.id] }))}
            >
              <ChevronDown className={`mx-auto h-4 w-4 transition-transform ${expandedPaperIds[paper.id] ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
          </div>
          {expandedPaperIds[paper.id] ? (
            <div className="mt-3 border-t border-slate-200 pt-3">
              <p className="text-xs text-slate-600">{getPaperField(paper, 'grade') || 'Grade not listed'} • {getPaperField(paper, 'region') || 'Region not listed'} • {getPaperField(paper, 'month')} {getPaperField(paper, 'year')} • {getPaperField(paper, 'paperNumber') || 'Paper 1'}</p>
              {paper.notes ? <p className="mt-2 text-sm text-slate-600">{paper.notes}</p> : null}
              <div className="mt-3 flex flex-wrap gap-2">
                {paper.paperUrl ? <Link className="btn-secondary" to={`/${role}/papers/${paper.id}?page=1`}>Paper</Link> : null}
                {paper.memoUrl ? <Link className="btn-secondary" to={`/${role}/papers/${paper.id}?document=memo&page=1`}>Memo</Link> : <span className="rounded-full bg-slate-50 px-3 py-2 text-sm text-slate-500">No memo uploaded</span>}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={`${role === ROLES.STUDENT ? 'hidden md:block ' : ''}panel p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-950">{paper.displayName || getPaperTitle(paper)}</h3>
            <p className="mt-1 text-sm text-slate-500">{paper.region} • {paper.month} {paper.year} • {paper.paperNumber ?? 'Paper 1'}</p>
          </div>
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-slate-600">{paper.subject}</span>
        </div>
        {role !== ROLES.STUDENT ? <PaperAnalysisStatus paper={paper} /> : null}
        <div className="mt-4 flex flex-wrap gap-3 text-sm">
          <Link className="btn-secondary" to={`/${role}/papers/${paper.id}?page=1`}>Open paper</Link>
          {paper.memoUrl ? <Link className="btn-secondary" to={`/${role}/papers/${paper.id}?document=memo&page=1`}>Open memo</Link> : <span className="rounded-full bg-slate-50 px-3 py-2 text-slate-500">No memo uploaded</span>}
          {canManagePaperAnalysis(role) ? <button type="button" className="btn-secondary" onClick={() => startEditPaper(paper)}>Edit</button> : null}
          {canManagePaperAnalysis(role) && canQueuePaperAnalysis(paper) ? <button type="button" className="btn-primary" onClick={() => queuePaperReanalysis(paper)}>{reanalysisButtonLabel(paper)}</button> : null}
          {canManagePaperAnalysis(role) && canStopPaperAnalysis(paper) ? <button type="button" className="btn-secondary text-rose-700 hover:text-rose-800" onClick={() => stopPaperAnalysis(paper).catch((error) => setStatus(error.message || 'Could not stop analysis.'))}>Stop analysis</button> : null}
        </div>
      </div>
    </div>
  );

  return (
    <AppShell title="Past exam papers" subtitle={canManagePaperAnalysis(role) ? 'Browse, upload, and manage question papers for analysis.' : 'Browse question papers and memoranda for your subjects.'} role={role} user={profile} onLogout={logout}>
      <SectionHeader
        eyebrow="Repository"
        title="Question papers"
        description={role === ROLES.STUDENT
          ? isStudentExploring
            ? 'Search and filter all Examifying question papers.'
            : 'Showing recent papers across all subjects. Search or filter to explore the full Examifying collection.'
          : role === ROLES.ADMIN
            ? 'Review papers grouped by analysis status. Each section has separate filters.'
            : 'Browse papers across all subjects. Use filters to narrow by subject or year.'}
      />
      {role === ROLES.ADMIN ? (
        <section className="panel mb-4 flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between" aria-label="Question-paper analysis queue controls">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-slate-900">Question-paper analysis queue</h2>
              {analysisQueueControlReady ? (
                <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${analysisQueuePaused
                  ? 'border-amber-300 bg-amber-100 text-amber-900'
                  : 'border-lime-300 bg-lime-100 text-lime-900'}`}>
                  {analysisQueuePaused ? 'Paused' : 'Running'}
                </span>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-slate-600">
              {analysisQueueControlReady
                ? analysisQueuePaused
                  ? analysisQueueActivePaperId
                    ? 'The current paper may finish. Remaining papers stay queued until you resume.'
                    : 'Queued papers are being held until you resume analysis.'
                  : 'Pause after the current paper finishes; queued papers will be kept.'
                : analysisQueueControlFailed
                  ? 'The queue status could not be loaded. Refresh the page before changing the queue.'
                  : 'Checking the analysis queue status…'}
            </p>
            {analysisQueueMessage ? <p className="mt-2 text-sm text-slate-700" role="status">{analysisQueueMessage}</p> : null}
          </div>
          <button
            type="button"
            className={analysisQueuePaused
              ? 'btn-primary inline-flex shrink-0 items-center justify-center gap-2'
              : 'btn-secondary inline-flex shrink-0 items-center justify-center gap-2'}
            disabled={!analysisQueueControlReady || analysisQueueControlSaving}
            onClick={handleToggleAnalysisQueue}
          >
            {analysisQueueControlSaving || (!analysisQueueControlReady && !analysisQueueControlFailed)
              ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              : analysisQueueControlFailed
                ? <RotateCcw className="h-4 w-4" aria-hidden="true" />
                : analysisQueuePaused
                ? <Play className="h-4 w-4" aria-hidden="true" />
                : <Pause className="h-4 w-4" aria-hidden="true" />}
            {analysisQueueControlSaving
              ? (analysisQueuePaused ? 'Resuming…' : 'Pausing…')
              : !analysisQueueControlReady
                ? analysisQueueControlFailed ? 'Status unavailable' : 'Loading status…'
                : analysisQueuePaused
                  ? 'Resume analysis'
                  : 'Pause analysis queue'}
          </button>
        </section>
      ) : null}
      {role === ROLES.ADMIN ? (
        <div className="panel !bg-transparent space-y-4 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold text-slate-900">Google Drive past-paper folders</h2>
              <p className="mt-1 text-sm text-slate-600">Browse one folder at a time, check paper and memo storage status, then import only the selected paper files.</p>
              {driveImportMessage ? <p className="mt-2 text-sm text-slate-700" role="status">{driveImportMessage}</p> : null}
            </div>
            <button
              type="button"
              className="btn-primary inline-flex shrink-0 items-center justify-center gap-2"
              disabled={driveFolderLoading || driveImportRunning}
              onClick={handleToggleDriveExplorer}
            >
              {driveFolderLoading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <HardDriveDownload className="h-4 w-4" aria-hidden="true" />}
              {driveExplorerOpen ? 'Close Drive browser' : 'Browse Drive folders'}
            </button>
          </div>
          {driveExplorerOpen ? (
            <div className="w-full space-y-4 border-t border-slate-200 pt-4">
              {driveFolderTrail.length ? (
                <nav aria-label="Google Drive folder path" className="flex flex-wrap items-center gap-1 text-sm">
                  {driveFolderTrail.map((folder, index) => (
                    <span key={folder.id} className="inline-flex items-center gap-1">
                      {index ? <ChevronRight className="h-4 w-4 text-slate-400" aria-hidden="true" /> : null}
                      <button
                        type="button"
                        className={`rounded px-1 py-0.5 ${index === driveFolderTrail.length - 1 ? 'font-semibold text-white' : 'text-lime-300 hover:bg-lime-300/10 hover:text-lime-100'}`}
                        onClick={() => loadDriveFolderContents(folder.id, driveFolderTrail.slice(0, index + 1))}
                      >
                        {folder.name}
                      </button>
                    </span>
                  ))}
                </nav>
              ) : null}
              {driveFolderLoading ? (
                <div className="flex items-center gap-2 py-5 text-sm text-slate-600"><LoaderCircle className="h-4 w-4 animate-spin text-lime-700" aria-hidden="true" />Loading folder contents…</div>
              ) : driveFolderContents ? (
                <>
                  {driveFolderContents.folders.length ? (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {driveFolderContents.folders.map((folder) => (
                        <button
                          key={folder.id}
                          type="button"
                          className="flex items-center gap-2 rounded-xl border border-lime-300/30 bg-transparent px-3 py-2.5 text-left text-sm font-medium text-slate-100 transition-colors hover:bg-lime-300/10 hover:text-white"
                          onClick={() => loadDriveFolderContents(folder.id, [...driveFolderTrail, folder])}
                        >
                          <Folder className="h-4 w-4 shrink-0 text-lime-300" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {driveFolderContents.papers.length ? (
                    <div className="overflow-x-auto rounded-xl border border-slate-700/80 bg-transparent">
                      <table className="min-w-[860px] w-full divide-y divide-slate-700 text-left text-sm">
                        <thead className="bg-transparent text-xs uppercase tracking-wide text-slate-300">
                          <tr>
                            <th className="px-4 py-3 font-semibold">Paper / Drive files</th>
                            <th className="px-4 py-3 font-semibold">Question paper</th>
                            <th className="px-4 py-3 font-semibold">Memo</th>
                            <th className="px-4 py-3 text-right font-semibold">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800 bg-transparent">
                          {driveFolderContents.papers.map((group) => {
                            const title = group.metadata
                              ? [group.metadata.subject, group.metadata.grade, group.metadata.region, group.metadata.year, group.metadata.paperNumber].filter(Boolean).join(' • ')
                              : group.files.map((file) => file.name).join(', ');
                            const questionName = group.questionFiles.map((file) => file.name).join(', ') || 'No question-paper PDF in this folder';
                            const memoName = group.memoFiles.map((file) => file.name).join(', ') || 'No memo PDF in this folder';
                            const statusBadge = (value, stage = '') => {
                              const styles = {
                                uploaded: 'bg-lime-100 text-lime-900',
                                analyzed: 'bg-lime-100 text-lime-900',
                                analyzing: 'bg-amber-100 text-amber-900',
                                importing: 'bg-lime-200 text-lime-950',
                                stalled: 'bg-amber-100 text-amber-900',
                                'import-failed': 'bg-rose-100 text-rose-800',
                                'analysis-failed': 'bg-rose-100 text-rose-800',
                                missing: 'bg-amber-100 text-amber-900',
                                waiting: 'bg-slate-100 text-slate-700',
                                review: 'bg-rose-100 text-rose-800',
                                'no-file': 'bg-slate-50 text-slate-500',
                              };
                              const labels = {
                                uploaded: 'Uploaded', analyzed: 'Analyzed', analyzing: 'Analyzing', importing: 'Importing', stalled: 'Import stalled',
                                'import-failed': 'Import failed', 'analysis-failed': 'Analysis failed', missing: 'Missing',
                                waiting: 'Waiting for paper', review: 'Review required', 'no-file': 'No memo here',
                              };
                              const detail = driveImportStageLabels[stage];
                              return <span title={detail} className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${styles[value] ?? styles.review}`}>{labels[value] ?? 'Review required'}</span>;
                            };
                            const questionImportStage = group.questionFiles.find((file) => ['importing', 'processing'].includes(file.importStatus))?.importStage;
                            const memoImportStage = group.memoFiles.find((file) => ['importing', 'processing'].includes(file.importStatus))?.importStage;
                            const groupIsImporting = group.paperStatus === 'importing' || group.memoStatus === 'importing';
                            return (
                              <tr key={group.identityKey} className="align-top transition-colors hover:bg-lime-300/5">
                                <td className="max-w-[22rem] px-4 py-3">
                                  <p className="font-semibold text-slate-900">{title}</p>
                                  {group.reviewReason ? <p className="mt-1 text-xs text-rose-300">{group.reviewReason}</p> : null}
                                </td>
                                <td className="max-w-[20rem] px-4 py-3">
                                  <div className="flex items-start gap-2"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" /><span className="break-words text-slate-700">{questionName}</span></div>
                                  <div className="mt-2">{statusBadge(group.paperStatus, questionImportStage)}</div>
                                </td>
                                <td className="max-w-[20rem] px-4 py-3">
                                  <div className="flex items-start gap-2"><FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" /><span className="break-words text-slate-700">{memoName}</span></div>
                                  <div className="mt-2">{statusBadge(group.memoStatus, memoImportStage)}</div>
                                </td>
                                <td className="px-4 py-3 text-right">
                                  {groupIsImporting ? (
                                    <span className="inline-flex items-center gap-2 text-xs font-semibold text-lime-800"><LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />Importing…</span>
                                  ) : group.importFileIds.length ? (
                                    <button type="button" className="btn-primary whitespace-nowrap" disabled={driveImportRunning} onClick={() => handleDriveImport(group)}>
                                      {driveImportRunning ? 'Importing…' : 'Import missing files'}
                                    </button>
                                  ) : group.reviewReason ? (
                                    <span className="text-xs font-medium text-rose-300">Review first</span>
                                  ) : ['uploaded', 'analyzing', 'analyzed'].includes(group.paperStatus) && ['uploaded', 'analyzing', 'analyzed', 'no-file'].includes(group.memoStatus) ? (
                                    <span className="text-xs font-medium text-lime-300">Up to date</span>
                                  ) : (
                                    <span className="text-xs text-slate-500">No import available</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : !driveFolderContents.folders.length ? (
                    <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-600">This folder has no PDF papers, memos, or subfolders.</p>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {role === ROLES.STUDENT ? (
        <div className="panel grid gap-3 p-4">
          <label className="relative block">
            <span className="sr-only">Search all question papers</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              className="input pl-10"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search by year, subject, grade, region, paper..."
            />
          </label>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <select aria-label="Filter by subject" className="input" value={studentFilterValues.subject} onChange={(event) => updateStudentFilter('subject', event.target.value)}>
              <option value="all">All subjects</option>
              {paperSubjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
            </select>
            <select aria-label="Filter by grade" className="input" value={studentFilterValues.grade} onChange={(event) => updateStudentFilter('grade', event.target.value)}>
              <option value="all">All grades</option>
              {grades.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
            </select>
            <select aria-label="Filter by year" className="input" value={studentFilterValues.year} onChange={(event) => updateStudentFilter('year', event.target.value)}>
              <option value="all">All years</option>
              {years.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
            <select aria-label="Filter by region" className="input" value={studentFilterValues.region} onChange={(event) => updateStudentFilter('region', event.target.value)}>
              <option value="all">All regions</option>
              {regions.map((region) => <option key={region} value={region}>{region}</option>)}
            </select>
            <select aria-label="Filter by month" className="input" value={studentFilterValues.month} onChange={(event) => updateStudentFilter('month', event.target.value)}>
              <option value="all">All months</option>
              {months.map((month) => <option key={month} value={month}>{month}</option>)}
            </select>
            <select aria-label="Filter by paper number" className="input" value={studentFilterValues.paperNumber} onChange={(event) => updateStudentFilter('paperNumber', event.target.value)}>
              <option value="all">All papers</option>
              {paperNumbers.map((paperNumber) => <option key={paperNumber} value={paperNumber}>{paperNumber}</option>)}
            </select>
          </div>
          {isStudentExploring ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-3">
              <p className="text-sm text-slate-500">{visiblePapers.length} matching paper{visiblePapers.length === 1 ? '' : 's'}</p>
              <button type="button" className="btn-secondary inline-flex items-center gap-2" onClick={resetStudentFilters}>
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Reset filters
              </button>
            </div>
          ) : null}
        </div>
      ) : role !== ROLES.ADMIN ? (
        <div className="panel grid gap-3 p-4 md:grid-cols-2">
          <select className="input" value={filters.subject} onChange={(event) => setFilters((current) => ({ ...current, subject: event.target.value }))}>
            <option value="all">All subjects</option>
            {paperSubjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
          </select>
          <select className="input" value={filters.year} onChange={(event) => setFilters((current) => ({ ...current, year: event.target.value }))}>
            <option value="all">All years</option>
            {years.map((year) => <option key={year} value={year}>{year}</option>)}
          </select>
        </div>
      ) : null}
      {role === ROLES.STUDENT && !isStudentExploring ? <p className="text-xs text-slate-500">Showing up to 20 recent papers across all subjects. Search or select a filter to browse all matching results.</p> : null}

      {role === ROLES.ADMIN ? (
        <div className="space-y-4">
          {[
            { key: 'analyzing', title: 'Analyzing', emptyMessage: 'No papers are currently analyzing.' },
            { key: 'analyzed', title: 'Analyzed', emptyMessage: 'No completed paper analyses.' },
            { key: 'failed', title: 'Failed', emptyMessage: 'No failed or cancelled paper analyses.' },
          ].map(({ key, title, emptyMessage }) => {
            const sectionPapers = adminPaperGroups[key];
            const sectionFilter = adminPaperFilters[key];
            const sectionSubjects = paperSubjects;
            const sectionYears = [...new Set(sectionPapers.map((paper) => getPaperField(paper, 'year')).filter(Boolean))]
              .sort((left, right) => Number(right) - Number(left));
            const searchTokens = sectionFilter.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
            const filteredSectionPapers = sectionPapers.filter((paper) => {
              const matchesSubject = sectionFilter.subject === 'all' || normalizePaperSubject(getPaperSubject(paper)) === normalizePaperSubject(sectionFilter.subject);
              const matchesYear = sectionFilter.year === 'all' || String(getPaperField(paper, 'year')) === String(sectionFilter.year);
              const searchText = getPaperSearchText(paper);
              return matchesSubject && matchesYear && searchTokens.every((token) => searchText.includes(token));
            });

            return (
              <details key={key} className="panel overflow-hidden">
                <summary className="cursor-pointer list-none px-5 py-4 marker:hidden [&::-webkit-details-marker]:hidden">
                  <span className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-lg font-semibold text-slate-950">{title}</span>
                    <span className="flex items-center gap-3">
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">{sectionPapers.length} paper{sectionPapers.length === 1 ? '' : 's'}</span>
                      <ChevronDown className="h-4 w-4 text-slate-500" aria-hidden="true" />
                    </span>
                  </span>
                </summary>
                <div className="space-y-4 border-t border-slate-200 p-4 md:p-5">
                  <div className="grid gap-3 md:grid-cols-[minmax(12rem,2fr)_minmax(10rem,1fr)_minmax(8rem,1fr)]">
                    <label>
                      <span className="sr-only">Search {title.toLowerCase()} papers</span>
                      <input
                        type="search"
                        className="input"
                        value={sectionFilter.search}
                        onChange={(event) => updateAdminPaperFilter(key, 'search', event.target.value)}
                        placeholder={`Search ${title.toLowerCase()} papers`}
                      />
                    </label>
                    <select aria-label={`Filter ${title.toLowerCase()} papers by subject`} className="input" value={sectionFilter.subject} onChange={(event) => updateAdminPaperFilter(key, 'subject', event.target.value)}>
                      <option value="all">All subjects</option>
                      {sectionSubjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
                    </select>
                    <select aria-label={`Filter ${title.toLowerCase()} papers by year`} className="input" value={sectionFilter.year} onChange={(event) => updateAdminPaperFilter(key, 'year', event.target.value)}>
                      <option value="all">All years</option>
                      {sectionYears.map((year) => <option key={year} value={year}>{year}</option>)}
                    </select>
                  </div>
                  {isLoadingPapers ? <LoadingState label={`Loading ${title.toLowerCase()} papers…`} /> : filteredSectionPapers.length ? (
                    <div className="space-y-4">{filteredSectionPapers.map(renderPaperCard)}</div>
                  ) : (
                    <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-500">
                      {sectionPapers.length ? 'No papers match these filters.' : emptyMessage}
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      ) : (
        <div className="space-y-4">
          {visiblePapers.map(renderPaperCard)}
          {isLoadingPapers ? <LoadingState label="Loading past papers…" /> : null}
          {!isLoadingPapers && !status && !visiblePapers.length ? <div className="panel p-5 text-sm text-slate-500">No papers match these filters.</div> : null}
        </div>
      )}

      {canManagePaperAnalysis(role) ? <section className="panel space-y-5 p-6">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={uploadTab === 'single' ? 'btn-primary' : 'btn-secondary'} onClick={() => setUploadTab('single')}>Single upload</button>
          <button type="button" className={uploadTab === 'bulk' ? 'btn-primary' : 'btn-secondary'} onClick={() => setUploadTab('bulk')}>Bulk upload</button>
        </div>

        {uploadTab === 'single' ? (
          <form onSubmit={handleSingleSubmit} className="grid gap-4 md:grid-cols-2">
            <UploadFields value={singleForm} onChange={(patch) => setSingleForm((current) => ({ ...current, ...patch }))} subjects={visibleSubjects} />
            <label className="md:col-span-2"><span className="label">Question paper</span><input type="file" className="input" accept=".pdf,application/pdf" onChange={(event) => setSingleForm((current) => ({ ...current, paperFile: event.target.files?.[0] ?? null }))} required /><span className="mt-1 block text-xs text-slate-500">PDF only. Analysis runs securely in queued page batches.</span></label>
            <label className="md:col-span-2"><span className="label">Memo optional</span><input type="file" className="input" accept=".pdf,application/pdf" onChange={(event) => setSingleForm((current) => ({ ...current, memoFile: event.target.files?.[0] ?? null }))} /></label>
            <button type="submit" className="btn-primary md:col-span-2">Upload and analyze</button>
          </form>
        ) : (
          <div className="space-y-4">
            <label className="block"><span className="label">Bulk files</span><input type="file" className="input" multiple accept=".pdf,application/pdf" onChange={handleBulkFiles} /><span className="mt-1 block text-xs text-slate-500">Select PDF question papers and optional PDF memos together. The detector checks each file, then pairs likely memos by filename. You can correct the file roles in the table.</span></label>
            {bulkRows.length ? (
              <div className="w-full overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/90">
                <div className="overflow-x-auto overscroll-x-contain">
                  <table className="min-w-[1390px] border-collapse text-left text-sm">
                    <thead className="bg-slate-800 text-xs uppercase tracking-[0.2em] text-slate-400">
                      <tr>
                        <th className="w-12 px-4 py-3 font-semibold">#</th>
                        <th className="min-w-64 px-4 py-3 font-semibold">Question paper</th>
                        <th className="min-w-56 px-4 py-3 font-semibold">Linked memo</th>
                        <th className="min-w-56 px-4 py-3 font-semibold">Subject</th>
                        <th className="min-w-40 px-4 py-3 font-semibold">Grade</th>
                        <th className="min-w-44 px-4 py-3 font-semibold">Region</th>
                        <th className="min-w-32 px-4 py-3 font-semibold">Year</th>
                        <th className="min-w-40 px-4 py-3 font-semibold">Month</th>
                        <th className="min-w-40 px-4 py-3 font-semibold">Paper</th>
                        <th className="min-w-64 px-4 py-3 font-semibold">Notes</th>
                        <th className="min-w-48 px-4 py-3 font-semibold">Preview</th>
                        <th className="min-w-52 px-4 py-3 font-semibold">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {bulkRows.map((row, index) => {
                        const memoOptions = [
                          ...bulkMemoFiles,
                          ...bulkRows.filter((sourceRow) => sourceRow.memoFileId).map((sourceRow) => ({ id: sourceRow.memoFileId, file: sourceRow.memoFile })),
                        ].filter((entry, optionIndex, entries) => entry.id && entry.file && entries.findIndex((candidate) => candidate.id === entry.id) === optionIndex);
                        return (
                        <tr key={row.id} className="align-top">
                          <td className="px-4 py-3 font-semibold text-slate-500">{index + 1}</td>
                          <td className="px-4 py-3"><p className="font-semibold text-slate-950">{row.paperFile.name}</p><p className="mt-1 text-xs text-slate-500">{Math.round((row.paperFile.size || 0) / 1024)} KB</p></td>
                          <td className="px-4 py-3">
                            <select className="input min-w-52" aria-label={`Memo for ${row.paperFile.name}`} value={row.memoFileId ?? ''} onChange={(event) => changeBulkMemo(row.id, event.target.value)}>
                              <option value="">No memo linked</option>
                              {memoOptions.map((entry) => <option key={`${row.id}-${entry.id}`} value={entry.id}>{entry.file.name}{entry.id === row.memoFileId ? ' (linked)' : ' (memo)'}</option>)}
                              {bulkRows.filter((sourceRow) => sourceRow.id !== row.id).map((sourceRow) => <option key={`${row.id}-paper-${sourceRow.paperFileId}`} value={sourceRow.paperFileId}>{sourceRow.paperFile.name} (currently a paper; selecting moves it to memo)</option>)}
                            </select>
                          </td>
                          <td className="px-4 py-3"><select className="input min-w-52" value={row.subject} onChange={(event) => updateBulkRow(row.id, { subject: event.target.value })}>{visibleSubjects.map((subject) => <option key={subject}>{subject}</option>)}</select></td>
                          <td className="px-4 py-3"><select className="input min-w-36" value={row.grade} onChange={(event) => updateBulkRow(row.id, { grade: event.target.value })}>{SOUTH_AFRICAN_GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select></td>
                          <td className="px-4 py-3"><select className="input min-w-40" value={row.region} onChange={(event) => updateBulkRow(row.id, { region: event.target.value })}>{REGIONS.map((region) => <option key={region}>{region}</option>)}</select></td>
                          <td className="px-4 py-3"><input type="number" min="2000" max="2100" className="input min-w-28" value={row.year} onChange={(event) => updateBulkRow(row.id, { year: event.target.value })} /></td>
                          <td className="px-4 py-3"><select className="input min-w-36" value={row.month} onChange={(event) => updateBulkRow(row.id, { month: event.target.value })}>{PAPER_MONTHS.map((month) => <option key={month}>{month}</option>)}</select></td>
                          <td className="px-4 py-3"><select className="input min-w-36" value={row.paperNumber} onChange={(event) => updateBulkRow(row.id, { paperNumber: event.target.value })}>{PAPER_NUMBERS.map((paperNumber) => <option key={paperNumber}>{paperNumber}</option>)}</select></td>
                          <td className="px-4 py-3"><input className="input min-w-60" value={row.notes} onChange={(event) => updateBulkRow(row.id, { notes: event.target.value })} placeholder="Optional notes" /></td>
                          <td className="px-4 py-3">
                            <div className="flex min-w-44 flex-wrap gap-2">
                              <button type="button" className="btn-secondary text-xs" onClick={() => openLocalFilePreview(row.paperFile)}>Open paper</button>
                              <button type="button" className="btn-secondary text-xs" onClick={() => openLocalFilePreview(row.memoFile)} disabled={!row.memoFile}>Open memo</button>
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex min-w-48 flex-col items-start gap-2">
                              <label className="btn-secondary cursor-pointer text-xs">
                                {row.memoFile ? 'Replace memo file' : 'Upload memo file'}
                                <input type="file" className="sr-only" accept=".pdf,application/pdf" onChange={(event) => addBulkMemoFile(row.id, event)} />
                              </label>
                              <button type="button" className="btn-secondary text-xs" onClick={() => convertBulkMemoToPaper(row.id)} disabled={!row.memoFile}>Convert memo to paper</button>
                              <button type="button" className="btn-secondary text-xs" onClick={() => removeBulkRow(row.id)}>Remove paper</button>
                            </div>
                          </td>
                        </tr>
                      ); })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
            <input ref={bulkAdditionalInputRef} type="file" className="sr-only" multiple accept=".pdf,application/pdf" onChange={handleAddMoreBulkFiles} />
            <button type="button" className="btn-secondary w-full" onClick={() => bulkAdditionalInputRef.current?.click()}>Add more papers or memos</button>
            {bulkRows.length ? <button type="button" className="btn-primary w-full" onClick={handleBulkSubmit}>Upload reviewed papers</button> : null}
          </div>
        )}
        {status ? <p className="text-sm text-slate-600">{status}</p> : null}
      </section> : null}

      {canManagePaperAnalysis(role) && editingPaper && editForm ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={handleEditSubmit} className="panel max-h-[90dvh] w-full max-w-4xl overflow-y-auto p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-700">Edit paper</p>
                <h2 className="mt-2 text-2xl font-bold text-slate-950">{editingPaper.displayName || editingPaper.paperFileName || 'Question paper'}</h2>
                <p className="mt-1 text-sm text-slate-500">Replacing the question-paper file queues it for analysis again. Memo and metadata changes save without re-analysis.</p>
              </div>
              <button type="button" className="btn-secondary" onClick={closeEditPaper}>Close</button>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <UploadFields value={editForm} onChange={(patch) => setEditForm((current) => ({ ...current, ...patch }))} subjects={visibleSubjects} />
              <label className="md:col-span-2"><span className="label">Replace question paper optional</span><input type="file" className="input" accept=".pdf,application/pdf" onChange={(event) => setEditForm((current) => ({ ...current, paperFile: event.target.files?.[0] ?? null }))} /><span className="mt-1 block text-xs text-slate-500">PDF only. Current: {editingPaper.paperFileName || 'No paper file name stored'}</span></label>
              <label className="md:col-span-2"><span className="label">Replace memorandum optional</span><input type="file" className="input" accept=".pdf,application/pdf" onChange={(event) => setEditForm((current) => ({ ...current, memoFile: event.target.files?.[0] ?? null, removeMemo: false }))} /><span className="mt-1 block text-xs text-slate-500">PDF only. Current: {editingPaper.memoFileName || 'No memo uploaded'}</span></label>
              {editingPaper.memoUrl ? <label className="md:col-span-2 flex items-center gap-3 text-sm font-semibold text-slate-700"><input type="checkbox" checked={editForm.removeMemo} onChange={(event) => setEditForm((current) => ({ ...current, removeMemo: event.target.checked, memoFile: event.target.checked ? null : current.memoFile }))} /> Remove current memorandum</label> : null}
              <div className="flex flex-wrap gap-3 md:col-span-2">
                <button type="submit" className="btn-primary">Save metadata changes</button>
                {canManagePaperAnalysis(role) && canQueuePaperAnalysis(editingPaper) ? <button type="button" className="btn-secondary" onClick={() => queuePaperReanalysis(editingPaper).then(closeEditPaper).catch((error) => setStatus(error.message || 'Could not retry analysis.'))}>{reanalysisButtonLabel(editingPaper)}</button> : null}
              </div>
            </div>
          </form>
        </div>
      ) : null}
      {role === ROLES.ADMIN && topicResolverOpen ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center overflow-y-auto overscroll-contain bg-slate-950/70 p-3 md:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !topicResolverLoading && !topicResolverGeminiLoading && !topicResolverSaveLoading && !topicResolverCleanupLoading) setTopicResolverOpen(false); }}>
          <section className="panel flex h-[calc(100dvh-1.5rem)] max-h-[calc(100dvh-1.5rem)] min-h-0 w-full max-w-7xl flex-col overflow-hidden border-slate-700 bg-slate-900 p-4 md:h-[calc(100dvh-3rem)] md:max-h-[calc(100dvh-3rem)] md:p-6" role="dialog" aria-modal="true" aria-labelledby="topic-resolver-title">
            <div className="flex shrink-0 items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lime-400">Admin review</p>
                <h2 id="topic-resolver-title" className="mt-2 text-xl font-bold text-white md:text-2xl">Topic resolver preview</h2>
                <p className="mt-2 max-w-3xl text-sm text-slate-300">Review Firestore topic matches and Google Gemini suggestions for one subject and grade. Saving reviewed mappings also copies each distinct resolved Child | Parent label into that grade’s global topic list. Duplicate labels are skipped; analyzed paper records are not changed.</p>
              </div>
              <button type="button" className="btn-secondary h-10 w-10 flex-none p-0" aria-label="Close topic resolver" title="Close" onClick={() => setTopicResolverOpen(false)} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading}><X className="mx-auto h-4 w-4" /></button>
            </div>

            <div className="topic-resolver-scroll mt-5 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2" aria-label="Topic resolver results and controls" tabIndex={0}>
            <div className="grid shrink-0 gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_auto_auto]">
              <label className="grid gap-2 text-sm font-semibold text-slate-200">Subject
                  <select className="input" value={topicResolverSubject} onChange={(event) => { setTopicResolverSubject(event.target.value); setTopicResolverRows([]); setTopicResolverCatalog([]); setTopicResolverCorrections({}); setTopicResolverMethods({}); setTopicResolverReviewed(false); }} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading}>
                  <option value="">Choose subject</option>
                  {SUBJECTS.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
                </select>
              </label>
              <label className="grid gap-2 text-sm font-semibold text-slate-200">Grade
                  <select className="input" value={topicResolverGrade} onChange={(event) => { setTopicResolverGrade(event.target.value); setTopicResolverRows([]); setTopicResolverCatalog([]); setTopicResolverCorrections({}); setTopicResolverMethods({}); setTopicResolverReviewed(false); }} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading}>
                  <option value="">Choose grade</option>
                  {SOUTH_AFRICAN_GRADES.filter((grade) => grade !== 'Select Grade').map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                </select>
              </label>
              <button type="button" className="btn-primary inline-flex items-center justify-center gap-2 self-end" onClick={searchTopicResolver} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading || !topicResolverSubject || !topicResolverGrade}>
                {topicResolverLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Search Firestore
              </button>
              <button type="button" className="btn-secondary inline-flex items-center justify-center gap-2 self-end" onClick={checkGlobalTopicCatalog} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || topicResolverCleanupLoading || !topicResolverSubject || !topicResolverGrade}>
                {topicResolverCleanupLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
                Check global topics
              </button>
            </div>

            {topicResolverRows.length ? (
              <div className="mt-4 grid shrink-0 gap-3 md:grid-cols-[1fr_auto_auto] md:items-center">
                <label className="relative block">
                  <span className="sr-only">Search topic names in results</span>
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
                  <input type="search" className="input pl-10" value={topicResolverSearch} onChange={(event) => setTopicResolverSearch(event.target.value)} placeholder="Search extracted topic names" />
                </label>
                <p className="text-sm text-slate-300">{resolvedTopicRows.length - suggestedTopicRows.length} mapped • {suggestedTopicRows.length} Google Gemini suggestions • {unresolvedTopicRows.length} unresolved</p>
                <button type="button" className="btn-secondary inline-flex items-center justify-center gap-2" onClick={resolveUnmappedTopicsWithGemini} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || !unresolvedTopicRows.length}>
                  {topicResolverGeminiLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Resolve with Gemini
                </button>
              </div>
            ) : null}

            {topicResolverStatus ? <p className="mt-3 shrink-0 text-sm text-slate-300" role="status">{topicResolverStatus}</p> : null}

            {topicResolverRows.length ? (
              <div className="topic-resolver-table-scroll mt-4 overflow-x-auto rounded-lg border border-slate-700">
                  <table className="min-w-[1050px] border-collapse text-left text-sm">
                    <thead className="sticky top-0 bg-slate-800 text-xs uppercase text-slate-300">
                      <tr>
                        <th className="px-3 py-3">Raw topic</th>
                        <th className="px-3 py-3">Suggested / reviewed topic</th>
                        <th className="px-3 py-3">Match</th>
                        <th className="px-3 py-3">Occurrences</th>
                        <th className="px-3 py-3">Found in</th>
                        <th className="min-w-64 px-3 py-3">Sample records</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700 text-slate-100">
                      {visibleTopicResolverRows.map((row) => {
                        const catalog = topicResolverCatalog;
                        const currentValue = currentResolverValue(row);
                        const wasCorrected = Object.hasOwn(topicResolverCorrections, row.id);
                        const matchMethod = topicResolverMethods[row.id] ?? (wasCorrected ? 'manual' : row.matchType);
                        const isGeminiSuggestion = matchMethod === 'gemini-suggested' || matchMethod === 'saved-suggestion';
                        const matchClass = isGeminiSuggestion
                          ? 'bg-amber-400/15 text-amber-200'
                          : matchMethod === 'gemini'
                            ? 'bg-sky-400/15 text-sky-200'
                            : currentValue
                              ? 'bg-lime-400/15 text-lime-200'
                              : 'bg-amber-400/15 text-amber-200';
                        const matchLabel = matchMethod === 'gemini-suggested'
                          ? 'Google Gemini suggestion — review'
                          : matchMethod === 'saved-suggestion'
                            ? 'Saved Google Gemini suggestion'
                            : matchMethod === 'gemini'
                              ? 'Gemini match'
                              : matchMethod === 'manual'
                                ? 'Admin edit'
                                : currentValue
                                  ? matchMethod
                                  : 'Needs review';
                        return (
                          <tr key={row.id} className="align-top">
                            <td className="max-w-64 px-3 py-3 font-medium">{row.sourceTopic}</td>
                            <td className="px-3 py-3">
                              <select className="input min-w-80" value={currentValue} onChange={(event) => { const isSuggestedValue = event.target.value === currentValue && !catalog.includes(event.target.value); setTopicResolverCorrections((current) => ({ ...current, [row.id]: event.target.value })); setTopicResolverMethods((current) => ({ ...current, [row.id]: isSuggestedValue ? 'gemini-suggested' : 'manual' })); setTopicResolverReviewed(false); }} disabled={topicResolverGeminiLoading || topicResolverSaveLoading}>
                                <option value="">Needs manual mapping</option>
                                {currentValue && !catalog.includes(currentValue) ? <option value={currentValue}>{currentValue} · Google Gemini suggestion</option> : null}
                                {catalog.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                              </select>
                            </td>
                            <td className="px-3 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${matchClass}`}>{matchLabel}</span></td>
                            <td className="px-3 py-3 tabular-nums">{row.occurrenceCount}</td>
                            <td className="px-3 py-3">{row.sources.map((source) => <span key={source} className="mr-1 inline-block rounded bg-slate-800 px-2 py-1 text-xs">{source === 'paper' ? 'Papers' : 'Lessons'}</span>)}</td>
                            <td className="px-3 py-3 text-xs text-slate-300">{row.sourceExamples.join(' • ') || '—'}</td>
                          </tr>
                        );
                      })}
                      {!visibleTopicResolverRows.length ? <tr><td colSpan="6" className="px-3 py-8 text-center text-slate-400">No topic names match that search.</td></tr> : null}
                    </tbody>
                  </table>
              </div>
            ) : null}
            </div>
            <div className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-slate-700 pt-4">
              <label className="flex items-start gap-2 text-xs text-slate-300">
                <input type="checkbox" checked={topicResolverReviewed} onChange={(event) => setTopicResolverReviewed(event.target.checked)} disabled={Boolean(unresolvedTopicRows.length) || topicResolverGeminiLoading || topicResolverSaveLoading} />
                <span>{unresolvedTopicRows.length ? `${unresolvedTopicRows.length} topics still need mappings.` : `I reviewed and confirmed every topic mapping${suggestedTopicRows.length ? `, including ${suggestedTopicRows.length} Google Gemini suggestion${suggestedTopicRows.length === 1 ? '' : 's'}` : ''}.`}</span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-secondary" onClick={() => { setTopicResolverRows([]); setTopicResolverCorrections({}); setTopicResolverMethods({}); setTopicResolverReviewed(false); setTopicResolverSearch(''); setTopicResolverStatus('Select a subject and grade to search.'); }} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading}>Clear results</button>
                <button type="button" className="btn-primary inline-flex items-center justify-center gap-2" onClick={saveReviewedTopicMappings} disabled={topicResolverLoading || topicResolverGeminiLoading || topicResolverSaveLoading || !topicResolverRows.length || unresolvedTopicRows.length > 0 || !topicResolverReviewed}>
                  {topicResolverSaveLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save mappings & sync topics
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
};

const UploadFields = ({ value, onChange, subjects, compact = false }) => (
  <>
    <label className={compact ? '' : ''}><span className="label">Subject</span><select className="input" value={value.subject} onChange={(event) => onChange({ subject: event.target.value })}>{subjects.map((subject) => <option key={subject}>{subject}</option>)}</select></label>
    <label><span className="label">Grade</span><select className="input" value={value.grade} onChange={(event) => onChange({ grade: event.target.value })}>{SOUTH_AFRICAN_GRADES.map((grade) => <option key={grade}>{grade}</option>)}</select></label>
    <label><span className="label">Region</span><select className="input" value={value.region} onChange={(event) => onChange({ region: event.target.value })}>{REGIONS.map((region) => <option key={region}>{region}</option>)}</select></label>
    <label><span className="label">Year</span><input type="number" min="2000" max="2100" className="input" value={value.year} onChange={(event) => onChange({ year: event.target.value })} /></label>
    <label><span className="label">Month</span><select className="input" value={value.month} onChange={(event) => onChange({ month: event.target.value })}>
      {value.month && !PAPER_MONTHS.includes(value.month) ? <option value={value.month}>{value.month} (existing record)</option> : null}
      {PAPER_MONTHS.map((month) => <option key={month}>{month}</option>)}
    </select></label>
    <label><span className="label">Paper number</span><select className="input" value={value.paperNumber} onChange={(event) => onChange({ paperNumber: event.target.value })}>
      {value.paperNumber && !PAPER_NUMBERS.includes(value.paperNumber) ? <option value={value.paperNumber}>{value.paperNumber} (existing record)</option> : null}
      {PAPER_NUMBERS.map((paperNumber) => <option key={paperNumber}>{paperNumber}</option>)}
    </select></label>
    {!compact ? <label className="md:col-span-2"><span className="label">Notes</span><textarea className="input min-h-24" value={value.notes} onChange={(event) => onChange({ notes: event.target.value })} /></label> : <label className="md:col-span-3"><span className="label">Notes</span><input className="input" value={value.notes} onChange={(event) => onChange({ notes: event.target.value })} /></label>}
  </>
);
