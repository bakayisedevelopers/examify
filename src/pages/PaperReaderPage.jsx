import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import { AppShell } from '../components/common/AppShell';
import { SectionHeader } from '../components/common/SectionHeader';
import { useAuth } from '../hooks/useAuth';
import { useOperationStatus } from '../hooks/useOperationStatus';
import { ROLES } from '../lib/constants';
import { getQuestionPaperById, subscribeQuestionPaperAnalysisActivity, updateQuestionPaper } from '../services/firestoreService';

const StudentFullPagePdf = ({ paper, documentUrl, documentTitle, pageNumber, questionReference, status, onPageChange, onBack }) => {
  const paperTitle = paper?.displayName || `${paper?.subject || 'Question paper'} ${paper?.grade || ''}`.trim();
  const title = documentTitle && documentTitle !== 'Question paper' ? `${paperTitle} · ${documentTitle}` : paperTitle;
  const viewerUrl = documentUrl ? `${documentUrl}#page=${pageNumber}&toolbar=1&navpanes=0` : '';
  return (
    <main className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-slate-950 text-slate-900">
      <header className="grid h-14 shrink-0 grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-2 border-b border-transparent bg-transparent px-3 sm:px-5 lg:flex lg:justify-between lg:gap-3 lg:border-slate-200 lg:bg-white">
        <button type="button" className="grid h-10 w-10 place-items-center rounded-full border border-slate-700/80 bg-slate-950 text-lime-300 shadow-[0_3px_14px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-lime-400/60 hover:bg-slate-900 hover:text-lime-200 lg:inline-flex lg:h-auto lg:w-auto lg:gap-2 lg:rounded-md lg:border-transparent lg:bg-transparent lg:px-2 lg:text-sm lg:font-semibold lg:text-slate-700 lg:shadow-none lg:hover:bg-slate-100" onClick={onBack} aria-label="Go back">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden lg:inline">Back</span>
        </button>
        <p className="min-w-0 truncate rounded-full border border-slate-700/80 bg-slate-950 px-3 py-1 text-center text-sm font-semibold text-lime-200 shadow-[0_3px_14px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] lg:flex-1 lg:rounded-none lg:border-0 lg:bg-transparent lg:px-0 lg:py-0 lg:text-slate-700 lg:shadow-none">{title}{questionReference ? ` • Q${questionReference}` : ''}</p>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="grid h-9 w-9 place-items-center rounded-full border border-slate-700/80 bg-slate-950 text-lime-300 shadow-[0_3px_14px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-lime-400/60 hover:bg-slate-900 disabled:opacity-40 lg:h-10 lg:w-10 lg:rounded-md lg:border-transparent lg:bg-transparent lg:text-slate-700 lg:shadow-none lg:hover:bg-slate-100" onClick={() => onPageChange(pageNumber - 1)} disabled={pageNumber <= 1} aria-label="Previous PDF page"><ChevronLeft className="h-5 w-5" /></button>
          <span className="min-w-14 rounded-full border border-slate-700/80 bg-slate-950 px-2 py-1 text-center text-[10px] font-semibold text-slate-300 shadow-[0_3px_14px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] lg:rounded-none lg:border-0 lg:bg-transparent lg:px-0 lg:text-xs lg:text-slate-600 lg:shadow-none">Page {pageNumber}</span>
          <button type="button" className="grid h-9 w-9 place-items-center rounded-full border border-slate-700/80 bg-slate-950 text-lime-300 shadow-[0_3px_14px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)] transition hover:border-lime-400/60 hover:bg-slate-900 lg:h-10 lg:w-10 lg:rounded-md lg:border-transparent lg:bg-transparent lg:text-slate-700 lg:shadow-none lg:hover:bg-slate-100" onClick={() => onPageChange(pageNumber + 1)} aria-label="Next PDF page"><ChevronRight className="h-5 w-5" /></button>
        </div>
      </header>
      {status || !viewerUrl ? (
        <div role="status" className="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-white">
          {status === 'Loading paper...'
            ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin text-lime-400" aria-hidden="true" />Loading paper…</span>
            : status || `This ${documentTitle?.toLowerCase() || 'document'} is not available.`}
        </div>
      ) : (
        <iframe title={title} src={viewerUrl} className="min-h-0 flex-1 border-0 bg-slate-900" />
      )}
    </main>
  );
};

