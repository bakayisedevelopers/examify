import { useEffect, useMemo, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { DEFAULT_SUBJECT } from '../../lib/constants';
import {
  generateExercisePlanIfEligible,
  getAssignedStudentsForTutor,
  getQuestionPapers,
  getRoleDashboardData,
  saveCompletedLesson,
  saveTutorReport,
} from '../../services/firestoreService';
import { getApprovedTutorSubjects } from '../../utils/tutorSubjects';

export const TutorDashboardPage = () => {
  const { profile, logout } = useAuth();

  const [dashboard, setDashboard] = useState(null);
  const [students, setStudents] = useState([]);
  const [status, setStatus] = useState('');
  const approvedSubjects = useMemo(() => getApprovedTutorSubjects(profile), [profile]);
  const [selectedSubject, setSelectedSubject] = useState(approvedSubjects[0] ?? DEFAULT_SUBJECT);
  const [topicOptions, setTopicOptions] = useState([]);

  const [activeStudentId, setActiveStudentId] = useState('');
  const [reportNote, setReportNote] = useState('');
  const [lessonForm, setLessonForm] = useState({
    selectedTopic: '',
    topicUnderstandingScores: [],
    topicReport: '',
  });


  useEffect(() => {
    if (approvedSubjects.length && !approvedSubjects.includes(selectedSubject)) {
      setSelectedSubject(approvedSubjects[0]);
    }
  }, [approvedSubjects, selectedSubject]);

  const loadDashboard = async (subject = selectedSubject) => {
    if (!profile?.uid) return;
    console.log('[Examifying][TutorDashboard] load:start', { tutorId: profile.uid, subject });
    const data = await getRoleDashboardData('tutor', { tutorId: profile.uid, subject });
    setDashboard(data);
  };

  const loadAssignedStudents = async () => {
    if (!profile?.uid || !approvedSubjects.length) {
      setStudents([]);
      return;
    }

    const subjectStudentGroups = await Promise.all(
      approvedSubjects.map(async (subject) => {
        const subjectStudents = await getAssignedStudentsForTutor(profile.uid, subject);
        return subjectStudents.map((student) => ({ ...student, assignmentSubject: subject }));
      }),
    );
    setStudents(subjectStudentGroups.flat());
  };

  const loadTopicOptions = async (subject = selectedSubject) => {
    if (!subject) {
      setTopicOptions([]);
      return;
    }
    const papers = await getQuestionPapers({ subject });
    const topics = [...new Set(papers.flatMap((paper) => Array.isArray(paper.topics) ? paper.topics : []).filter(Boolean))].sort();
    setTopicOptions(topics);
  };

  useEffect(() => {
    if (!profile?.uid) return;
    loadDashboard(selectedSubject);
    loadTopicOptions(selectedSubject).catch((error) => console.error('[Examifying][TutorDashboard] topics:error', error));
  }, [profile?.uid, selectedSubject]);

  useEffect(() => {
    loadAssignedStudents().catch((error) => {
      console.error('[Examifying][TutorDashboard] assignedStudents:error', error);
      setStatus(error.message || 'Could not load assigned students.');
    });
  }, [profile?.uid, approvedSubjects.join('|')]);

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
    if (student.assignmentSubject && student.assignmentSubject !== selectedSubject) {
      setSelectedSubject(student.assignmentSubject);
      loadDashboard(student.assignmentSubject);
      loadTopicOptions(student.assignmentSubject).catch((error) => console.error('[Examifying][TutorDashboard] topics:error', error));
    }
    setActiveStudentId(studentId);
    setReportNote('');
    setLessonForm({
      selectedTopic: '',
      topicUnderstandingScores: [],
      topicReport: '',
    });
    setStatus('');
  };

  const closeStudentModal = () => {
    setActiveStudentId('');
    setReportNote('');
    setLessonForm({
      selectedTopic: '',
      topicUnderstandingScores: [],
      topicReport: '',
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

  const handleAddLessonTopic = () => {
    const topic = lessonForm.selectedTopic;
    if (!topic || lessonForm.topicUnderstandingScores.some((entry) => entry.topic === topic)) return;
    setLessonForm((current) => ({
      ...current,
      selectedTopic: '',
      topicUnderstandingScores: [
        ...current.topicUnderstandingScores,
        { topic, understandingLevel: 5 },
      ],
    }));
  };

  const handleRemoveLessonTopic = (topic) => {
    setLessonForm((current) => ({
      ...current,
      topicUnderstandingScores: current.topicUnderstandingScores.filter((entry) => entry.topic !== topic),
    }));
  };

  const handleTopicUnderstandingChange = (topic, value) => {
    setLessonForm((current) => ({
      ...current,
      topicUnderstandingScores: current.topicUnderstandingScores.map((entry) => (
        entry.topic === topic ? { ...entry, understandingLevel: Number(value) } : entry
      )),
    }));
  };

  const handleCompleteLesson = async () => {
    if (!activeStudent || !activeStudentFirestoreId) {
      setStatus('Please select a student first.');
      return;
    }

    if (!lessonForm.topicUnderstandingScores.length) {
      setStatus('Please choose at least one analyzed topic for this lesson.');
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

      const topicNames = lessonForm.topicUnderstandingScores.map((entry) => entry.topic);
      const averageUnderstanding = Math.round(lessonForm.topicUnderstandingScores.reduce((sum, entry) => sum + Number(entry.understandingLevel ?? 5), 0) / Math.max(1, lessonForm.topicUnderstandingScores.length));
      const topicScoresText = lessonForm.topicUnderstandingScores.map((entry) => `${entry.topic}: ${Number(entry.understandingLevel ?? 5)}/10`).join('\n');

      const newEntryFormatted = `
        --- ${topicNames.join(' | ')} ---
        Topics from analyzed papers:
        ${topicScoresText}
        Tutor Topic Report:
        ${lessonForm.topicReport}
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
        topic: topicNames[0],
        topics: topicNames,
        topicUnderstandingScores: lessonForm.topicUnderstandingScores.map((entry) => ({ ...entry, topicReport: lessonForm.topicReport })),
        topicReport: lessonForm.topicReport,
        understandingLevel: averageUnderstanding,
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
        understandingLevel: averageUnderstanding,
        availablePapers,
        onProgress: (message) => setStatus(message),
      });

      console.log('[Examifying][TutorDashboard] completeLesson:generation', generation);

      setLessonForm({
        selectedTopic: '',
        topicUnderstandingScores: [],
        topicReport: '',
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
    >
      {!approvedSubjects.length ? (
        <div className="panel p-5 text-sm text-amber-700">Add approved subjects from your profile before students can be assigned to you.</div>
      ) : null}

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
                const studentSubject = student.assignmentSubject ?? selectedSubject;
                const studentHasReport = Boolean((student.latestReportsBySubject?.[studentSubject] || (studentSubject === DEFAULT_SUBJECT ? student.latestReport : '') || '').trim());

                return (
                  <button
                    key={`${student.uid || student.id}-${student.assignmentSubject ?? selectedSubject}`}
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
                          {student.grade || '?'} • {student.province || '?'} • {student.assignmentSubject ?? selectedSubject}
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
                No students are assigned to you yet.
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
                  {activeStudent.grade || '?'} • {activeStudent.province || '?'} • {selectedSubject} •{' '}
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

                  <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
                    <select
                      className="input"
                      value={lessonForm.selectedTopic}
                      onChange={(event) => setLessonForm((current) => ({ ...current, selectedTopic: event.target.value }))}
                      disabled={!topicOptions.length}
                    >
                      <option value="">{topicOptions.length ? 'Choose topic from analyzed papers' : 'No analyzed topics available yet'}</option>
                      {topicOptions.map((topic) => <option key={topic} value={topic}>{topic}</option>)}
                    </select>
                    <button type="button" className="btn-secondary" onClick={handleAddLessonTopic} disabled={!lessonForm.selectedTopic}>Add topic</button>
                  </div>

                  {lessonForm.topicUnderstandingScores.length ? (
                    <div className="space-y-3 rounded-2xl bg-slate-50 p-4">
                      {lessonForm.topicUnderstandingScores.map((entry) => (
                        <div key={entry.topic} className="grid gap-3 rounded-xl bg-white p-3 md:grid-cols-[1fr_160px_auto] md:items-center">
                          <p className="text-sm font-semibold text-slate-900">{entry.topic}</p>
                          <label>
                            <span className="label">Understanding</span>
                            <input
                              type="number"
                              min="0"
                              max="10"
                              className="input"
                              value={entry.understandingLevel}
                              onChange={(event) => handleTopicUnderstandingChange(entry.topic, event.target.value)}
                            />
                          </label>
                          <button type="button" className="btn-secondary text-sm" onClick={() => handleRemoveLessonTopic(entry.topic)}>Remove</button>
                        </div>
                      ))}
                    </div>
                  ) : null}

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


                  <button
                    type="button"
                    className="btn-primary"
                    onClick={handleCompleteLesson}
                    disabled={!lessonForm.topicUnderstandingScores.length || !lessonForm.topicReport.trim()}
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
                          <p className="font-semibold text-slate-950">{Array.isArray(lesson.topics) && lesson.topics.length ? lesson.topics.join(' | ') : lesson.topic}</p>
                          <p className="mt-1 text-sm text-slate-500">
                            Understanding: {Array.isArray(lesson.topicUnderstandingScores) && lesson.topicUnderstandingScores.length ? lesson.topicUnderstandingScores.map((entry) => `${entry.topic}: ${entry.understandingLevel}/10`).join(', ') : `${lesson.understandingLevel}/10`}
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
