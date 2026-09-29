import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/common/AppShell';
import { SectionHeader } from '../components/common/SectionHeader';
import { useAuth } from '../hooks/useAuth';
import { DEFAULT_SUBJECT, PAPER_MONTHS, PAPER_NUMBERS, REGIONS, ROLES, SOUTH_AFRICAN_GRADES, SUBJECTS } from '../lib/constants';
import { saveQuestionPaper, subscribeQuestionPapers, updateQuestionPaper } from '../services/firestoreService';
import { uploadQuestionPaperDocuments } from '../services/storageService';
import { getApprovedTutorSubjects, getUserSubjects } from '../utils/tutorSubjects';

const paperStatusStyles = {
  Analyzing: 'bg-amber-50 text-amber-700',
  Analyzed: 'bg-emerald-50 text-emerald-700',
  Failed: 'bg-rose-50 text-rose-700',
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
const overlapScore = (leftFile, rightFile) => {
  const left = fileTokens(leftFile);
  const right = fileTokens(rightFile);
  return [...left].filter((token) => right.has(token)).length;
};

const inferMetadataFromName = (file, profile) => {
  const name = file?.name ?? '';
  const lower = name.toLowerCase();
  const year = Number(lower.match(/\b(20\d{2}|19\d{2})\b/)?.[1]) || new Date().getFullYear();
  const month = PAPER_MONTHS.find((item) => lower.includes(item.toLowerCase())) ?? PAPER_MONTHS[0];
  const paperNumber = PAPER_NUMBERS.find((item) => {
    const number = item.match(/\d/)?.[0];
    return number && new RegExp(`(?:paper|p|paper\\s*)\\s*${number}|${number}[^0-9]*paper`, 'i').test(name);
  }) ?? PAPER_NUMBERS[0];
  const subject = SUBJECTS.find((item) => lower.includes(item.toLowerCase().replace(/\s+/g, ' '))) ?? DEFAULT_SUBJECT;
  const grade = SOUTH_AFRICAN_GRADES.find((item) => item !== 'Select Grade' && lower.includes(item.toLowerCase())) ?? profile?.grade ?? SOUTH_AFRICAN_GRADES[0];
  const region = REGIONS.find((item) => lower.includes(item.toLowerCase())) ?? profile?.province ?? REGIONS[0];
  return { grade, region, subject, year, month, paperNumber };
};

const buildBulkRows = ({ files, profile }) => {
  const allFiles = Array.from(files ?? []);
  const memoFiles = allFiles.filter(isMemoFile);
  const paperFiles = allFiles.filter((file) => !isMemoFile(file));
  const usedMemoIndexes = new Set();

  return paperFiles.map((paperFile, index) => {
    let bestMemoIndex = -1;
    let bestScore = 0;
    memoFiles.forEach((memoFile, memoIndex) => {
      if (usedMemoIndexes.has(memoIndex)) return;
      const score = overlapScore(paperFile, memoFile);
      if (score > bestScore) {
        bestScore = score;
        bestMemoIndex = memoIndex;
      }
    });
    const memoFile = bestScore > 0 && bestMemoIndex >= 0 ? memoFiles[bestMemoIndex] : null;
    if (bestMemoIndex >= 0) usedMemoIndexes.add(bestMemoIndex);
    return {
      id: `${Date.now()}-${index}-${paperFile.name}`,
      paperFile,
      memoFile,
      ...inferMetadataFromName(paperFile, profile),
      notes: '',
    };
  });
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

export const PastExamPapersPage = () => {
  const { profile, logout } = useAuth();
  const [papers, setPapers] = useState([]);
  const [status, setStatus] = useState('');
  const [uploadTab, setUploadTab] = useState('single');
  const [singleForm, setSingleForm] = useState(defaultPaperForm(profile));
  const [bulkRows, setBulkRows] = useState([]);
  const [filters, setFilters] = useState({ subject: 'all', year: 'all' });
  const [editingPaper, setEditingPaper] = useState(null);
  const [editForm, setEditForm] = useState(null);

  const role = useMemo(() => profile?.role ?? ROLES.STUDENT, [profile]);
  const allowedSubjects = useMemo(() => {
    if (role === ROLES.ADMIN) return SUBJECTS;
    if (role === ROLES.TUTOR) return getApprovedTutorSubjects(profile);
    return getUserSubjects(profile);
  }, [profile, role]);
  const visibleSubjects = allowedSubjects.length ? allowedSubjects : SUBJECTS;

  useEffect(() => {
    const unsubscribe = subscribeQuestionPapers(setPapers);
    return unsubscribe;
  }, []);

  const visiblePapers = useMemo(() => papers
    .filter((paper) => role === ROLES.ADMIN || !visibleSubjects.length || visibleSubjects.includes(paper.subject))
    .filter((paper) => filters.subject === 'all' || paper.subject === filters.subject)
    .filter((paper) => filters.year === 'all' || String(paper.year) === String(filters.year)), [papers, role, visibleSubjects, filters]);
  const years = useMemo(() => [...new Set(papers.map((paper) => paper.year).filter(Boolean))].sort((a, b) => Number(b) - Number(a)), [papers]);


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

  const handleEditSubmit = async (event) => {
    event.preventDefault();
    if (!editingPaper || !editForm) return;
    try {
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
      const fileChanged = Boolean(editForm.paperFile || editForm.memoFile || editForm.removeMemo);
      const needsAnalysis = metadataChanged || fileChanged;
      const patch = {
        grade: editForm.grade,
        region: editForm.region,
        subject: editForm.subject,
        year: Number(editForm.year),
        month: editForm.month,
        paperNumber: editForm.paperNumber,
        notes: editForm.notes,
        displayName: `${editForm.subject} • ${editForm.grade} • ${editForm.region} • ${editForm.month} ${editForm.year} • ${editForm.paperNumber}${editingPaper.copySuffix ? ` ${editingPaper.copySuffix}` : ''}`,
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
      setStatus(needsAnalysis ? 'Paper updated. Analysis is running again in the background.' : 'Paper updated.');
      closeEditPaper();
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
      const saved = await saveReviewedPaper({ row: singleForm, index: 0, total: 1 });
      setPapers((current) => [saved, ...current.filter((paper) => paper.id !== saved.id)]);
      setStatus('Past paper saved. Analysis is running in the background.');
      setSingleForm(defaultPaperForm(profile));
      event.target.reset();
    } catch (error) {
      setStatus(error.message || 'Could not save paper.');
    }
  };

  const handleBulkFiles = (event) => {
    const rows = buildBulkRows({ files: event.target.files, profile });
    setBulkRows(rows);
    setStatus(rows.length ? `${rows.length} question paper${rows.length === 1 ? '' : 's'} prepared for review.` : 'No question paper files were detected. Include paper files and optional memo files.');
  };

  const updateBulkRow = (id, patch) => setBulkRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  const removeBulkRow = (id) => setBulkRows((current) => current.filter((row) => row.id !== id));

  const handleBulkSubmit = async () => {
    if (!bulkRows.length) {
      setStatus('Choose bulk files first.');
      return;
    }
    try {
      const saved = [];
      for (let index = 0; index < bulkRows.length; index += 1) {
        saved.push(await saveReviewedPaper({ row: bulkRows[index], index, total: bulkRows.length }));
      }
      setPapers((current) => [...saved, ...current.filter((paper) => !saved.some((item) => item.id === paper.id))]);
      setBulkRows([]);
      setStatus(`${saved.length} paper${saved.length === 1 ? '' : 's'} saved. Analysis is running for each paper.`);
    } catch (error) {
      setStatus(error.message || 'Bulk upload failed.');
    }
  };

  return (
    <AppShell title="Past exam papers" subtitle="Browse papers first, then upload one paper or review a bulk upload before analysis starts." role={role} user={profile} onLogout={logout}>
      <SectionHeader eyebrow="Repository" title="Question papers" description="The list is scoped to your subjects. Use filters to narrow by subject or year." />
      <div className="panel grid gap-3 p-4 md:grid-cols-2">
        <select className="input" value={filters.subject} onChange={(event) => setFilters((current) => ({ ...current, subject: event.target.value }))}>
          <option value="all">All subjects</option>
          {visibleSubjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
        </select>
        <select className="input" value={filters.year} onChange={(event) => setFilters((current) => ({ ...current, year: event.target.value }))}>
          <option value="all">All years</option>
          {years.map((year) => <option key={year} value={year}>{year}</option>)}
        </select>
      </div>

      <div className="space-y-4">
        {visiblePapers.map((paper) => (
          <div key={paper.id} className="panel p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-slate-950">{paper.displayName || `${paper.subject} • ${paper.grade}`}</h3>
                <p className="mt-1 text-sm text-slate-500">{paper.region} • {paper.month} {paper.year} • {paper.paperNumber ?? 'Paper 1'}</p>
              </div>
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-slate-600">{paper.subject}</span>
            </div>
            <PaperAnalysisStatus paper={paper} />
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <Link className="btn-secondary" to={`/${role}/papers/${paper.id}?page=1`}>Open paper</Link>
              {paper.memoUrl ? <a className="btn-secondary" href={paper.memoUrl} target="_blank" rel="noreferrer">Open memo</a> : <span className="rounded-full bg-slate-50 px-3 py-2 text-slate-500">No memo uploaded</span>}
              <button type="button" className="btn-secondary" onClick={() => startEditPaper(paper)}>Edit</button>
            </div>
          </div>
        ))}
        {!visiblePapers.length ? <div className="panel p-5 text-sm text-slate-500">No papers match these filters.</div> : null}
      </div>

      <section className="panel space-y-5 p-6">
        <div className="flex flex-wrap gap-2">
          <button type="button" className={uploadTab === 'single' ? 'btn-primary' : 'btn-secondary'} onClick={() => setUploadTab('single')}>Single upload</button>
          <button type="button" className={uploadTab === 'bulk' ? 'btn-primary' : 'btn-secondary'} onClick={() => setUploadTab('bulk')}>Bulk upload</button>
        </div>

        {uploadTab === 'single' ? (
          <form onSubmit={handleSingleSubmit} className="grid gap-4 md:grid-cols-2">
            <UploadFields value={singleForm} onChange={(patch) => setSingleForm((current) => ({ ...current, ...patch }))} subjects={visibleSubjects} />
            <label className="md:col-span-2"><span className="label">Question paper</span><input type="file" className="input" accept=".pdf,.doc,.docx,image/*" onChange={(event) => setSingleForm((current) => ({ ...current, paperFile: event.target.files?.[0] ?? null }))} required /></label>
            <label className="md:col-span-2"><span className="label">Memo optional</span><input type="file" className="input" accept=".pdf,.doc,.docx,image/*" onChange={(event) => setSingleForm((current) => ({ ...current, memoFile: event.target.files?.[0] ?? null }))} /></label>
            <button type="submit" className="btn-primary md:col-span-2">Upload and analyze</button>
          </form>
        ) : (
          <div className="space-y-4">
            <label className="block"><span className="label">Bulk files</span><input type="file" className="input" multiple accept=".pdf,.doc,.docx,image/*" onChange={handleBulkFiles} /><span className="mt-1 block text-xs text-slate-500">Select question papers and optional memos together. The app will infer metadata and pair memos by filename similarity before upload.</span></label>
            <div className="space-y-4">
              {bulkRows.map((row, index) => (
                <div key={row.id} className="rounded-2xl border border-slate-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div><p className="font-semibold text-slate-950">{index + 1}. {row.paperFile.name}</p><p className="text-sm text-slate-500">Memo: {row.memoFile?.name ?? 'None linked'}</p></div>
                    <button type="button" className="btn-secondary text-sm" onClick={() => removeBulkRow(row.id)}>Remove</button>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-3">
                    <UploadFields value={row} onChange={(patch) => updateBulkRow(row.id, patch)} subjects={visibleSubjects} compact />
                  </div>
                </div>
              ))}
            </div>
            {bulkRows.length ? <button type="button" className="btn-primary w-full" onClick={handleBulkSubmit}>Upload reviewed papers</button> : null}
          </div>
        )}
        {status ? <p className="text-sm text-slate-600">{status}</p> : null}
      </section>

      {editingPaper && editForm ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={handleEditSubmit} className="panel max-h-[90dvh] w-full max-w-4xl overflow-y-auto p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.25em] text-brand-700">Edit paper</p>
                <h2 className="mt-2 text-2xl font-bold text-slate-950">{editingPaper.displayName || editingPaper.paperFileName || 'Question paper'}</h2>
                <p className="mt-1 text-sm text-slate-500">Changing files or metadata queues the paper for analysis again.</p>
              </div>
              <button type="button" className="btn-secondary" onClick={closeEditPaper}>Close</button>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <UploadFields value={editForm} onChange={(patch) => setEditForm((current) => ({ ...current, ...patch }))} subjects={visibleSubjects} />
              <label className="md:col-span-2"><span className="label">Replace question paper optional</span><input type="file" className="input" accept=".pdf,.doc,.docx,image/*" onChange={(event) => setEditForm((current) => ({ ...current, paperFile: event.target.files?.[0] ?? null }))} /><span className="mt-1 block text-xs text-slate-500">Current: {editingPaper.paperFileName || 'No paper file name stored'}</span></label>
              <label className="md:col-span-2"><span className="label">Replace memorandum optional</span><input type="file" className="input" accept=".pdf,.doc,.docx,image/*" onChange={(event) => setEditForm((current) => ({ ...current, memoFile: event.target.files?.[0] ?? null, removeMemo: false }))} /><span className="mt-1 block text-xs text-slate-500">Current: {editingPaper.memoFileName || 'No memo uploaded'}</span></label>
              {editingPaper.memoUrl ? <label className="md:col-span-2 flex items-center gap-3 text-sm font-semibold text-slate-700"><input type="checkbox" checked={editForm.removeMemo} onChange={(event) => setEditForm((current) => ({ ...current, removeMemo: event.target.checked, memoFile: event.target.checked ? null : current.memoFile }))} /> Remove current memorandum</label> : null}
              <button type="submit" className="btn-primary md:col-span-2">Save changes and re-analyze if needed</button>
            </div>
          </form>
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
    <label><span className="label">Month</span><select className="input" value={value.month} onChange={(event) => onChange({ month: event.target.value })}>{PAPER_MONTHS.map((month) => <option key={month}>{month}</option>)}</select></label>
    <label><span className="label">Paper number</span><select className="input" value={value.paperNumber} onChange={(event) => onChange({ paperNumber: event.target.value })}>{PAPER_NUMBERS.map((paperNumber) => <option key={paperNumber}>{paperNumber}</option>)}</select></label>
    {!compact ? <label className="md:col-span-2"><span className="label">Notes</span><textarea className="input min-h-24" value={value.notes} onChange={(event) => onChange({ notes: event.target.value })} /></label> : <label className="md:col-span-3"><span className="label">Notes</span><input className="input" value={value.notes} onChange={(event) => onChange({ notes: event.target.value })} /></label>}
  </>
);
