import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '../components/common/AppShell';
import { SectionHeader } from '../components/common/SectionHeader';
import { useAuth } from '../hooks/useAuth';
import { DEFAULT_SUBJECT, PAPER_MONTHS, PAPER_NUMBERS, REGIONS, SOUTH_AFRICAN_GRADES, SUBJECTS } from '../lib/constants';
import { saveQuestionPaper, subscribeQuestionPapers } from '../services/firestoreService';
import { uploadQuestionPaperDocuments } from '../services/storageService';


const paperStatusStyles = {
  Analyzing: 'bg-amber-50 text-amber-700',
  Analyzed: 'bg-emerald-50 text-emerald-700',
  Failed: 'bg-rose-50 text-rose-700',
};

const PaperAnalysisStatus = ({ paper }) => {
  const status = paper.analysisStatus ?? (paper.availableForGeneration ? 'Analyzed' : 'Analyzing');
  const current = Number(paper.analysisProgressCurrent ?? 0);
  const total = Math.max(1, Number(paper.analysisProgressTotal ?? 1));
  const percentage = status === 'Analyzed'
    ? 100
    : Math.max(0, Math.min(100, Math.round((current / total) * 100)));

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
  const [form, setForm] = useState({
    grade: SOUTH_AFRICAN_GRADES[0],
    region: REGIONS[0],
    subject: DEFAULT_SUBJECT,
    year: new Date().getFullYear(),
    month: PAPER_MONTHS[0],
    paperNumber: PAPER_NUMBERS[0],
    notes: '',
    paperFiles: [],
    memoFiles: [],
  });

  const role = useMemo(() => profile?.role ?? 'student', [profile]);

  useEffect(() => {
    const unsubscribe = subscribeQuestionPapers(setPapers);
    return unsubscribe;
  }, [role]);

  const handleChange = (key) => (event) => {
    const value = key.endsWith('Files') ? Array.from(event.target.files ?? []) : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    console.log('[Examifying][PastPapers] submit:start', form);

    const paperFiles = Array.isArray(form.paperFiles) ? form.paperFiles : [];
    const memoFiles = Array.isArray(form.memoFiles) ? form.memoFiles : [];
    if (!paperFiles.length) {
      setStatus('Please select at least one question paper document.');
      return;
    }

    setStatus(`Uploading ${paperFiles.length} question paper${paperFiles.length > 1 ? 's' : ''}...`);

    try {
      const savedPapers = [];
      for (let index = 0; index < paperFiles.length; index += 1) {
        const paperFile = paperFiles[index];
        const memoFile = memoFiles[index] ?? (paperFiles.length === 1 ? memoFiles[0] : null);
        setStatus(`Uploading paper ${index + 1}/${paperFiles.length}: ${paperFile.name}`);
        const uploads = await uploadQuestionPaperDocuments({
          paperFile,
          memoFile,
          uploaderId: profile?.uid ?? 'anonymous',
          onProgress: (message) => setStatus(`Paper ${index + 1}/${paperFiles.length}: ${message}`),
        });
        const saved = await saveQuestionPaper({
          grade: form.grade,
          region: form.region,
          subject: form.subject,
          year: Number(form.year),
          month: form.month,
          paperNumber: form.paperNumber,
          notes: form.notes,
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
          bulkUploadTotal: paperFiles.length,
        });
        savedPapers.push(saved);
        setPapers((current) => [saved, ...current.filter((paper) => paper.id !== saved.id)]);
      }

      setStatus(`${savedPapers.length} past paper${savedPapers.length > 1 ? 's' : ''} saved. Analysis is running in the background.`);
      setForm((current) => ({ ...current, notes: '', paperFiles: [], memoFiles: [], year: new Date().getFullYear() }));
      event.target.reset();
    } catch (error) {
      console.error('[Examifying][PastPapers] submit:error', error);
      setStatus(error.message);
    }
  };

  return (
    <AppShell
      title="Past exam papers"
      subtitle="Browse and add past papers. Duplicate metadata is saved with copy numbering like (1), (2), and (3)."
      role={role}
      user={profile}
      onLogout={logout}
    >
      <SectionHeader eyebrow="Repository" title="Shared past exam papers" description="Students, tutors, and admins can browse this paper library and upload new papers with an optional memorandum." />
      <div className="grid gap-6 xl:grid-cols-[1fr_0.95fr]">
        <div className="space-y-4">
          {papers.map((paper) => (
            <div key={paper.id} className="panel p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-950">{paper.displayName || `${paper.subject} • ${paper.grade}`}</h3>
                  <p className="mt-1 text-sm text-slate-500">{paper.region} • {paper.month} {paper.year} • {paper.paperNumber ?? 'Paper 1'}</p>
                </div>
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] text-slate-600">{paper.region}</span>
              </div>
              <PaperAnalysisStatus paper={paper} />
              {Array.isArray(paper.topics) && paper.topics.length ? (
                <p className="mt-3 text-xs text-slate-500">Topics: {paper.topics.slice(0, 5).join(', ')}{paper.topics.length > 5 ? '…' : ''}</p>
              ) : null}
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                <Link className="btn-secondary" to={`/${role}/papers/${paper.id}?page=1`}>Open paper</Link>
                {paper.memoUrl ? <a className="btn-secondary" href={paper.memoUrl} target="_blank" rel="noreferrer">Open memo</a> : <span className="rounded-full bg-slate-50 px-3 py-2 text-slate-500">No memo uploaded</span>}
              </div>
            </div>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="panel grid gap-4 p-6 md:grid-cols-2">
          <div className="md:col-span-2">
            <h3 className="text-xl font-semibold text-slate-950">Add past exam paper</h3>
            <p className="mt-2 text-sm text-slate-500">All users can bulk upload papers. Matching metadata is saved as numbered copies instead of being blocked.</p>
          </div>
          <label>
            <span className="label">Region</span>
            <select className="input" value={form.region} onChange={handleChange('region')}>
              {REGIONS.map((region) => <option key={region}>{region}</option>)}
            </select>
          </label>
          <label>
            <span className="label">Subject</span>
            <select className="input" value={form.subject} onChange={handleChange('subject')}>
              {SUBJECTS.map((subject) => <option key={subject}>{subject}</option>)}
            </select>
          </label>
          <label>
            <span className="label">Grade</span>
            <select className="input" value={form.grade} onChange={handleChange('grade')}>
              {SOUTH_AFRICAN_GRADES.map((grade) => <option key={grade}>{grade}</option>)}
            </select>
          </label>
          <label>
            <span className="label">Year</span>
            <input type="number" className="input" value={form.year} onChange={handleChange('year')} min="2000" max="2100" />
          </label>
          <label>
            <span className="label">Month</span>
            <select className="input" value={form.month} onChange={handleChange('month')}>
              {PAPER_MONTHS.map((month) => <option key={month}>{month}</option>)}
            </select>
          </label>
          <label>
            <span className="label">Paper number</span>
            <select className="input" value={form.paperNumber} onChange={handleChange('paperNumber')}>
              {PAPER_NUMBERS.map((paperNumber) => <option key={paperNumber}>{paperNumber}</option>)}
            </select>
          </label>
          <label className="md:col-span-2">
            <span className="label">Question paper document(s)</span>
            <input type="file" className="input" onChange={handleChange('paperFiles')} accept=".pdf,.doc,.docx,image/*" multiple required />
            <span className="mt-1 block text-xs text-slate-500">You can select multiple question papers. They will all use the metadata selected above.</span>
          </label>
          <label className="md:col-span-2">
            <span className="label">Memorandum document(s) (optional)</span>
            <input type="file" className="input" onChange={handleChange('memoFiles')} accept=".pdf,.doc,.docx,image/*" multiple />
            <span className="mt-1 block text-xs text-slate-500">For bulk uploads, memos are paired by file order. If one paper is selected, the first memo is used.</span>
          </label>
          <label className="md:col-span-2">
            <span className="label">Notes</span>
            <textarea className="input min-h-28" value={form.notes} onChange={handleChange('notes')} />
          </label>
          <div className="md:col-span-2">
            <button type="submit" className="btn-primary w-full">Save past paper</button>
            {status ? <p className="mt-3 text-sm text-slate-600">{status}</p> : null}
          </div>
        </form>
      </div>
    </AppShell>
  );
};
