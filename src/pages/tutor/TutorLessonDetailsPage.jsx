import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { SectionHeader } from '../../components/common/SectionHeader';
import { useAuth } from '../../hooks/useAuth';
import { DEFAULT_SUBJECT, SOUTH_AFRICAN_GRADES } from '../../lib/constants';
import { LessonAccessDetails } from '../../components/lessons/LessonAccessDetails';
import { CopyTextButton } from '../../components/common/CopyTextButton';
import { getTopicOptionGroups } from '../../data/topicCatalog';
import { getWhatsAppChatUrl } from '../../utils/whatsapp';
import {
  completeLessonSession,
  deleteLessonSession,
  generateExercisePlanIfEligible,
  getLessonsByGroupSessionId,
  getLessonById,
  getQuestionPapers,
  getTutorAssignedStudentContexts,
  savePlannedLessonSession,
  updatePlannedLessonDetails,
  updatePlannedLessonRoster,
} from '../../services/firestoreService';
import { useEffectiveRole } from '../../utils/effectiveRole';
import { MessageCircle } from 'lucide-react';

const today = () => {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
};
const emptyTopicGroups = { extracted: [], manual: [], all: [] };
const emptyParticipant = () => ({ attended: true, topicReport: '', scores: {} });
const createSessionId = () => globalThis.crypto?.randomUUID?.() ?? `lesson-group-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const getStudentLabel = (student) => student.displayName || student.name || student.email || student.studentId;

export const TutorLessonDetailsPage = () => {
  const { lessonId } = useParams();
  const isNew = lessonId === 'new';
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const { role, basePath } = useEffectiveRole();
  const [contexts, setContexts] = useState([]);
  const [contextsLoaded, setContextsLoaded] = useState(false);
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
      .catch((error) => setStatus(error.message || 'Could not load assigned students.'))
      .finally(() => setContextsLoaded(true));
  }, [profile?.uid]);

  useEffect(() => {
    if (isNew || !lessonId || !contextsLoaded || !profile?.uid) return;
    let cancelled = false;
    const load = async () => {
      const lesson = await getLessonById(lessonId);
      if (!lesson) throw new Error('Lesson not found.');
      const rows = lesson.groupSessionId
        ? await getLessonsByGroupSessionId(lesson.groupSessionId)
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
        const scores = Object.fromEntries((row.topicUnderstandingScores || []).map((entry) => [entry.topic, entry.understandingLevel]));
        return [row.id, {
          attended: row.attendanceStatus === 'missed' || row.attended === false ? false : true,
          topicReport: row.topicReport || row.note || '',
          scores,
        }];
      })));
    };
    load().catch((error) => { if (!cancelled) setStatus(error.message || 'Could not load the lesson.'); });
    return () => { cancelled = true; };
  }, [contexts, contextsLoaded, isNew, lessonId, profile?.uid]);

  const subjectOptions = useMemo(() => [...new Set(contexts
    .filter((context) => context.accessRole === 'co-owner')
    .map((context) => context.subject || DEFAULT_SUBJECT))].sort(), [contexts]);
  const gradeOptions = useMemo(() => [...new Set(contexts
    .filter((context) => context.accessRole === 'co-owner' && (context.subject || DEFAULT_SUBJECT) === subject)
    .map((context) => context.grade || '')
    .filter(Boolean))].sort((left, right) => SOUTH_AFRICAN_GRADES.indexOf(left) - SOUTH_AFRICAN_GRADES.indexOf(right)), [contexts, subject]);
  const availableStudents = useMemo(() => contexts
    .filter((context) => context.accessRole === 'co-owner'
      && (context.subject || DEFAULT_SUBJECT) === subject
      && (context.grade || '') === grade)
    .filter((context, index, list) => list.findIndex((row) => row.studentId === context.studentId) === index), [contexts, grade, subject]);
  const canManageExisting = isNew || (lessonRows.length > 0 && lessonRows.every((row) => contexts.some((context) =>
    context.studentId === row.studentId
    && context.subject === (row.subject || DEFAULT_SUBJECT)
    && context.accessRole === 'co-owner')));
  const isEditable = canManageExisting && (isNew || lessonRows.length > 0);
  const canEditPlannedRoster = canManageExisting
    && sessionMode === 'group'
    && lessonRows.length > 0
    && lessonDate >= today()
    && lessonRows.every((row) => row.status === 'planned');
  const rosterStudentIds = new Set(lessonRows.map((row) => row.studentId));
  const addableStudents = availableStudents.filter((student) => !rosterStudentIds.has(student.studentId));

  useEffect(() => {
    if (!subject || !grade || !isNew && !lessonRows.length) {
      setTopicOptions(emptyTopicGroups);
      return;
    }
    let cancelled = false;
    getQuestionPapers({ subject, grade })
      .then((papers) => {
        if (cancelled) return;
        setTopicOptions(getTopicOptionGroups({
          extractedTopics: papers.flatMap((paper) => paper.topics ?? []).filter(Boolean),
          subject,
          grade,
        }));
      })
      .catch(() => setTopicOptions(getTopicOptionGroups({ subject, grade })));
    return () => { cancelled = true; };
  }, [grade, isNew, lessonRows.length, subject]);

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
    setIsSaving(true);
    setStatus('');
    try {
      const selectedStudents = selectedStudentIds.map((studentId) => availableStudents.find((student) => student.studentId === studentId)).filter(Boolean);
      const groupSessionId = sessionMode === 'group' ? createSessionId() : '';
      const createdRows = await savePlannedLessonSession({
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
      });
      if (!createdRows.length) throw new Error('No lesson records were created.');
      navigate(`${basePath}/lessons/${createdRows[0].id}`);
    } catch (error) {
      setStatus(error.message || 'Could not create the lesson.');
    } finally {
      setIsSaving(false);
    }
  };

  const saveLessonRecords = async () => {
    setIsSaving(true);
    setStatus('');
    try {
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
      const generationResults = await Promise.allSettled(savedRows
        .filter((row) => row.attended)
        .map((row) => {
          const student = contexts.find((context) => context.studentId === row.studentId && context.subject === subject);
          const understandingLevel = row.understandingLevel;
          return generateExercisePlanIfEligible({
            student: { uid: row.studentId, grade: student?.grade || row.grade, province: student?.province, paymentCompleted: student?.paymentCompleted },
            subject,
            mode: 'weekly',
            completedLesson: row,
            understandingLevel,
          });
        }));
      const generationFailures = generationResults.filter((result) => result.status === 'rejected').length;
      setStatus(generationFailures
        ? 'Lesson records saved. Exercise planning could not be refreshed for some students.'
        : `Lesson records saved for ${savedRows.length} student${savedRows.length === 1 ? '' : 's'}.`);
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
      const updatedRows = await updatePlannedLessonDetails({
        tutorId: profile.uid,
        lessonRows,
        lessonType,
        whatsappLessonLink,
        locationDetails,
      });
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
      const updatedRows = await updatePlannedLessonRoster({
        tutorId: profile.uid,
        lessonRows,
        addStudents,
        removeLessonIds,
      });
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
    if (!lessonRows.length || !window.confirm('Delete this lesson session and its student records? This cannot be undone.')) return;
    setIsSaving(true);
    try {
      await deleteLessonSession({ tutorId: profile.uid, lessonRows });
      navigate(`${basePath}/lessons`);
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
      <Link to={`${basePath}/lessons`} className="btn-secondary inline-flex w-fit">Back to lessons</Link>
      {status ? <div className="panel p-4 text-sm text-slate-700" role="status">{status}</div> : null}

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
              <select className="input" value={subject} onChange={(event) => handleSubjectChange(event.target.value)}>
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
                {availableStudents.map((student) => <option key={student.studentId} value={student.studentId}>{getStudentLabel(student)}</option>)}
              </select>
            ) : (
              <div className="max-h-64 divide-y divide-slate-200 overflow-y-auto rounded-lg border border-slate-200">
                {availableStudents.map((student) => (
                  <label key={student.studentId} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm text-slate-700 hover:bg-slate-50">
                    <input type="checkbox" checked={selectedStudentIds.includes(student.studentId)} onChange={(event) => toggleStudent(student.studentId, event.target.checked)} />
                    <span className="min-w-0 flex-1"><span className="block truncate font-semibold">{getStudentLabel(student)}</span><span className="block truncate text-xs text-slate-500">{student.email || student.studentId}</span></span>
                  </label>
                ))}
                {!availableStudents.length ? <p className="p-3 text-sm text-slate-500">No current co-owner students match this subject and grade.</p> : null}
              </div>
            )}
            {sessionMode === 'group' ? <p className="text-xs text-slate-500">Selected: {selectedStudentIds.length}. Group students must share the selected subject and grade.</p> : null}
          </div>

          <TopicPicker topicOptions={topicOptions} selectedTopic={selectedTopic} setSelectedTopic={setSelectedTopic} addTopic={addTopic} topics={topics} removeTopic={removeTopic} />
          <button type="button" className="btn-primary w-full md:w-auto" onClick={createPlannedSession} disabled={isSaving || !contextsLoaded || !lessonDate || !grade || !topics.length || (sessionMode === 'group' ? selectedStudentIds.length < 2 : selectedStudentIds.length !== 1)}>
            {isSaving ? 'Saving…' : 'Create planned lesson'}
          </button>
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
              ) : <p className="text-sm text-slate-500">No other current co-owner students match this subject and grade.</p>}
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
                        {topics.map((topic) => <td key={topic} className="px-3 py-3"><input aria-label={`${topic} score for ${row.studentName || row.studentId}`} type="number" min="0" max="10" step="1" className="input min-w-28" value={participant.scores?.[topic] ?? ''} onChange={(event) => updateParticipant(row.id, { scores: { ...(participant.scores || {}), [topic]: event.target.value } })} placeholder={participant.attended === false ? 'Missed' : '0–10'} disabled={!isEditable || isSaving || participant.attended === false} /></td>)}
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
              {canManageExisting ? <button type="button" className="btn-secondary text-rose-700 hover:text-rose-800" onClick={handleDelete} disabled={isSaving}>Delete session</button> : null}
              {canManageExisting ? <button type="button" className="btn-primary" onClick={saveLessonRecords} disabled={isSaving || !lessonRows.length || !topics.length}>{isSaving ? 'Saving…' : 'Save lesson records'}</button> : null}
            </div>
          </div>
        </section>
      )}
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
          {topicOptions.manual.length ? <optgroup label="Hardcoded topic list">{topicOptions.manual.map((topic) => <option key={`manual-${topic}`} value={topic}>{topic}</option>)}</optgroup> : null}
        </select>
      </label>
      <button type="button" className="btn-secondary self-end" onClick={addTopic} disabled={disabled || !selectedTopic}>Add topic</button>
    </div>
    {topics.length ? <ul className="flex flex-wrap gap-2">{topics.map((topic) => <li key={topic} className="inline-flex items-center gap-2 rounded-md border border-lime-700/20 bg-lime-50 px-3 py-2 text-sm font-medium text-slate-800"><span>{topic}</span>{!disabled ? <button type="button" className="text-rose-700 hover:text-rose-900" aria-label={`Remove ${topic}`} onClick={() => removeTopic(topic)}>×</button> : null}</li>)}</ul> : null}
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
