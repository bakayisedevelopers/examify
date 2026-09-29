import { useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { StatCard } from '../../components/common/StatCard';
import { useAuth } from '../../hooks/useAuth';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import {
  generateExercisePlanIfEligible,
  getQuestionPapers,
  getRoleDashboardData,
  saveCompletedLesson,
  saveTutorReport,
  subscribeToAssignedStudentsForTutor,
} from '../../services/firestoreService';
import { uploadTutorMarksDocument } from '../../services/storageService';
import { getApprovedTutorSubjects } from '../../utils/tutorSubjects';

export const TutorDashboardPage = () => {
  const { profile, logout, refreshProfile } = useAuth();

  const [dashboard, setDashboard] = useState(null);
  const [students, setStudents] = useState([]);
  const [status, setStatus] = useState('');
  const approvedSubjects = useMemo(() => getApprovedTutorSubjects(profile), [profile]);
  const [selectedSubject, setSelectedSubject] = useState(approvedSubjects[0] ?? DEFAULT_SUBJECT);
  const [marksFile, setMarksFile] = useState(null);
  const [marksUploadStatus, setMarksUploadStatus] = useState('');
  const [marksUploadResult, setMarksUploadResult] = useState(null);
  const [isUploadingMarks, setIsUploadingMarks] = useState(false);
  const marksUploadFormRef = useRef(null);

  const [activeStudentId, setActiveStudentId] = useState('');
  const [reportNote, setReportNote] = useState('');
  const [lessonForm, setLessonForm] = useState({
    topic: '',
    topicReport: '',
    understandingLevel: 5,
  });


  useEffect(() => {
    if (approvedSubjects.length && !approvedSubjects.includes(selectedSubject)) {
      setSelectedSubject(approvedSubjects[0]);
    }
  }, [approvedSubjects, selectedSubject]);

  const handleMarksUpload = async (event) => {
    event.preventDefault();

    if (!marksFile) {
      setMarksUploadStatus('Please choose a marks document first.');
      return;
    }

    try {
      setIsUploadingMarks(true);
      setMarksUploadStatus('Uploading marks document and extracting subjects...');
      const result = await uploadTutorMarksDocument({ file: marksFile, tutor: profile, onProgress: setMarksUploadStatus });
      setMarksUploadResult(result);
      await refreshProfile(profile.uid);

      if (result.addedSubjects.length) {
        setSelectedSubject(result.addedSubjects[0]);
        setMarksUploadStatus(`Approved subject${result.addedSubjects.length === 1 ? '' : 's'} added: ${result.addedSubjects.join(', ')}.`);
      } else if (result.extractedMarks.length) {
        setMarksUploadStatus('Marks were extracted, but no new eligible subjects were found at 60% or above.');
      } else {
        setMarksUploadStatus('No eligible subjects could be extracted from the document. Please upload a clearer marks document.');
      }

      setMarksFile(null);
      marksUploadFormRef.current?.reset();
    } catch (error) {
      console.error('[Examifying][TutorDashboard] marksUpload:error', error);
      setMarksUploadStatus(error.message || 'Failed to process marks document.');
    } finally {
      setIsUploadingMarks(false);
    }
  };

  const loadDashboard = async () => {
    if (!profile?.uid) return;
    console.log('[Examifying][TutorDashboard] load:start', { tutorId: profile.uid });
    const data = await getRoleDashboardData('tutor', { tutorId: profile.uid, subject: selectedSubject });
    setDashboard(data);
  };

  useEffect(() => {
    if (!profile?.uid) return;

    loadDashboard();

    const unsub1 = subscribeToAssignedStudentsForTutor(profile.uid, (data) => {
      setStudents(data);
    }, selectedSubject);

    return () => {
      unsub1();
    };
  }, [profile?.uid, selectedSubject]);

  const activeStudent =
    students.find((student) => (student.uid || student.id) === activeStudentId) ?? null;

  const activeStudentFirestoreId = activeStudent?.uid || activeStudent?.id || '';

  const filteredReports = useMemo(() => {
    if (!dashboard?.reports || !activeStudent) return [];

    const currentStudentId = activeStudent.uid || activeStudent.id;
    const currentStudentName = activeStudent.displayName || activeStudent.name || '';

    return dashboard.reports.filter((report) => {
      const reportStudentId = report.studentId || report.uid || report.userId;
      const reportStudentName = report.studentName || report.name || '';
      return (
        (reportStudentId && reportStudentId === currentStudentId) ||
        (reportStudentName && reportStudentName === currentStudentName)
      );
    });
  }, [dashboard?.reports, activeStudent]);

  const activeSubjectReport = activeStudent?.latestReportsBySubject?.[selectedSubject] || filteredReports[0]?.note || (selectedSubject === DEFAULT_SUBJECT ? activeStudent?.latestReport : '') || '';
  const hasInitialReport = Boolean(activeSubjectReport.trim());

  const filteredCompletedLessons = useMemo(() => {
    if (!dashboard?.completedTopics || !activeStudent) return [];

    const currentStudentId = activeStudent.uid || activeStudent.id;
    const currentStudentName = activeStudent.displayName || activeStudent.name || '';

    return dashboard.completedTopics.filter((lesson) => {
      const lessonStudentId = lesson.studentId || lesson.uid || lesson.userId;
      const lessonStudentName = lesson.studentName || lesson.name || '';
      return (
        (lessonStudentId && lessonStudentId === currentStudentId) ||
        (lessonStudentName && lessonStudentName === currentStudentName)
      );
    });
  }, [dashboard?.completedTopics, activeStudent]);

  const openStudentModal = (student) => {
    const studentId = student.uid || student.id || '';
    setActiveStudentId(studentId);
    setReportNote('');
    setLessonForm({
      topic: '',
      topicReport: '',
      understandingLevel: 5,
    });
    setStatus('');
  };

  const closeStudentModal = () => {
    setActiveStudentId('');
    setReportNote('');
    setLessonForm({
      topic: '',
      topicReport: '',
      understandingLevel: 5,
    });
  };

  const handleSaveInitialReport = async () => {
    if (!activeStudent || !activeStudentFirestoreId) {
      setStatus('Please select a student first.');
      return;
    }

    if (!reportNote.trim()) {
      setStatus('Please enter the initial report before saving.');
      return;
    }

    try {
      console.log('[Examifying][TutorDashboard] saveInitialReport:start', {
        studentId: activeStudentFirestoreId,
      });

      const newEntryFormatted = `
      --- Report for: ${activeStudent.displayName || activeStudent.name || 'Student'} ---

      Report Entry:
      ${reportNote}
      Date: ${new Date().toLocaleString()}`;

      await saveTutorReport({
        studentId: activeStudentFirestoreId,
        tutorId: profile?.uid,
        subject: selectedSubject,
        reportType: 'initial',
        note: newEntryFormatted,
        studentName: activeStudent.displayName || activeStudent.name || 'Student',
      });

      console.log('[Examifying][TutorDashboard] saveInitialReport:success');
      setReportNote('');
      setStatus('Initial report saved successfully.');
      await loadDashboard();
    } catch (error) {
      console.error('[Examifying][TutorDashboard] saveInitialReport:error', error);
      setStatus(error.message || 'Failed to save initial report.');
    }
  };

  const handleCompleteLesson = async () => {
    if (!activeStudent || !activeStudentFirestoreId) {
      setStatus('Please select a student first.');
      return;
    }

    if (!lessonForm.topic.trim()) {
      setStatus('Please enter the topic name.');
      return;
    }

    if (!lessonForm.topicReport.trim()) {
      setStatus('Please enter the lesson report.');
      return;
    }

    try {
      console.log('[Examifying][TutorDashboard] completeLesson:start', {
        studentId: activeStudentFirestoreId,
        lessonForm,
      });

      const newEntryFormatted = `
        --- ${lessonForm.topic} ---
        Topic: ${lessonForm.topic}
        Tutor Topic Report:
        ${lessonForm.topicReport}
        Understanding Level: ${Number(lessonForm.understandingLevel)}/10
        Date: ${new Date().toLocaleString()}
      `;

      await saveTutorReport({
        studentId: activeStudentFirestoreId,
        tutorId: profile?.uid,
        subject: selectedSubject,
        reportType: 'lesson',
        note: newEntryFormatted,
        studentName: activeStudent.displayName || activeStudent.name || 'Student',
      });

      const lesson = await saveCompletedLesson({
        studentId: activeStudentFirestoreId,
        tutorId: profile?.uid,
        topic: lessonForm.topic,
        topicReport: lessonForm.topicReport,
        understandingLevel: Number(lessonForm.understandingLevel),
        studentName: activeStudent.displayName || activeStudent.name || 'Student',
        subject: selectedSubject,
      });

      const availablePapers = await getQuestionPapers({
        grade: activeStudent.grade,
        region: activeStudent.province,
        subject: selectedSubject,
      });

      const generation = await generateExercisePlanIfEligible({
        student: {
          uid: activeStudentFirestoreId,
          grade: activeStudent.grade,
          province: activeStudent.province,
          paymentCompleted: activeStudent.paymentCompleted,
        },
        mode: 'weekly',
        subject: selectedSubject,
        completedLesson: lesson,
        understandingLevel: Number(lessonForm.understandingLevel),
        availablePapers,
        onProgress: (message) => setStatus(message),
      });

      console.log('[Examifying][TutorDashboard] completeLesson:generation', generation);

      setLessonForm({
        topic: '',
        topicReport: '',
        understandingLevel: 5,
      });

      setStatus(
        generation.generated
          ? 'Lesson saved and weekly exercise generation was triggered successfully.'
          : 'Lesson saved, but weekly generation is still waiting for payment or matching papers.'
      );

      await loadDashboard();
    } catch (error) {
      console.error('[Examifying][TutorDashboard] completeLesson:error', error);
      setStatus(error.message || 'Failed to complete lesson.');
    }
  };

  if (!dashboard) return null;

  return (
    <AppShell
      title="Tutor dashboard"
      subtitle="Assign students, open a learner profile, create the initial report once, then continue with lesson completion and weekly AI generation."
      role="tutor"
      user={profile}
      onLogout={logout}
      mobileHeaderContent={(
        <select
          className="input mx-auto w-full max-w-[12rem] py-2 text-xs font-semibold"
          value={selectedSubject}
          onChange={(event) => setSelectedSubject(event.target.value)}
          disabled={!approvedSubjects.length}
          aria-label="Select subject"
        >
          {approvedSubjects.map((subject) => <option key={subject}>{subject}</option>)}
        </select>
      )}
    >
      <section className="panel space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-slate-950">Approved tutor subjects</p>
            <p className="mt-1 text-xs text-slate-500">Upload your marks document. AI extracts subjects and only adds approved subjects with marks of 60% or above.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {approvedSubjects.length ? approvedSubjects.map((subject) => (
              <span key={subject} className="rounded-full bg-brand-50 px-3 py-1 text-sm font-semibold text-brand-700">{subject}</span>
            )) : <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-700">No approved subjects yet</span>}
          </div>
        </div>

        <form ref={marksUploadFormRef} onSubmit={handleMarksUpload} className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <input
            type="file"
            className="input"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif"
            onChange={(event) => setMarksFile(event.target.files?.[0] ?? null)}
          />
          <button type="submit" className="btn-primary" disabled={isUploadingMarks}>
            {isUploadingMarks ? 'Checking marks...' : 'Upload marks proof'}
          </button>
        </form>

        {marksUploadStatus ? <p className="text-sm text-slate-600">{marksUploadStatus}</p> : null}
        {marksUploadResult?.extractedMarks?.length ? (
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-950">Extracted marks</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {marksUploadResult.extractedMarks.map((item) => (
                <div key={`${item.subject}-${item.mark}`} className="rounded-xl bg-white px-3 py-2 text-sm">
                  <p className="font-semibold text-slate-900">{item.subject}</p>
                  <p className={Number(item.mark) >= 60 ? 'text-emerald-600' : 'text-slate-500'}>{item.mark}%</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <div className="panel hidden flex-wrap items-center justify-between gap-3 p-4 lg:flex">
        <div>
          <p className="text-sm font-semibold text-slate-950">Subject</p>
          <p className="text-xs text-slate-500">Student assignment, lessons, reports, and generation use one of your approved subjects.</p>
        </div>
        <select className="input max-w-xs" value={selectedSubject} onChange={(event) => setSelectedSubject(event.target.value)} disabled={!approvedSubjects.length}>
          {approvedSubjects.map((subject) => <option key={subject}>{subject}</option>)}
        </select>
      </div>

      {!approvedSubjects.length ? (
        <div className="panel p-5 text-sm text-amber-700">Upload a marks document to unlock subjects before students can be assigned to you.</div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {(dashboard.stats ?? []).map((item) => (
          <StatCard key={item.label} {...item} />
        ))}
      </section>

      <section className="grid gap-6">
        <div className="space-y-6">
          <SectionHeader
            eyebrow="Students"
            title="Assigned learners"
            description="Click a student to open their report, lesson completion, reports, and completed lessons."
          />

          <div className="space-y-4">
            {students.length ? (
              students.map((student) => {
                const studentHasReport = Boolean((student.latestReportsBySubject?.[selectedSubject] || (selectedSubject === DEFAULT_SUBJECT ? student.latestReport : '') || '').trim());

                return (
                  <button
                    key={student.uid || student.id}
                    type="button"
                    onClick={() => openStudentModal(student)}
                    className="panel block w-full p-5 text-left transition hover:shadow-lg"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-lg font-semibold text-slate-950">
                          {student.displayName || student.name || 'Student'}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          {student.grade || '?'} • {student.province || '?'}
                        </p>
                        <p className="mt-2 text-xs text-slate-500">
                          {studentHasReport
                            ? 'Initial report exists. Click to continue lessons and view history.'
                            : 'No initial report yet. Click to create the first report.'}
                        </p>
                      </div>

                      <div className="flex flex-col items-end gap-2">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] ${
                            student.paymentCompleted
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}
                        >
                          {student.paymentCompleted ? 'paid' : 'unpaid'}
                        </span>

                        <span
                          className={`rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] ${
                            studentHasReport
                              ? 'bg-sky-100 text-sky-700'
                              : 'bg-slate-200 text-slate-700'
                          }`}
                        >
                          {studentHasReport ? 'report ready' : 'report needed'}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })
            ) : (
              <div className="panel p-5 text-sm text-slate-500">
                No students are assigned to you for this subject yet.
              </div>
            )}
          </div>
        </div>
      </section>

      {status ? <div className="panel p-4 text-sm text-slate-700">{status}</div> : null}

      {activeStudent ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4">
          <div className="max-h-[90vh] w-full max-w-6xl overflow-y-auto rounded-3xl bg-white shadow-2xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-slate-500">
                  Student details
                </p>
                <h2 className="mt-2 text-2xl font-bold text-slate-950">
                  {activeStudent.displayName || activeStudent.name || 'Student'}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {activeStudent.grade || '?'} • {activeStudent.province || '?'} •{' '}
                  {activeStudent.paymentCompleted ? 'Paid' : 'Unpaid'}
                </p>
              </div>

              <button
                type="button"
                className="rounded-2xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                onClick={closeStudentModal}
              >
                Close
              </button>
            </div>

            <div className="space-y-6 p-6">
              {!hasInitialReport ? (
                <section className="panel space-y-4 p-6">
                  <SectionHeader
                    eyebrow="Initial Report"
                    title="Student report upon adding"
                    description="This section only appears before the first report is created for this student."
                  />

                  <textarea
                    className="input min-h-40"
                    value={reportNote}
                    onChange={(event) => setReportNote(event.target.value)}
                    placeholder="Explain the student's capabilities, weaknesses, and readiness."
                  />

                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleSaveInitialReport}
                    disabled={!reportNote.trim()}
                  >
                    Save initial report
                  </button>
                </section>
              ) : null}

              {hasInitialReport ? (
                <section className="panel space-y-4 p-6">
                  <SectionHeader
                    eyebrow="Lesson complete"
                    title="Complete topic and trigger weekly generation"
                    description="This section appears after the initial report already exists for the selected subject. Each lesson updates the subject report history."
                  />

                  <input
                    className="input"
                    value={lessonForm.topic}
                    onChange={(event) =>
                      setLessonForm((current) => ({ ...current, topic: event.target.value }))
                    }
                    placeholder="Topic name covered"
                  />

                  <textarea
                    className="input min-h-32"
                    value={lessonForm.topicReport}
                    onChange={(event) =>
                      setLessonForm((current) => ({
                        ...current,
                        topicReport: event.target.value,
                      }))
                    }
                    placeholder="Topic-specific report for the student"
                  />

                  <label>
                    <span className="label">Understanding level (0 - 10)</span>
                    <input
                      type="number"
                      min="0"
                      max="10"
                      className="input"
                      value={lessonForm.understandingLevel}
                      onChange={(event) =>
                        setLessonForm((current) => ({
                          ...current,
                          understandingLevel: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleCompleteLesson}
                    disabled={!lessonForm.topic.trim() || !lessonForm.topicReport.trim()}
                  >
                    Mark lesson complete
                  </button>
                </section>
              ) : null}

              <section className="grid gap-6 xl:grid-cols-[1fr_1fr]">
                <div className="panel p-6">
                  <SectionHeader
                    eyebrow="Reports"
                    title="Latest tutor reports"
                    description="This shows reports linked to the selected student."
                  />

                  <div className="mt-4 space-y-3">
                    {filteredReports.length ? (
                      filteredReports.map((report) => (
                        <div key={report.id} className="rounded-2xl bg-slate-50 p-4">
                          <p className="font-semibold text-slate-950">
                            {report.studentName || activeStudent.displayName || activeStudent.name}
                          </p>
                          <p className="mt-2 text-sm text-slate-600">{report.note}</p>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">
                        No tutor reports found for this student yet.
                      </div>
                    )}
                  </div>
                </div>

                <div className="panel p-6">
                  <SectionHeader
                    eyebrow="Completed lessons"
                    title="Topic readiness"
                    description="Understanding scores flow into the weekly exercise generation logic."
                  />

                  <div className="mt-4 space-y-3">
                    {filteredCompletedLessons.length ? (
                      filteredCompletedLessons.map((lesson) => (
                        <div key={lesson.id} className="rounded-2xl bg-slate-50 p-4">
                          <p className="font-semibold text-slate-950">{lesson.topic}</p>
                          <p className="mt-1 text-sm text-slate-500">
                            Understanding: {lesson.understandingLevel}/10
                          </p>
                          <p className="mt-2 text-sm text-slate-600">
                            {lesson.topicReport ?? lesson.note}
                          </p>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">
                        No completed lessons found for this student yet.
                      </div>
                    )}
                  </div>
                </div>
              </section>

              {hasInitialReport ? (
                <section className="panel p-6">
                  <SectionHeader
                    eyebrow="Latest report"
                    title="Current subject report value"
                    description="This is the latest report for the selected subject and is used for AI context."
                  />
                  <pre className="mt-4 whitespace-pre-wrap rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
                    {activeSubjectReport || 'No latest report found.'}
                  </pre>
                </section>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </AppShell>
  );
};