const retryPaperAnalysis = async (paper) => updateQuestionPaper(paper.id, {
  analysisStatus: 'Analyzing',
  availableForGeneration: false,
  analysisProgressMessage: 'Retry queued by admin',
  analysisProgressCurrent: 0,
  analysisProgressTotal: 1,
  analysisError: '',
  analysisRevision: Date.now(),
  questions: [],
  topics: [],
  questionCount: 0,
  paperAnalysisSummary: '',
  analysisBatchOutputs: [],
});

const formatValue = (value) => {
  if (value === undefined || value === null || value === '') return '-';
  if (Array.isArray(value)) return value.filter(Boolean).join(', ') || '-';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
};

const ExtractedQuestionsViewer = ({ questions, onOpenPage }) => (
  <div>
    <h3 className="font-semibold text-white">Extracted question metadata</h3>
    <div className="mt-3 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/90">
      <div className="overflow-x-auto">
        <table className="min-w-[1040px] text-left text-sm">
          <thead className="bg-slate-800 text-xs uppercase tracking-[0.2em] text-slate-400">
            <tr>
              <th className="px-4 py-3">Ref</th>
              <th className="px-4 py-3">Parent</th>
              <th className="px-4 py-3">Page</th>
              <th className="px-4 py-3">Marks</th>
              <th className="px-4 py-3">Topic</th>
              <th className="px-4 py-3">Section</th>
              <th className="px-4 py-3">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {questions.map((question, index) => (
              <tr key={question.id || `${question.questionReference}-${index}`} className="align-top">
                <td className="px-4 py-3 font-semibold text-white">{formatValue(question.questionReference)}</td>
                <td className="px-4 py-3 text-slate-400">{formatValue(question.parentQuestion)}</td>
                <td className="px-4 py-3">
                  {question.pageNumber ? (
                    <button type="button" className="font-semibold text-lime-400 hover:text-lime-300" onClick={() => onOpenPage(question.pageNumber, question.questionReference)}>
                      Page {question.pageNumber}
                    </button>
                  ) : '-'}
                </td>
                <td className="px-4 py-3 text-slate-400">{formatValue(question.marks)}</td>
                <td className="px-4 py-3 text-slate-400">{formatValue(question.topic)}</td>
                <td className="px-4 py-3 text-slate-400">{formatValue(question.section)}</td>
                <td className="px-4 py-3 text-slate-400">
                  <p>{formatValue(question.sourceBatchId)}</p>
                  <p className="text-xs text-slate-500">{formatValue(question.sourceDocumentType)}</p>
                </td>
              </tr>
            ))}
            {!questions.length ? <tr><td colSpan="7" className="px-4 py-6 text-center text-slate-500">No extracted question records are stored on this paper yet.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
    {questions.length ? (
      <details className="mt-3 rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
        <summary className="cursor-pointer font-semibold">Raw stored questions JSON</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap">{JSON.stringify(questions, null, 2)}</pre>
      </details>
    ) : null}
  </div>
);

const ExtractedMetadataViewer = ({ paper, outputs }) => {
  const metadata = paper.paperMetadata && typeof paper.paperMetadata === 'object' ? paper.paperMetadata : {};
  const rows = [
    ['Paper title', metadata.paperTitle || paper.displayName],
    ['Subject', metadata.subject || paper.subject],
    ['Grade', metadata.grade || paper.grade],
    ['Region', metadata.region || paper.region],
    ['Month', metadata.month || paper.month],
    ['Year', metadata.year || paper.year],
    ['Paper number', metadata.paperNumber || paper.paperNumber],
    ['Copy suffix', metadata.copySuffix || paper.copySuffix],
    ['Total marks', metadata.totalMarks],
    ['Confidence', metadata.confidence],
    ['Question count', paper.questionCount],
    ['Vision model(s)', paper.paperDocumentAnalysisModel || (paper.analysisVisionModels ?? []).join(', ')],
    ['Analyzed pages', paper.paperDocumentAnalysisPageCount],
  ];
  const rawText = [
    paper.paperDocumentAnalysis,
    ...(outputs ?? []).map((output) => [
      `Batch: ${output.batchNumber ?? '-'}`,
      `Pages: ${(output.pages ?? []).map((page) => `${page.label} p${page.pageNumber}`).join(', ') || '-'}`,
      `Model: ${output.model || '-'}`,
      output.text || '',
    ].filter(Boolean).join('\n')),
  ].filter(Boolean).join('\n\n---\n\n');

  return (
    <div>
      <h3 className="font-semibold text-slate-950">Extracted paper metadata</h3>
      <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map(([label, value]) => (
          <div key={label} className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
            <p className="mt-2 break-words text-sm font-semibold text-slate-950">{formatValue(value)}</p>
          </div>
        ))}
      </div>
      <details className="mt-3 rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
        <summary className="cursor-pointer font-semibold">Raw extracted text</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap">{rawText || 'No raw extraction text is stored yet.'}</pre>
      </details>
      <details className="mt-3 rounded-2xl bg-slate-50 p-4 text-xs text-slate-700">
        <summary className="cursor-pointer font-semibold text-slate-950">Raw metadata JSON</summary>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap">{JSON.stringify(metadata, null, 2)}</pre>
      </details>
    </div>
  );
};

