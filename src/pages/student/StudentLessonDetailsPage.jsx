import { useEffect, useState } from 'react';
import { ExternalLink, MessageCircle } from 'lucide-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AppShell } from '../../components/common/AppShell';
import { LessonAccessDetails } from '../../components/lessons/LessonAccessDetails';
import { useAuth } from '../../hooks/useAuth';
import { getLessonById } from '../../services/firestoreService';
import { getAuthorizedLessonWhatsAppAccess } from '../../services/whatsappService';

const lessonScorePercent = (value) => {
  const score = Number(value);
  const ratio = score > 1 && score <= 10 ? score / 10 : score;
  return Number.isFinite(ratio) ? Math.round(ratio * 100) : 0;
};

export const StudentLessonDetailsPage = () => {
  const { lessonId } = useParams();
  const [searchParams] = useSearchParams();
  const { profile, logout } = useAuth();
  const [lesson, setLesson] = useState(null);
  const [whatsappAccess, setWhatsAppAccess] = useState(null);

  useEffect(() => {
    let active = true;
    const subjectInstanceId = searchParams.get('subjectInstanceId') || '';
    setLesson(null);
    setWhatsAppAccess(null);
    getLessonById(lessonId, { studentId: profile?.uid, subjectInstanceId: subjectInstanceId || undefined })
      .then(async (loadedLesson) => {
        if (!active) return;
        setLesson(loadedLesson);
        if (loadedLesson?.status === 'planned' && loadedLesson.lessonType !== 'inPerson' && profile?.uid && subjectInstanceId) {
          try {
            const access = await getAuthorizedLessonWhatsAppAccess({ studentId: profile.uid, subjectInstanceId, lessonId });
            if (active) setWhatsAppAccess(access || null);
          } catch (error) {
            console.warn('[Examifying][StudentLesson] WhatsApp access unavailable:', error?.code || error?.message);
          }
        }
      })
      .catch((error) => console.error('[Examifying][StudentLesson] load:error', error));
    return () => { active = false; };
  }, [lessonId, profile?.uid, searchParams]);

  return (
    <AppShell title="Lesson details" subtitle={lesson ? `${lesson.subject} • ${lesson.lessonDate || lesson.completedOn || 'No date'}` : 'Loading lesson'} role="student" user={profile} onLogout={logout}>
      <Link to="/student/lessons" className="btn-secondary inline-flex w-fit">Back to lessons</Link>
      {lesson ? (() => {
        const missed = lesson.status === 'missed' || lesson.attendanceStatus === 'missed' || lesson.attended === false;
        const planned = lesson.status === 'planned';
        const topics = (lesson.topics ?? [lesson.topic]).filter(Boolean);
        return (
          <section className="panel space-y-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold text-slate-950">{topics.join(' | ') || 'Lesson topics not recorded'}</h2>
                <p className="mt-1 text-sm text-slate-500">{lesson.sessionMode === 'group' ? `Group lesson • ${lesson.groupStudentCount || 2} students • ` : 'One-on-one lesson • '}{lesson.lessonDate || lesson.completedOn || 'No date'} • {lesson.lessonType === 'inPerson' ? 'In-person' : 'Online (WhatsApp)'}</p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${missed ? 'bg-amber-100 text-amber-800' : planned ? 'bg-sky-100 text-sky-800' : 'bg-lime-100 text-lime-800'}`}>{missed ? 'Missed' : planned ? 'Upcoming' : 'Completed'}</span>
            </div>
            <LessonAccessDetails lessonType={lesson.lessonType} whatsappLessonLink={lesson.whatsappLessonLink} locationDetails={lesson.locationDetails} />
            {whatsappAccess?.url ? (
              <a href={whatsappAccess.url} target="_blank" rel="noreferrer" className="btn-primary inline-flex w-fit items-center gap-2">
                <MessageCircle className="h-4 w-4" aria-hidden="true" />
                {whatsappAccess.accessType === 'group' ? 'Join WhatsApp Group' : 'Open WhatsApp'}
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </a>
            ) : null}
            {missed ? <p className="text-sm text-slate-600">You were marked absent. No report or understanding scores were recorded.</p> : planned ? <p className="text-sm text-slate-600">This lesson is scheduled. Your tutor will add the report and topic scores after the lesson.</p> : (
              <>
                <div className="space-y-2 text-sm text-slate-600">{(lesson.topicUnderstandingScores ?? []).map((entry) => <p key={entry.topic}>{entry.topic}: {lessonScorePercent(entry.understandingLevel)}%</p>)}</div>
                {(lesson.topicReport || lesson.note) ? <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-700">{lesson.topicReport || lesson.note}</p> : null}
              </>
            )}
          </section>
        );
      })() : null}
    </AppShell>
  );
};
