import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../components/common/AppShell';
import { SectionHeader } from '../components/common/SectionHeader';
import { useAuth } from '../hooks/useAuth';
import { ROLES } from '../lib/constants';
import { getQuestionPaperById, updateQuestionPaper } from '../services/firestoreService';

const retryPaperAnalysis = async (paper) => updateQuestionPaper(paper.id, {
  analysisStatus: 'Analyzing',
  availableForGeneration: false,
  analysisProgressMessage: 'Retry queued by admin',
  analysisError: '',
  analysisRevision: Date.now(),
});

const AnalysisReviewPanel = ({ paper, onRetry }) => {
  const outputs = Array.isArray(paper.analysisBatchOutputs) ? paper.analysisBatchOutputs : [];
  const questions = Array.isArray(paper.questions) ? paper.questions : [];

  return (
    <section className="panel space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeader
          eyebrow="Admin review"
          title="Extracted analysis"
          description="Review the stored extraction data. Retry adds a fresh analysis run to the shared paper queue."
        />
        <button type="button" className="btn-primary" onClick={onRetry}>Retry analysis</button>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs uppercase tracking-[0.2em] text-slate-500">Status</p><p className="mt-2 font-semibold text-slate-950">{paper.analysisStatus || 'Unknown'}</p></div>
        <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs uppercase tracking-[0.2em] text-slate-500">Questions</p><p className="mt-2 font-semibold text-slate-950">{paper.questionCount ?? questions.length}</p></div>
        <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs uppercase tracking-[0.2em] text-slate-500">Paper pages</p><p className="mt-2 font-semibold text-slate-950">{paper.paperPageCount ?? '-'}</p></div>
        <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs uppercase tracking-[0.2em] text-slate-500">Memo pages</p><p className="mt-2 font-semibold text-slate-950">{paper.memoPageCount ?? 0}</p></div>
      </div>
      {paper.analysisError ? <div className="rounded-2xl bg-rose-50 p-4 text-sm font-medium text-rose-700">{paper.analysisError}</div> : null}
      <div>
        <h3 className="font-semibold text-slate-950">Summary</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">{paper.paperAnalysisSummary || 'No summary stored yet.'}</p>
      </div>
      <div>
        <h3 className="font-semibold text-slate-950">Topics</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          {(paper.topics ?? []).map((topic) => <span key={topic} className="rounded-full bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700">{topic}</span>)}
          {!paper.topics?.length ? <span className="text-sm text-slate-500">No topics stored yet.</span> : null}
        </div>
      </div>
      <div>
        <h3 className="font-semibold text-slate-950">Page extraction progress</h3>
        <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200">
          <div className="overflow-x-auto">
            <table className="min-w-[760px] text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-[0.2em] text-slate-500">
                <tr><th className="px-4 py-3">Batch</th><th className="px-4 py-3">Pages</th><th className="px-4 py-3">Model</th><th className="px-4 py-3">Extracted text preview</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {outputs.map((output, index) => (
                  <tr key={`${output.batchPageKey}-${index}`} className="align-top">
                    <td className="px-4 py-3 font-semibold text-slate-600">{output.batchNumber ?? index + 1}</td>
                    <td className="px-4 py-3 text-slate-600">{(output.pages ?? []).map((page) => `${page.label} p${page.pageNumber}`).join(', ')}</td>
                    <td className="px-4 py-3 text-slate-600">{output.model || '-'}</td>
                    <td className="px-4 py-3 text-slate-600"><p className="line-clamp-4 whitespace-pre-line">{output.text || 'No text returned.'}</p></td>
                  </tr>
                ))}
                {!outputs.length ? <tr><td colSpan="4" className="px-4 py-6 text-center text-slate-500">No page batches saved yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div>
        <h3 className="font-semibold text-slate-950">Question index</h3>
        <div className="mt-3 grid gap-3">
          {questions.map((question) => (
            <div key={question.id} className="rounded-2xl bg-slate-50 p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-slate-950">Question {question.questionReference} • Page {question.pageNumber}</p>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">{question.marks} marks</span>
              </div>
              <p className="mt-2 text-slate-600">{question.topic}</p>
              <p className="mt-2 text-slate-500">{question.instruction}</p>
              {question.memoSummary ? <p className="mt-2 text-slate-500">Memo: {question.memoSummary}</p> : null}
            </div>
          ))}
          {!questions.length ? <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">No indexed questions stored yet.</div> : null}
        </div>
      </div>
    </section>
  );
};

export const PaperReaderPage = () => {
  const { paperId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { profile, logout } = useAuth();
  const [paper, setPaper] = useState(null);
  const [status, setStatus] = useState('Loading paper...');
  const [actionStatus, setActionStatus] = useState('');
  const role = profile?.role ?? 'student';
  const initialPage = Math.max(1, Number(searchParams.get('page') ?? 1) || 1);
  const [pageNumber, setPageNumber] = useState(initialPage);
  const questionReference = searchParams.get('question') ?? '';
  const canReviewAnalysis = role === ROLES.ADMIN;

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

  const handleRetry = async () => {
    if (!paper) return;
    try {
      setActionStatus('Adding analysis retry to the queue...');
      await retryPaperAnalysis(paper);
      const refreshed = await getQuestionPaperById(paper.id);
      setPaper(refreshed);
      setActionStatus('Analysis retry queued. It will start immediately when no other paper is being analyzed.');
    } catch (error) {
      setActionStatus(error.message || 'Could not retry analysis.');
    }
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
      {actionStatus ? <div className="panel p-4 text-sm text-slate-600">{actionStatus}</div> : null}
      {paper && canReviewAnalysis ? <AnalysisReviewPanel paper={paper} onRetry={handleRetry} /> : null}
    </AppShell>
  );
};
