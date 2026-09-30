import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { AppShell } from '../components/common/AppShell';
import { SectionHeader } from '../components/common/SectionHeader';
import { useAuth } from '../hooks/useAuth';
import { ROLES } from '../lib/constants';
import { getQuestionPaperById, subscribeQuestionPaperAnalysisActivity, updateQuestionPaper } from '../services/firestoreService';

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const StudentFullPagePdf = ({ paper, pageNumber, questionReference, status, onPageChange, onBack }) => {
  const viewerRef = useRef(null);
  const canvasRef = useRef(null);
  const [pdf, setPdf] = useState(null);
  const [pageCount, setPageCount] = useState(0);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [pdfStatus, setPdfStatus] = useState('Loading PDF...');

  useEffect(() => {
    if (!paper?.paperUrl) {
      setPdfStatus('This paper has no PDF file to display.');
      return undefined;
    }
    let active = true;
    const task = getDocument({ url: paper.paperUrl });
    task.promise.then((document) => {
      if (!active) return;
      setPdf(document);
      setPageCount(document.numPages);
      setPdfStatus('');
    }).catch((error) => {
      if (active) setPdfStatus(error.message || 'Could not render this PDF.');
    });
    return () => {
      active = false;
      task.destroy().catch(() => {});
    };
  }, [paper?.paperUrl]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return undefined;
    const measure = () => setSize({ width: viewer.clientWidth, height: viewer.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(viewer);
    measure();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (pageCount && pageNumber > pageCount) onPageChange(pageCount);
  }, [pageCount, pageNumber, onPageChange]);

  useEffect(() => {
    if (!pdf || !size.width || !size.height || !canvasRef.current || pageNumber > pageCount) return undefined;
    let cancelled = false;
    let renderTask;
    setPdfStatus('Rendering PDF page...');
    const renderPage = async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = Math.max(0.1, Math.min((size.width - 32) / baseViewport.width, (size.height - 32) / baseViewport.height));
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: fitScale * pixelRatio });
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d', { alpha: false });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width / pixelRatio}px`;
        canvas.style.height = `${viewport.height / pixelRatio}px`;
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
        if (!cancelled) setPdfStatus('');
      } catch (error) {
        if (!cancelled && error?.name !== 'RenderingCancelledException') setPdfStatus(error.message || 'Could not render this PDF page.');
      }
    };
    renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, pageNumber, pageCount, size]);

  const title = paper?.displayName || `${paper?.subject || 'Question paper'} ${paper?.grade || ''}`.trim();
  return (
    <main className="fixed inset-0 z-50 flex h-[100dvh] flex-col bg-slate-900 text-slate-900">
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-3 sm:px-5">
        <button type="button" className="inline-flex min-h-10 items-center gap-2 rounded-md px-2 text-sm font-semibold text-slate-700 hover:bg-slate-100" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back
        </button>
        <p className="min-w-0 flex-1 truncate text-center text-sm font-semibold text-slate-700">{title}{questionReference ? ` • Q${questionReference}` : ''}</p>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className="grid h-10 w-10 place-items-center rounded-md text-slate-700 hover:bg-slate-100 disabled:opacity-40" onClick={() => onPageChange(pageNumber - 1)} disabled={pageNumber <= 1} aria-label="Previous PDF page"><ChevronLeft className="h-5 w-5" /></button>
          <span className="min-w-14 text-center text-xs font-semibold text-slate-600">{pageCount ? `${pageNumber} / ${pageCount}` : pageNumber}</span>
          <button type="button" className="grid h-10 w-10 place-items-center rounded-md text-slate-700 hover:bg-slate-100 disabled:opacity-40" onClick={() => onPageChange(pageNumber + 1)} disabled={pageCount > 0 && pageNumber >= pageCount} aria-label="Next PDF page"><ChevronRight className="h-5 w-5" /></button>
        </div>
      </header>
      <div ref={viewerRef} className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3 sm:p-5">
        {status || pdfStatus ? <p className="text-center text-sm text-white">{status || pdfStatus}</p> : <canvas ref={canvasRef} className="block max-h-full max-w-full bg-white shadow-xl" />}
      </div>
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
    <h3 className="font-semibold text-slate-950">Extracted question metadata</h3>
    <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200">
      <div className="overflow-x-auto">
        <table className="min-w-[1040px] text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-[0.2em] text-slate-500">
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
          <tbody className="divide-y divide-slate-100">
            {questions.map((question, index) => (
              <tr key={question.id || `${question.questionReference}-${index}`} className="align-top">
                <td className="px-4 py-3 font-semibold text-slate-950">{formatValue(question.questionReference)}</td>
                <td className="px-4 py-3 text-slate-600">{formatValue(question.parentQuestion)}</td>
                <td className="px-4 py-3">
                  {question.pageNumber ? (
                    <button type="button" className="font-semibold text-brand-700 hover:text-brand-800" onClick={() => onOpenPage(question.pageNumber, question.questionReference)}>
                      Page {question.pageNumber}
                    </button>
                  ) : '-'}
                </td>
                <td className="px-4 py-3 text-slate-600">{formatValue(question.marks)}</td>
                <td className="px-4 py-3 text-slate-600">{formatValue(question.topic)}</td>
                <td className="px-4 py-3 text-slate-600">{formatValue(question.section)}</td>
                <td className="px-4 py-3 text-slate-600">
                  <p>{formatValue(question.sourceBatchId)}</p>
                  <p className="text-xs text-slate-400">{formatValue(question.sourceDocumentType)}</p>
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

const AnalysisReviewPanel = ({ paper, activity, onRetry, onOpenPage }) => {
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
      <LiveModelActivity paper={paper} activity={activity} />
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

const LiveModelActivity = ({ paper, activity }) => {
  const activeRunId = paper.activeAnalysisRunId || paper.queuedAnalysisRunId;
  const batches = activity
    .filter((batch) => !activeRunId || batch.runId === activeRunId)
    .filter((batch) => ['Queued', 'Processing', 'Failed'].includes(batch.status))
    .sort((a, b) => Number(a.pages?.[0]?.pageNumber ?? 0) - Number(b.pages?.[0]?.pageNumber ?? 0));

  if (paper.analysisStatus !== 'Analyzing' && !activeRunId && batches.length === 0) return null;

  return (
    <div>
      <h3 className="font-semibold text-slate-950">Live model activity</h3>
      <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200">
        <div className="overflow-x-auto">
          <table className="min-w-[760px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-[0.2em] text-slate-500">
              <tr><th className="px-4 py-3">Page</th><th className="px-4 py-3">Status</th><th className="px-4 py-3">Attempt</th><th className="px-4 py-3">Model</th><th className="px-4 py-3">Fallback / result</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
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
                    <td className="px-4 py-3 font-semibold text-slate-700">Page {batch.pages?.[0]?.pageNumber ?? '-'}</td>
                    <td className="px-4 py-3 text-slate-600">{batch.status}</td>
                    <td className="px-4 py-3 text-slate-600">{attempt || '-'}</td>
                    <td className="px-4 py-3 text-slate-600">{model}</td>
                    <td className="px-4 py-3 text-slate-600">{progression}</td>
                  </tr>
                );
              })}
              {!batches.length ? <tr><td colSpan="5" className="px-4 py-5 text-center text-slate-500">Waiting for page batches to appear.</td></tr> : null}
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
  const [paper, setPaper] = useState(null);
  const [analysisActivity, setAnalysisActivity] = useState([]);
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

  useEffect(() => subscribeQuestionPaperAnalysisActivity(paperId, setAnalysisActivity), [paperId]);

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

  const goBack = () => {
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate('/student');
  };

  const handleRetry = async () => {
    if (!paper) return;
    const succeeded = paper.analysisStatus === 'Analyzed' || paper.availableForGeneration;
    if (succeeded && !window.confirm(`This paper has already been analyzed. Run the analysis again for ${paper.displayName || paper.paperFileName || 'this paper'}?`)) return;
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

  if (role === ROLES.STUDENT) {
    return <StudentFullPagePdf paper={paper} pageNumber={pageNumber} questionReference={questionReference} status={paper ? '' : status} onPageChange={updatePage} onBack={goBack} />;
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
      {paper && canReviewAnalysis ? <AnalysisReviewPanel paper={paper} activity={analysisActivity} onRetry={handleRetry} onOpenPage={updatePage} /> : null}
    </AppShell>
  );
};
