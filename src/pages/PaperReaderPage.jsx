import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../components/common/AppShell';
import { useAuth } from '../hooks/useAuth';
import { getQuestionPaperById } from '../services/firestoreService';

export const PaperReaderPage = () => {
  const { paperId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { profile, logout } = useAuth();
  const [paper, setPaper] = useState(null);
  const [status, setStatus] = useState('Loading paper...');
  const role = profile?.role ?? 'student';
  const initialPage = Math.max(1, Number(searchParams.get('page') ?? 1) || 1);
  const [pageNumber, setPageNumber] = useState(initialPage);
  const questionReference = searchParams.get('question') ?? '';

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await getQuestionPaperById(paperId);
        if (!active) return;
        setPaper(result);
        setStatus(result ? '' : 'Question paper not found.');
      } catch (error) {
        if (!active) return;
        setStatus(error.message ?? 'Could not load question paper.');
      }
    };
    load();
    return () => { active = false; };
  }, [paperId]);

  const pdfUrl = useMemo(() => {
    if (!paper?.paperUrl) return '';
    return `${paper.paperUrl}#page=${pageNumber}&toolbar=1&navpanes=0`;
  }, [paper?.paperUrl, pageNumber]);

  const updatePage = (nextPage) => {
    const safePage = Math.max(1, nextPage);
    setPageNumber(safePage);
    const next = new URLSearchParams(searchParams);
    next.set('page', String(safePage));
    if (questionReference) next.set('question', questionReference);
    setSearchParams(next, { replace: true });
  };

  return (
    <AppShell
      title="Question paper"
      subtitle={paper ? `${paper.displayName || paper.subject} • Page ${pageNumber}` : status}
      role={role}
      user={profile}
      onLogout={logout}
    >
      <div className="panel flex min-h-[calc(100dvh-11rem)] flex-col overflow-hidden p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">{paper ? `${paper.subject} ${paper.grade}` : 'Question paper'}</h2>
            <p className="text-sm text-slate-500">{questionReference ? `Question ${questionReference}` : 'Use the controls to move through the paper.'}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary px-3 py-2 text-sm" onClick={() => updatePage(pageNumber - 1)} disabled={pageNumber <= 1}>Previous</button>
            <span className="rounded-full bg-slate-100 px-3 py-2 text-sm font-semibold text-slate-600">Page {pageNumber}</span>
            <button type="button" className="btn-secondary px-3 py-2 text-sm" onClick={() => updatePage(pageNumber + 1)}>Next</button>
          </div>
        </div>
        {status ? (
          <div className="flex flex-1 items-center justify-center rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500">{status}</div>
        ) : (
          <iframe
            title="Question paper reader"
            src={pdfUrl}
            className="min-h-[70dvh] flex-1 rounded-2xl border border-slate-200 bg-white"
          />
        )}
      </div>
    </AppShell>
  );
};
