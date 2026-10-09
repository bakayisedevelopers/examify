import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { OperationStatusOverlay } from '../../components/common/OperationStatusOverlay';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { DEFAULT_SUBJECT, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { LessonAccessDetails } from '../../components/lessons/LessonAccessDetails';
import { CopyTextButton } from '../../components/common/CopyTextButton';
import { getWhatsAppChatUrl } from '../../utils/whatsapp';
import {
  completeLessonSession,
  deleteLessonSession,
  generateExercisePlanIfEligible,
  getGlobalTopicOptionGroups,
  getLessonEligibleSubjectGradePairs,
  getLessonsByGroupSessionId,
  getLessonById,
  getQuestionPapers,
  getTutorAssignedStudentContexts,
  savePlannedLessonSession,
  updatePlannedLessonDetails,
  updatePlannedLessonRoster,
} from '../../services/firestoreService';
import { useEffectiveRole } from '../../utils/effectiveRole';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { MessageCircle } from 'lucide-react';

const today = () => {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
};
const emptyTopicGroups = { extracted: [], manual: [], all: [] };
const emptyParticipant = () => ({ attended: true, topicReport: '', scores: {} });
const createSessionId = () => globalThis.crypto?.randomUUID?.() ?? `lesson-group-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const asDate = (value) => value?.toDate?.() ?? (value instanceof Date ? value : value ? new Date(value) : null);
const johannesburgDateKey = (value) => {
  const date = asDate(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const getStudentLabel = (student) => student.displayName || student.name || student.email || student.studentId;
const lessonRatioToInputScore = (value) => {
  const score = Number(value);
  const ratio = score > 1 && score <= 10 ? score / 10 : score;
  return Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? Math.round(ratio * 100) / 10 : '';
};
const getLessonErrorMessage = (error, fallback) => {
  const message = String(error?.message || '').trim();
  if (error?.code === 'permission-denied' || /missing or insufficient permissions/i.test(message)) {
    return 'Firestore rejected this lesson. Confirm you have co-owner access to every selected student and that the latest Firestore rules are deployed.';
  }
  if (error?.code === 'unavailable' || /network|offline/i.test(message)) {
    return 'Could not reach Firestore. Check your connection and try creating the lesson again.';
  }
  return message || fallback;
};

export const TutorLessonDetailsPage = () => {
  const { lessonId } = useParams();
  const isNew = lessonId === 'new';
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const { role, basePath } = useEffectiveRole();
  const { operationStatus, runOperation, closeOperationStatus } = useOperationStatus();
  const [contexts, setContexts] = useState([]);
  const [contextsLoaded, setContextsLoaded] = useState(false);
  const [existingLessonLoading, setExistingLessonLoading] = useState(!isNew);
  const [eligibleSubjectGrades, setEligibleSubjectGrades] = useState([]);
  const [eligibilityLoaded, setEligibilityLoaded] = useState(false);
  const [eligibilityError, setEligibilityError] = useState('');
  const [subject, setSubject] = useState(DEFAULT_SUBJECT);
  const [grade, setGrade] = useState('');
  const [sessionMode, setSessionMode] = useState('one-on-one');
  const [lessonType, setLessonType] = useState('online');
  const [whatsappLessonLink, setWhatsAppLessonLink] = useState('');
  const [locationDetails, setLocationDetails] = useState('');
  const [lessonDate, setLessonDate] = useState(today());
  const [selectedStudentIds, setSelectedStudentIds] = useState([]);
  const [studentsToAdd, setStudentsToAdd] = useState([]);
  const [topicOptions, setTopicOptions] = useState(emptyTopicGroups);
  const [topics, setTopics] = useState([]);
  const [selectedTopic, setSelectedTopic] = useState('');
  const [lessonRows, setLessonRows] = useState([]);
  const [participants, setParticipants] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState('info');
  const [plannedRequestId, setPlannedRequestId] = useState(createSessionId);
  const [pendingOperationNavigation, setPendingOperationNavigation] = useState('');

  const plannedRequestFingerprint = JSON.stringify({
    subject, grade, lessonDate, lessonType, whatsappLessonLink, locationDetails, sessionMode,
    selectedStudentIds: [...selectedStudentIds].sort(), topics,
  });

  useEffect(() => {
    setPlannedRequestId(createSessionId());
  }, [plannedRequestFingerprint]);

  const getStudentLessonBlocker = useCallback((student, mode = sessionMode, date = lessonDate) => {
    const planId = student.activeSubjectPlanId || student.lessonQuota?.planId || student.subscriptionPlanId;
    if (!['circle', 'personalized'].includes(planId)) return 'This active subject does not have a schedulable lesson plan.';
    if (planId === 'circle' && mode !== 'group') return 'The Circle plan includes group lessons only.';
    if (planId === 'personalized' && !['group', 'one-on-one'].includes(mode)) return 'This plan does not include the selected lesson format.';
    const quota = student.lessonQuota;
    const renewalKey = johannesburgDateKey(quota?.renewalDate || student.activeSubjectRenewalDate || student.subscriptionRenewalDate);
    const startKey = johannesburgDateKey(quota?.windowStartAt || student.activeSubjectWindowStartAt || student.entitlementWindowStartAt);
    if (renewalKey && date >= renewalKey) return 'Choose a date before this student’s subscription renews.';
    if (startKey && date < startKey) return 'Choose a date on or after this student’s subscription activation.';
    const bucket = quota?.[mode === 'group' ? 'group' : 'oneOnOne'];
    const remaining = Number(bucket?.remaining);
    if (Number.isFinite(remaining) && remaining < 1) return `No ${mode === 'group' ? 'group' : 'one-on-one'} lesson quota remains this cycle.`;
    return '';
  }, [lessonDate, sessionMode]);

  useEffect(() => {
    if (!profile?.uid) return;
    getTutorAssignedStudentContexts(profile.uid)
      .then((rows) => {
        setContexts(rows);
        const firstOwner = rows.find((row) => row.accessRole === 'co-owner');
        if (firstOwner) {
          setSubject(firstOwner.subject || DEFAULT_SUBJECT);
          setGrade(firstOwner.grade || '');
        }
      })
      .catch((error) => {
        setStatus(getLessonErrorMessage(error, 'Could not load assigned students.'));
        setStatusTone('error');
      })
      .finally(() => setContextsLoaded(true));
  }, [profile?.uid]);

  useEffect(() => {
    if (!isNew || !contextsLoaded) return undefined;
    let cancelled = false;
    setEligibilityLoaded(false);
    setEligibilityError('');
    getLessonEligibleSubjectGradePairs(contexts.filter((context) => context.accessRole === 'co-owner'))
      .then((pairs) => { if (!cancelled) setEligibleSubjectGrades(pairs); })
      .catch((error) => {
        if (!cancelled) {
          setEligibleSubjectGrades([]);
          setEligibilityError(error.message || 'Could not check analyzed question papers for your assigned subjects.');
        }
      })
      .finally(() => { if (!cancelled) setEligibilityLoaded(true); });
    return () => { cancelled = true; };
  }, [contexts, contextsLoaded, isNew]);

  useEffect(() => {
    if (!isNew || !eligibilityLoaded || !eligibleSubjectGrades.length) return;
    const subjectPairs = eligibleSubjectGrades.filter((pair) => pair.subject === subject);
    if (!subjectPairs.length) {
      const firstPair = eligibleSubjectGrades[0];
      setSubject(firstPair.subject);
      setGrade(firstPair.grade);
      setSelectedStudentIds([]);
      setTopics([]);
      return;
    }
    if (!subjectPairs.some((pair) => pair.grade === grade)) {
      setGrade(subjectPairs[0].grade);
      setSelectedStudentIds([]);
      setTopics([]);
    }
  }, [eligibleSubjectGrades, eligibilityLoaded, grade, isNew, subject]);

  useEffect(() => {
    if (isNew || !lessonId || !contextsLoaded || !profile?.uid) return;
    let cancelled = false;
    setExistingLessonLoading(true);
    const load = async () => {
      const lesson = await getLessonById(lessonId, { tutorId: profile.uid });
      if (!lesson) throw new Error('Lesson not found.');
      const rows = lesson.groupSessionId
        ? await getLessonsByGroupSessionId(lesson.groupSessionId, profile.uid)
        : [lesson];
      const accessibleRows = rows.filter((row) => contexts.some((context) =>
        context.studentId === row.studentId
        && context.subject === (row.subject || DEFAULT_SUBJECT)
        && context.accessRole === 'co-owner'));
      if (!accessibleRows.some((row) => row.id === lessonId)) throw new Error('This lesson is not available to your account.');
      if (accessibleRows.length !== rows.length) throw new Error('Some students in this session are no longer available under your current co-owner access. Ask an admin to review the assignments before editing the session.');
      if (cancelled) return;

      setLessonRows(accessibleRows);
      setSubject(lesson.subject || DEFAULT_SUBJECT);
      setGrade(lesson.grade || contexts.find((context) => context.studentId === lesson.studentId && context.subject === lesson.subject)?.grade || '');
      setSessionMode(lesson.sessionMode || 'one-on-one');
      setLessonType(lesson.lessonType || 'online');
      setWhatsAppLessonLink(lesson.whatsappLessonLink || '');
      setLocationDetails(lesson.locationDetails || '');
      setLessonDate(lesson.lessonDate || lesson.completedOn || today());
      setSelectedStudentIds(accessibleRows.map((row) => row.studentId));
      const allTopics = [...new Set(accessibleRows.flatMap((row) => row.topics?.length ? row.topics : (row.topic ? [row.topic] : [])))];
      setTopics(allTopics);
      setParticipants(Object.fromEntries(accessibleRows.map((row) => {
        const scores = Object.fromEntries((row.topicUnderstandingScores || []).map((entry) => [entry.topic, lessonRatioToInputScore(entry.understandingLevel)]));
        return [row.id, {
          attended: row.attendanceStatus === 'missed' || row.attended === false ? false : true,
          topicReport: row.topicReport || row.note || '',
          scores,
        }];
      })));
    };
    load().catch((error) => { if (!cancelled) setStatus(error.message || 'Could not load the lesson.'); })
      .finally(() => { if (!cancelled) setExistingLessonLoading(false); });
    return () => { cancelled = true; };
  }, [contexts, contextsLoaded, isNew, lessonId, profile?.uid]);

  const subjectOptions = useMemo(() => [...new Set(eligibleSubjectGrades.map((pair) => pair.subject))].sort(), [eligibleSubjectGrades]);
  const gradeOptions = useMemo(() => [...new Set(eligibleSubjectGrades
    .filter((pair) => pair.subject === subject)
    .map((pair) => pair.grade)
    .filter(Boolean))].sort((left, right) => SOUTH_AFRICAN_GRADES.indexOf(left) - SOUTH_AFRICAN_GRADES.indexOf(right)), [eligibleSubjectGrades, subject]);
  const availableStudents = useMemo(() => contexts
    .filter((context) => context.accessRole === 'co-owner'
      && (context.subject || DEFAULT_SUBJECT) === subject
      && (context.grade || '') === grade
      && eligibleSubjectGrades.some((pair) => pair.subject === (context.subject || DEFAULT_SUBJECT) && pair.grade === (context.grade || '')))
    .filter((context, index, list) => list.findIndex((row) => row.studentId === context.studentId) === index), [contexts, eligibleSubjectGrades, grade, subject]);
  const canManageExisting = isNew || (lessonRows.length > 0 && lessonRows.every((row) => contexts.some((context) =>
    context.studentId === row.studentId
    && context.subject === (row.subject || DEFAULT_SUBJECT)
    && context.accessRole === 'co-owner')));
  const isEditable = canManageExisting && (isNew || (lessonRows.length > 0
    && lessonRows.every((row) => ['planned', 'incomplete', 'lesson_log_pending'].includes(row.status))));
  const canCancelSession = canManageExisting && lessonRows.length > 0
    && lessonRows.every((row) => ['planned', 'incomplete'].includes(row.status));
  const canEditPlannedRoster = canManageExisting
    && sessionMode === 'group'
    && lessonRows.length > 0
    && lessonDate >= today()
    && lessonRows.every((row) => row.status === 'planned');
  const rosterStudentIds = new Set(lessonRows.map((row) => row.studentId));
  const addableStudents = availableStudents.filter((student) => !rosterStudentIds.has(student.studentId));
  const selectedStudents = selectedStudentIds
    .map((studentId) => availableStudents.find((student) => student.studentId === studentId))
    .filter(Boolean);
  const createBlocker = useMemo(() => {
    if (!isNew) return '';
    if (!profile?.uid) return 'Your tutor profile is still loading. Wait a moment and try again.';
    if (!contextsLoaded) return 'Loading your assigned students…';
    if (!eligibilityLoaded) return 'Checking analyzed question papers and the subject topic list…';
    if (eligibilityError) return `Could not verify lesson subjects: ${eligibilityError}`;
    if (!contexts.some((context) => context.accessRole === 'co-owner')) {
      return 'No active co-owner student assignments were found. Ask an admin to assign you as a co-owner, then reload this page.';
    }
    if (!subjectOptions.length) return 'No assigned subject has an analyzed question paper and a topic list for its grade. Analyze a paper before creating lessons.';
    if (!grade) return 'Choose a grade to load the students assigned to you for that grade.';
    if (!availableStudents.length) return `There are no active co-owner students for ${subject}, ${grade}. Check the student assignment or choose another grade.`;
    if (sessionMode === 'group' && selectedStudents.length < 2) return 'Select at least two assigned students to create a group lesson.';
    if (sessionMode === 'one-on-one' && selectedStudents.length !== 1) return 'Choose one assigned student for this lesson.';
    if (!lessonDate) return 'Choose a lesson date.';
    const selectedLessonBlocker = selectedStudents
      .map((student) => ({ student, message: getStudentLessonBlocker(student) }))
      .find((entry) => entry.message);
    if (selectedLessonBlocker) return `${getStudentLabel(selectedLessonBlocker.student)}: ${selectedLessonBlocker.message}`;
    if (!topics.length) return 'Add at least one planned topic before creating the lesson.';
    return '';
  }, [availableStudents.length, contexts, contextsLoaded, eligibilityError, eligibilityLoaded, getStudentLessonBlocker, grade, isNew, lessonDate, profile?.uid, selectedStudents, sessionMode, subject, subjectOptions.length, topics.length]);

  useEffect(() => {
    if (!subject || !grade || !isNew && !lessonRows.length) {
      setTopicOptions(emptyTopicGroups);
      return;
    }
    let cancelled = false;
    getQuestionPapers({ subject, grade })
      .then((papers) => {
        if (cancelled) return;
        const studentIds = contexts
          .filter((context) => context.accessRole === 'co-owner' && context.subject === subject && context.grade === grade)
          .map((context) => context.studentId);
        return getGlobalTopicOptionGroups({
          subject,
          grade,
          studentIds,
          questionPapers: papers,
        });
      })
      .then((groups) => {
        if (cancelled) return;
        setTopicOptions(groups);
      })
      .catch((error) => {
        if (cancelled) return;
        setTopicOptions(emptyTopicGroups);
        setStatus(error.message || 'Could not load topics from the global subject-grade list.');
        setStatusTone('error');
      });
    return () => { cancelled = true; };
  }, [contexts, grade, isNew, lessonRows, subject]);

  const handleSubjectChange = (value) => {
    setSubject(value);
    setGrade('');
    setSelectedStudentIds([]);
    setTopics([]);
    setTopicOptions(emptyTopicGroups);
  };

  const handleModeChange = (value) => {
    setSessionMode(value);
    setSelectedStudentIds((current) => value === 'one-on-one' ? current.slice(0, 1) : current);
  };

  const toggleStudent = (studentId, checked) => {
    setSelectedStudentIds((current) => {
      if (sessionMode === 'one-on-one') return checked ? [studentId] : [];
      return checked ? [...new Set([...current, studentId])] : current.filter((id) => id !== studentId);
    });
  };

  const addTopic = () => {
    if (!selectedTopic || topics.includes(selectedTopic)) return;
    setTopics((current) => [...current, selectedTopic]);
    setParticipants((current) => Object.fromEntries(Object.entries(current).map(([id, row]) => [id, {
      ...row,
      scores: { ...row.scores, [selectedTopic]: row.scores?.[selectedTopic] ?? '' },
    }])));
    setSelectedTopic('');
  };

  const removeTopic = (topic) => {
    setTopics((current) => current.filter((item) => item !== topic));
    setParticipants((current) => Object.fromEntries(Object.entries(current).map(([id, row]) => {
      const scores = { ...row.scores };
      delete scores[topic];
      return [id, { ...row, scores }];
    })));
  };

  const updateParticipant = (lessonRowId, patch) => setParticipants((current) => ({
    ...current,
    [lessonRowId]: { ...emptyParticipant(), ...(current[lessonRowId] || {}), ...patch },
  }));

  const createPlannedSession = async () => {
    if (createBlocker) {
      setStatus(createBlocker);
      setStatusTone('error');
      return;
    }
    setIsSaving(true);
    setStatus('');
    setStatusTone('info');
    try {
      const createdRows = await runOperation({
        operationName: 'Scheduling lesson',
        successMessage: 'The lesson schedule was saved successfully.',
        failureMessage: 'Could not create the lesson.',
      }, async () => {
        const groupSessionId = sessionMode === 'group' ? plannedRequestId : '';
        const rows = await savePlannedLessonSession({
          tutorId: profile.uid,
          subject,
          students: selectedStudents,
          topics,
          lessonDate,
          lessonType,
          whatsappLessonLink,
          locationDetails,
          sessionMode,
          groupSessionId,
          operationId: plannedRequestId,
        });
        if (!rows.length) throw new Error('No lesson records were created.');
        return rows;
      });
      setPendingOperationNavigation(`${basePath}/lessons/${createdRows[0].id}`);
    } catch (error) {
      setStatus(getLessonErrorMessage(error, 'Could not create the lesson.'));
      setStatusTone('error');
    } finally {
      setIsSaving(false);
    }
  };

  const saveLessonRecords = async () => {
    setIsSaving(true);
    setStatus('');
    try {
      await runOperation({
        operationName: 'Saving lesson records',
        successMessage: 'Attendance, reports, and topic scores were saved.',
        failureMessage: 'Could not save the lesson records.',
      }, async () => {
      const savedRows = await completeLessonSession({
        tutorId: profile.uid,
        lessonRows,
        topics,
        lessonDate,
        lessonType,
        whatsappLessonLink,
        locationDetails,
        participants: lessonRows.map((row) => ({ lessonId: row.id, ...(participants[row.id] || emptyParticipant()) })),
      });
      setLessonRows(savedRows);
      const attendedRows = savedRows.filter((row) => row.attended);
      const generationResults = await Promise.allSettled(attendedRows.map((row) => {
          const student = contexts.find((context) => context.studentId === row.studentId && context.subject === subject);
          const understandingLevel = row.understandingLevel;
          return generateExercisePlanIfEligible({
            student: {
              ...student,
              uid: row.studentId,
              grade: student?.grade || row.grade,
              subjectInstanceId: row.subjectInstanceId || student?.subjectInstanceId,
              accessRole: student?.accessRole,
            },
            subject,
            mode: 'weekly',
            completedLesson: row,
            understandingLevel,
          });
        }));
      const generatedCount = generationResults.filter((result) => result.status === 'fulfilled' && result.value?.generated).length;
      const generationIssues = generationResults.flatMap((result, index) => {
        if (result.status === 'rejected') {
          return [`${attendedRows[index]?.studentName || 'A student'}: ${result.reason?.message || 'generation failed.'}`];
        }
        if (!result.value?.generated) {
          return [`${attendedRows[index]?.studentName || 'A student'}: ${result.value?.reason || 'generation did not start.'}`];
        }
        return [];
      });
      if (generationIssues.length) {
        const visibleIssues = generationIssues.slice(0, 3).join(' ');
        const remainingIssues = generationIssues.length > 3 ? ` ${generationIssues.length - 3} more student(s) need review.` : '';
        setStatus(`Lesson records saved. Exercise generation did not complete for ${generationIssues.length} student(s). ${visibleIssues}${remainingIssues}`);
        setStatusTone('error');
      } else if (attendedRows.length) {
        setStatus(`Lesson records saved. Exercises refreshed for ${generatedCount} student${generatedCount === 1 ? '' : 's'}.`);
        setStatusTone('success');
      } else {
        setStatus(`Lesson records saved for ${savedRows.length} student${savedRows.length === 1 ? '' : 's'}; no students attended.`);
        setStatusTone('info');
      }
      });
    } catch (error) {
      setStatus(error.message || 'Could not save the lesson records.');
    } finally {
      setIsSaving(false);
    }
  };

  const savePlannedDetails = async () => {
    setIsSaving(true);
    setStatus('');
    try {
      const updatedRows = await runOperation({
        operationName: 'Updating lesson details',
        successMessage: 'The scheduled lesson details were saved.',
        failureMessage: 'Could not update lesson details.',
      }, () => updatePlannedLessonDetails({
          tutorId: profile.uid,
          lessonRows,
          lessonType,
          whatsappLessonLink,
          locationDetails,
        }));
      setLessonRows(updatedRows);
      setStatus('Scheduled lesson details updated.');
    } catch (error) {
      setStatus(error.message || 'Could not update lesson details.');
    } finally {
      setIsSaving(false);
    }
  };

  const saveRosterChanges = async (removeLessonIds = []) => {
    setIsSaving(true);
    setStatus('');
    try {
      const addStudents = addableStudents.filter((student) => studentsToAdd.includes(student.studentId));
      const updatedRows = await runOperation({
        operationName: 'Updating lesson roster',
        successMessage: 'The lesson roster was updated successfully.',
        failureMessage: 'Could not update the group roster.',
      }, () => updatePlannedLessonRoster({
          tutorId: profile.uid,
          lessonRows,
          addStudents,
          removeLessonIds,
        }));
      setLessonRows(updatedRows);
      setSelectedStudentIds(updatedRows.map((row) => row.studentId));
      setParticipants((current) => Object.fromEntries(updatedRows.map((row) => [row.id, current[row.id] || emptyParticipant()])));
      setStudentsToAdd([]);
      setStatus('Group roster updated. You can continue adjusting it until the lesson is logged.');
    } catch (error) {
      setStatus(error.message || 'Could not update the group roster.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!lessonRows.length || !window.confirm('Cancel this planned lesson session? The cancelled records will remain in lesson history.')) return;
    setIsSaving(true);
    try {
      await runOperation({
        operationName: 'Cancelling lesson session',
        successMessage: 'The lesson session was cancelled and kept in history.',
        failureMessage: 'Could not cancel the lesson session.',
      }, () => deleteLessonSession({ tutorId: profile.uid, lessonRows }));
      setPendingOperationNavigation(`${basePath}/lessons`);
    } catch (error) {
      setStatus(error.message || 'Could not delete the lesson session.');
    } finally {
      setIsSaving(false);
    }
  };

  const attendingCount = lessonRows.filter((row) => participants[row.id]?.attended !== false).length;
  const title = isNew ? (sessionMode === 'group' ? 'Schedule group lesson' : 'Schedule one-on-one lesson') : 'Log lesson';

  return (
    <AppShell title={isNew ? 'Schedule lesson' : 'Lesson records'} subtitle="Plan lessons by student and log attendance, reports, and topic scores." role={role} user={profile} onLogout={logout}>
      <Link to={`${basePath}/lessons`} className="btn-secondary hidden w-fit lg:inline-flex">Back to lessons</Link>
      {status ? <div className={`panel p-4 text-sm ${statusTone === 'error' ? 'border border-rose-200 bg-rose-50 font-medium text-rose-800' : 'text-slate-700'}`} role={statusTone === 'error' ? 'alert' : 'status'}>{status}</div> : null}
      {(!contextsLoaded || (isNew && !eligibilityLoaded) || (!isNew && existingLessonLoading)) ? <LoadingState label={isNew ? 'Loading assigned students and lesson topics…' : 'Loading lesson roster and records…'} /> : null}

      {isNew ? (
        <section className="panel space-y-5 p-5">
          <SectionHeader eyebrow="Lesson setup" title={title} description="Choose the format, students, date, and planned topics." />
          <div className="grid gap-5">
            <fieldset className="space-y-2">
              <legend className="label">Lesson format</legend>
              <div className="grid grid-cols-2 gap-2">
                {[['one-on-one', 'One-on-one'], ['group', 'Group']].map(([value, label]) => (
                  <button key={value} type="button" className={sessionMode === value ? 'btn-primary' : 'btn-secondary'} onClick={() => handleModeChange(value)}>{label}</button>
                ))}
              </div>
            </fieldset>
          </div>

          <LessonLogisticsFields
            lessonType={lessonType}
            setLessonType={setLessonType}
            whatsappLessonLink={whatsappLessonLink}
            setWhatsAppLessonLink={setWhatsAppLessonLink}
            locationDetails={locationDetails}
            setLocationDetails={setLocationDetails}
            disabled={isSaving}
          />

          <div className="grid gap-3 md:grid-cols-3">
            <label className="grid gap-2 text-sm font-semibold text-slate-700">Subject
              <select className="input" value={subjectOptions.includes(subject) ? subject : ''} onChange={(event) => handleSubjectChange(event.target.value)} disabled={!eligibilityLoaded || !subjectOptions.length}>
                <option value="">{eligibilityLoaded ? 'No eligible subjects' : 'Checking analyzed papers…'}</option>
                {subjectOptions.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-semibold text-slate-700">Grade
              <select className="input" value={grade} onChange={(event) => { setGrade(event.target.value); setSelectedStudentIds([]); setTopics([]); }}>
                <option value="">Choose grade</option>
                {gradeOptions.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="grid gap-2 text-sm font-semibold text-slate-700">Lesson date
              <input type="date" className="input" value={lessonDate} onChange={(event) => setLessonDate(event.target.value)} />
            </label>
          </div>

          <div className="space-y-2">
            <p className="label">{sessionMode === 'group' ? 'Students in this group' : 'Student'}</p>
            {sessionMode === 'one-on-one' ? (
              <select className="input" value={selectedStudentIds[0] || ''} onChange={(event) => setSelectedStudentIds(event.target.value ? [event.target.value] : [])}>
                <option value="">Choose assigned student</option>
                {availableStudents.map((student) => {
                  const blocker = getStudentLessonBlocker(student);
                  return <option key={student.studentId} value={student.studentId} disabled={Boolean(blocker)}>{getStudentLabel(student)}{blocker ? ` — ${blocker}` : ''}</option>;
                })}
              </select>
            ) : (
              <div className="max-h-64 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200">
                {availableStudents.map((student) => (
                  <label key={student.studentId} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
                    <input type="checkbox" checked={selectedStudentIds.includes(student.studentId)} onChange={(event) => toggleStudent(student.studentId, event.target.checked)} disabled={Boolean(getStudentLessonBlocker(student))} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{getStudentLabel(student)}</span><span className="block truncate text-xs text-slate-500">{student.email || student.studentId}</span></span>
                    {getStudentLessonBlocker(student) ? <span className="max-w-48 text-right text-xs text-amber-700">{getStudentLessonBlocker(student)}</span> : null}
                  </label>
                ))}
                {contextsLoaded && !availableStudents.length ? <p className="p-3 text-sm text-slate-500">No current co-owner students match this subject and grade.</p> : null}
              </div>
            )}
            {sessionMode === 'group' ? <p className="text-xs text-slate-500">Selected: {selectedStudentIds.length}. Group students must share the selected subject and grade.</p> : null}
          </div>

          <TopicPicker topicOptions={topicOptions} selectedTopic={selectedTopic} setSelectedTopic={setSelectedTopic} addTopic={addTopic} topics={topics} removeTopic={removeTopic} />
          <button type="button" className="btn-primary w-full md:w-auto" onClick={createPlannedSession} disabled={isSaving || Boolean(createBlocker)}>
            {isSaving ? 'Saving…' : 'Create planned lesson'}
          </button>
          {createBlocker ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">{createBlocker}</p> : null}
        </section>
      ) : (
        <section className="panel space-y-5 p-5">
          <SectionHeader
            eyebrow={sessionMode === 'group' ? 'Group lesson' : 'One-on-one lesson'}
            title={`${subject} • ${grade || 'Grade not recorded'}`}
            description={`${lessonDate} • ${lessonType === 'inPerson' ? 'In-person' : 'Online (WhatsApp)'} • ${lessonRows.length} student${lessonRows.length === 1 ? '' : 's'}`}
          />
          {!canManageExisting ? <p className="text-sm font-medium text-amber-700">This lesson is read-only because your current role is not a co-owner for every student in the session.</p> : null}
          {lessonRows.length && lessonRows.every((row) => row.status === 'planned') && canManageExisting ? (
            <section className="space-y-4 border-y border-slate-200 py-4">
              <div><h3 className="text-sm font-semibold text-slate-900">Lesson logistics</h3><p className="mt-1 text-xs text-slate-500">Change the session type, WhatsApp link, or venue before logging attendance.</p></div>
              <LessonLogisticsFields
                lessonType={lessonType}
                setLessonType={setLessonType}
                whatsappLessonLink={whatsappLessonLink}
                setWhatsAppLessonLink={setWhatsAppLessonLink}
                locationDetails={locationDetails}
                setLocationDetails={setLocationDetails}
                disabled={isSaving}
              />
              <button type="button" className="btn-secondary" onClick={savePlannedDetails} disabled={isSaving}>{isSaving ? 'Saving…' : 'Save lesson logistics'}</button>
            </section>
          ) : null}
          {canManageExisting ? <LessonAccessDetails lessonType={lessonType} whatsappLessonLink={lessonRows[0]?.whatsappLessonLink} locationDetails={lessonRows[0]?.locationDetails} /> : null}
          {canEditPlannedRoster ? (
            <section className="space-y-3 border-y border-slate-200 py-4" aria-label="Edit group roster">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Upcoming group roster</h3>
                <p className="mt-1 text-xs text-slate-500">Add or remove students until this lesson is logged. At least two students must remain.</p>
              </div>
              <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
                {lessonRows.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <span className="min-w-0 truncate text-sm font-medium text-slate-800">{row.studentName || row.studentId}</span>
                    <button type="button" className="btn-secondary flex-none px-3 py-1.5 text-xs text-rose-700" onClick={() => saveRosterChanges([row.id])} disabled={isSaving || lessonRows.length <= 2} aria-label={`Remove ${row.studentName || 'student'} from this group lesson`}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              {addableStudents.length ? (
                <div className="space-y-3">
                  <div className="max-h-48 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200">
                    {addableStudents.map((student) => (
                      <label key={student.studentId} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
                        <input type="checkbox" checked={studentsToAdd.includes(student.studentId)} onChange={(event) => setStudentsToAdd((current) => event.target.checked ? [...new Set([...current, student.studentId])] : current.filter((id) => id !== student.studentId))} disabled={isSaving} />
                        <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{getStudentLabel(student)}</span><span className="block truncate text-xs text-slate-500">{student.email || student.studentId}</span></span>
                      </label>
                    ))}
                  </div>
                  <button type="button" className="btn-secondary" onClick={() => saveRosterChanges()} disabled={isSaving || !studentsToAdd.length}>
                    {isSaving ? 'Saving…' : `Add ${studentsToAdd.length || ''} student${studentsToAdd.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              ) : contextsLoaded ? <p className="text-sm text-slate-500">No other current co-owner students match this subject and grade.</p> : null}
            </section>
          ) : null}
          <TopicPicker topicOptions={topicOptions} selectedTopic={selectedTopic} setSelectedTopic={setSelectedTopic} addTopic={addTopic} topics={topics} removeTopic={removeTopic} disabled={!isEditable} />
          <div className="w-full overflow-hidden rounded-lg border border-slate-200">
            <div className="overflow-x-auto overscroll-x-contain">
              <table className="min-w-[1120px] border-collapse text-left text-sm">
                <thead className="bg-slate-900 text-xs uppercase text-slate-300">
                  <tr>
                    <th className="w-12 px-3 py-3">#</th>
                    <th className="min-w-56 px-3 py-3">Student</th>
                    <th className="min-w-28 px-3 py-3">Grade</th>
                    <th className="min-w-28 px-3 py-3">Subject</th>
                    <th className="min-w-52 px-3 py-3">WhatsApp</th>
                    <th className="min-w-28 px-3 py-3">Attended</th>
                    <th className="min-w-64 px-3 py-3">Lesson report</th>
                    {topics.map((topic) => <th key={topic} className="min-w-36 px-3 py-3">{topic}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {lessonRows.map((row, index) => {
                    const participant = participants[row.id] || emptyParticipant();
                    const student = contexts.find((context) => context.studentId === row.studentId && context.subject === subject);
                    const whatsappUrl = getWhatsAppChatUrl(student?.whatsappNumber);
                    return (
                      <tr key={row.id} className="align-top">
                        <td className="px-3 py-3 font-semibold text-slate-500">{index + 1}</td>
                        <td className="px-3 py-3"><p className="font-semibold text-slate-900">{row.studentName || row.studentId}</p><p className="mt-1 text-xs text-slate-500">{contexts.find((context) => context.studentId === row.studentId)?.email || ''}</p></td>
                        <td className="px-3 py-3 text-slate-600">{row.grade || grade || '—'}</td>
                        <td className="px-3 py-3 text-slate-600">{row.subject || subject}</td>
                        <td className="px-3 py-3">
                          {canManageExisting && student?.whatsappNumber ? <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-slate-600">{student.whatsappNumber}</span><CopyTextButton value={student.whatsappNumber} label={`${row.studentName || 'student'} WhatsApp number`} />{whatsappUrl ? <a className="btn-secondary inline-flex h-10 items-center gap-2" href={whatsappUrl} target="_blank" rel="noreferrer" title={`Open ${row.studentName || 'student'} in WhatsApp`}><MessageCircle className="h-4 w-4" aria-hidden="true" />Chat</a> : null}</div> : canManageExisting ? <span className="text-xs text-amber-700">Not provided</span> : <span className="text-xs text-slate-400">—</span>}
                        </td>
                        <td className="px-3 py-3">
                          <label className="inline-flex items-center gap-2 font-medium text-slate-700">
                            <input type="checkbox" checked={participant.attended !== false} onChange={(event) => updateParticipant(row.id, { attended: event.target.checked })} disabled={!isEditable || isSaving} />
                            {participant.attended === false ? 'Missed' : 'Present'}
                          </label>
                        </td>
                        <td className="px-3 py-3"><textarea className="input min-h-24 min-w-60" value={participant.topicReport || ''} onChange={(event) => updateParticipant(row.id, { topicReport: event.target.value })} placeholder={participant.attended === false ? 'Not required when missed' : 'Report for this student'} disabled={!isEditable || isSaving || participant.attended === false} /></td>
                        {topics.map((topic) => <td key={topic} className="px-3 py-3"><input aria-label={`${topic} understanding score out of 10 for ${row.studentName || row.studentId}`} type="number" min="0" max="10" step="1" className="input min-w-28" value={participant.scores?.[topic] ?? ''} onChange={(event) => updateParticipant(row.id, { scores: { ...(participant.scores || {}), [topic]: event.target.value } })} placeholder={participant.attended === false ? 'Missed' : '0–10'} disabled={!isEditable || isSaving || participant.attended === false} /></td>)}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-500">{attendingCount} attending • {lessonRows.length - attendingCount} missed</p>
            <div className="flex flex-wrap gap-3">
              {canCancelSession ? <button type="button" className="btn-secondary text-rose-700 hover:text-rose-800" onClick={handleDelete} disabled={isSaving}>Cancel session</button> : null}
              {isEditable ? <button type="button" className="btn-primary" onClick={saveLessonRecords} disabled={isSaving || !lessonRows.length || !topics.length}>{isSaving ? 'Saving…' : 'Save lesson records'}</button> : null}
            </div>
          </div>
        </section>
      )}
      <OperationStatusOverlay
        state={operationStatus?.state}
        operationName={operationStatus?.operationName}
        message={operationStatus?.message}
        onDone={() => {
          closeOperationStatus();
          if (pendingOperationNavigation) {
            const destination = pendingOperationNavigation;
            setPendingOperationNavigation('');
            navigate(destination);
          }
        }}
      />
    </AppShell>
  );
};

const TopicPicker = ({ topicOptions, selectedTopic, setSelectedTopic, addTopic, topics, removeTopic, disabled = false }) => (
  <div className="space-y-3">
    <div className="grid gap-3 md:grid-cols-[1fr_auto]">
      <label className="grid gap-2 text-sm font-semibold text-slate-700">Planned and covered topics
        <select className="input" value={selectedTopic} onChange={(event) => setSelectedTopic(event.target.value)} disabled={disabled || !topicOptions.all.length}>
          <option value="">{topicOptions.all.length ? 'Choose a canonical topic' : 'No topics available for this grade and subject'}</option>
          {topicOptions.extracted.length ? <optgroup label="Matched past-paper topics">{topicOptions.extracted.map((topic) => <option key={`paper-${topic}`} value={topic}>{topic}</option>)}</optgroup> : null}
          {topicOptions.manual.length ? <optgroup label="Global subject topics">{topicOptions.manual.map((topic) => <option key={`manual-${topic}`} value={topic}>{topic}</option>)}</optgroup> : null}
        </select>
      </label>
      <button type="button" className="btn-secondary self-end" onClick={addTopic} disabled={disabled || !selectedTopic}>Add topic</button>
    </div>
    {topics.length ? <ul className="flex flex-wrap gap-2">{topics.map((topic) => <li key={topic} className="inline-flex items-center gap-2 rounded-md border border-lime-500/40 bg-transparent px-3 py-2 text-sm font-medium text-slate-900"><span>{topic}</span>{!disabled ? <button type="button" className="text-rose-800 hover:text-rose-950" aria-label={`Remove ${topic}`} onClick={() => removeTopic(topic)}>×</button> : null}</li>)}</ul> : null}
  </div>
);

const LessonLogisticsFields = ({ lessonType, setLessonType, whatsappLessonLink, setWhatsAppLessonLink, locationDetails, setLocationDetails, disabled = false }) => (
  <div className="grid gap-4 md:grid-cols-2">
    <div className="space-y-2">
      <p className="label">Session type</p>
      <div className="grid grid-cols-2 gap-2">
        {[['online', 'Online (WhatsApp)'], ['inPerson', 'In-person']].map(([value, label]) => (
          <button key={value} type="button" className={lessonType === value ? 'btn-primary' : 'btn-secondary'} onClick={() => setLessonType(value)} disabled={disabled} aria-pressed={lessonType === value}>
            {label}
          </button>
        ))}
      </div>
    </div>
    {lessonType === 'online' ? (
      <label className="grid gap-2 text-sm font-semibold text-slate-700">WhatsApp lesson or group-invite link <span className="font-normal text-slate-500">Optional</span>
        <input type="url" className="input" value={whatsappLessonLink} onChange={(event) => setWhatsAppLessonLink(event.target.value)} placeholder="https://call.whatsapp.com/... or https://chat.whatsapp.com/..." disabled={disabled} />
        <span className="text-xs font-normal text-slate-500">Online lessons use WhatsApp only. You can add this now or later.</span>
      </label>
    ) : (
      <label className="grid gap-2 text-sm font-semibold text-slate-700">Address or school name <span className="font-normal text-slate-500">Optional</span>
        <textarea className="input min-h-20" value={locationDetails} onChange={(event) => setLocationDetails(event.target.value)} placeholder="School name, street address, or meeting point" disabled={disabled} />
      </label>
    )}
  </div>
);