const AnalysisReviewPanel = ({ paper, activity, activityLoading, activityError, onRetry, onOpenPage }) => {
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
      <LiveModelActivity paper={paper} activity={activity} loading={activityLoading} error={activityError} />
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
      <ExtractedMetadataViewer paper={paper} outputs={outputs} />
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
      <ExtractedQuestionsViewer questions={questions} onOpenPage={onOpenPage} />
    </section>
  );
};

const LiveModelActivity = ({ paper, activity, loading = false, error = '' }) => {
  const activeRunId = paper.activeAnalysisRunId || paper.queuedAnalysisRunId;
  const batches = activity
    .filter((batch) => !activeRunId || batch.runId === activeRunId)
    .filter((batch) => ['Queued', 'Processing', 'Failed'].includes(batch.status))
    .sort((a, b) => Number(a.pages?.[0]?.pageNumber ?? 0) - Number(b.pages?.[0]?.pageNumber ?? 0));

  if (paper.analysisStatus !== 'Analyzing' && !activeRunId && batches.length === 0) return null;

  return (
    <div>
      <h3 className="font-semibold text-white">Live model activity</h3>
      <div className="mt-3 overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/90">
        <div className="overflow-x-auto">
          <table className="min-w-[760px] text-left text-sm">
            <thead className="bg-slate-800 text-xs uppercase tracking-[0.2em] text-slate-400">
              <tr><th className="px-4 py-3">Page</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Attempt</th><th className="px-4 py-3">Model</th><th className="px-4 py-3">Fallback / result</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {batches.map((batch) => {
                const attempt = Number(batch.attemptCount ?? 0);
                const inGeminiFallback = attempt >= 5 && batch.status === 'Processing';
                const model = batch.model || (batch.status === 'Processing'
                  ? inGeminiFallback ? 'Gemini 3.5 Flash Lite (PDF fallback)' : 'Kilo vision fallback chain'
                  : '-');
                const progression = batch.status === 'Processing'
                  ? inGeminiFallback ? 'Kilo attempts exhausted; Gemini page fallback running' : 'Trying configured Kilo vision models; exact model is recorded when this attempt completes'
                  : batch.fallbackUsed ? `Fallback used${batch.fallbackFrom ? `: ${batch.fallbackFrom}` : ''}` : batch.error || '-';
                return (
                  <tr key={`${batch.runId}-${batch.id}`} className="align-top">
                    <td className="px-4 py-3 font-semibold text-white">Page {batch.pages?.[0]?.pageNumber ?? '-'}</td>
                    <td className="px-4 py-3 text-slate-400">{batch.status}</td>
                    <td className="px-4 py-3 text-slate-400">{attempt || '-'}</td>
                    <td className="px-4 py-3 text-slate-400">{model}</td>
                    <td className="px-4 py-3 text-slate-400">{progression}</td>
                  </tr>
                );
              })}
              {!batches.length ? <tr><td colSpan="5" className="px-4 py-5 text-center text-slate-500">{loading ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin text-lime-400" aria-hidden="true" />Loading page batches…</span> : error || 'Waiting for page batches to appear.'}</td></tr> : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export const PaperReaderPage = () => {
  const { paperId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { profile, logout } = useAuth();
  const { runOperation } = useOperationStatus();
  const [paper, setPaper] = useState(null);
  const [analysisActivity, setAnalysisActivity] = useState([]);
  const [analysisActivityLoading, setAnalysisActivityLoading] = useState(true);
  const [analysisActivityError, setAnalysisActivityError] = useState('');
  const [status, setStatus] = useState('Loading paper...');
  const [actionStatus, setActionStatus] = useState('');
  const role = profile?.role ?? 'student';
  const initialPage = Math.max(1, Number(searchParams.get('page') ?? 1) || 1);
  const [pageNumber, setPageNumber] = useState(initialPage);
  const questionReference = searchParams.get('question') ?? '';
  const documentType = searchParams.get('document') === 'memo' ? 'memo' : 'paper';
  const documentUrl = documentType === 'memo' ? paper?.memoUrl : paper?.paperUrl;
  const documentTitle = documentType === 'memo' ? 'Memorandum' : 'Question paper';
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

  useEffect(() => {
    setAnalysisActivityLoading(true);
    setAnalysisActivityError('');
    return subscribeQuestionPaperAnalysisActivity(paperId, (activity) => {
      setAnalysisActivity(activity);
      setAnalysisActivityLoading(false);
    }, (error) => {
      setAnalysisActivityError(error?.message || 'Live analysis status could not be loaded.');
      setAnalysisActivityLoading(false);
    });
  }, [paperId]);

  const pdfUrl = useMemo(() => {
    if (!documentUrl) return '';
    return `${documentUrl}#page=${pageNumber}&toolbar=1&navpanes=0`;
  }, [documentUrl, pageNumber]);

  const updatePage = (nextPage) => {
    const safePage = Math.max(1, nextPage);
    setPageNumber(safePage);
    const next = new URLSearchParams(searchParams);
    next.set('page', String(safePage));
    if (questionReference) next.set('question', questionReference);
    setSearchParams(next, { replace: true });
  };

  const goBack = () => {
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate(role === ROLES.TUTOR ? '/tutor/exercises' : '/student');
  };

  const handleRetry = async () => {
    if (!paper) return;
    try {
      setActionStatus('Adding analysis retry to the queue...');
      await runOperation({ operationName: 'Retrying question paper analysis', successMessage: 'The paper was queued for analysis.' }, async () => {
        await retryPaperAnalysis(paper);
        const refreshed = await getQuestionPaperById(paper.id);
        setPaper(refreshed);
      });
      setActionStatus('Analysis retry queued. It will start immediately when no other paper is being analyzed.');
    } catch (error) {
      setActionStatus(error.message || 'Could not retry analysis.');
    }
  };

  if (role === ROLES.STUDENT || role === ROLES.TUTOR) {
    return <StudentFullPagePdf paper={paper} documentUrl={documentUrl} documentTitle={documentTitle} pageNumber={pageNumber} questionReference={questionReference} status={status} onPageChange={updatePage} onBack={goBack} />;
  }

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
          <div className="flex flex-1 items-center justify-center rounded-2xl bg-slate-50 p-8 text-center text-sm text-slate-500">
            {status === 'Loading paper...'
              ? <span className="inline-flex items-center gap-2"><LoaderCircle className="h-4 w-4 animate-spin text-lime-500" aria-hidden="true" />Loading paper…</span>
              : status}
          </div>
        ) : (
          <iframe
            title="Question paper reader"
            src={pdfUrl}
            className="min-h-[70dvh] flex-1 rounded-2xl border border-slate-200 bg-white"
          />
        )}
      </div>
      {actionStatus ? <div className="panel p-4 text-sm text-slate-600">{actionStatus}</div> : null}
      {paper && canReviewAnalysis ? <AnalysisReviewPanel paper={paper} activity={analysisActivity} activityLoading={analysisActivityLoading} activityError={analysisActivityError} onRetry={handleRetry} onOpenPage={updatePage} /> : null}
    </AppShell>
  );
};
