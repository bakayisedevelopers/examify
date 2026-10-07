import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { admin, getDb } from './admin.js';
import { getTutorSubjectsAutoGrantedByMarks, normalizeSupportedSubject } from './subjects.js';

const getUid = (request) => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Sign in to manage or access WhatsApp details.');
  return request.auth.uid;
};

const isTutorProfile = (profile = {}) => ['tutor', 'teacher'].includes(profile.role)
  || profile.isTeacher === true || profile.isTeacher === 'true';

const approvedSubjects = (profile = {}) => [...new Set([
  ...(Array.isArray(profile.subjects) ? profile.subjects : []),
  ...(profile.subject ? [profile.subject] : []),
  ...(Array.isArray(profile.tutorSubjectMarks)
    ? profile.tutorSubjectMarks.filter((item) => Number(item.mark) >= 60).map((item) => item.subject)
    : []),
  ...getTutorSubjectsAutoGrantedByMarks(profile.tutorSubjectMarks),
].map(normalizeSupportedSubject).filter(Boolean))];

const requireTutor = async (db, uid) => {
  const snapshot = await db.collection('users').doc(uid).get();
  const profile = snapshot.exists ? snapshot.data() : null;
  if (!profile || !isTutorProfile(profile)) throw new HttpsError('permission-denied', 'Only a tutor or teacher can manage these WhatsApp settings.');
  return { profile, profileRef: snapshot.ref };
};

const normalizeE164 = (value) => {
  const input = String(value ?? '').trim();
  let digits = input.replace(/\D/g, '');
  if (input.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith('0')) digits = `27${digits.slice(1)}`;
  if (!/^[1-9]\d{7,14}$/.test(digits)) return '';
  return `+${digits}`;
};

const requireE164 = (value) => {
  const input = String(value ?? '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(input)) throw new HttpsError('invalid-argument', 'Enter a valid WhatsApp number with its country code.');
  return input;
};

const normalizeGroupInvite = (value) => {
  const input = String(value ?? '').trim();
  if (!input) return '';
  let url;
  try {
    url = new URL(/^https:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new HttpsError('invalid-argument', 'Enter a valid WhatsApp group invite link.');
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'chat.whatsapp.com'
    || url.username || url.password || url.search || url.hash
    || !/^\/[A-Za-z0-9_-]{5,}\/?$/.test(url.pathname)) {
    throw new HttpsError('invalid-argument', 'Use a WhatsApp group invite link from chat.whatsapp.com.');
  }
  return `https://chat.whatsapp.com/${url.pathname.split('/').filter(Boolean)[0]}`;
};

const subjectDocumentId = (subject) => subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const userRef = (db, uid) => db.collection('users').doc(uid);
const privateContactRef = (db, uid) => userRef(db, uid).collection('private').doc('contact');
const subjectSettingsRef = (db, uid, subject) => userRef(db, uid).collection('tutorSubjectSettings').doc(subjectDocumentId(subject));

export const getTutorWhatsAppSettings = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = getUid(request);
  const db = getDb();
  const { profile, profileRef } = await requireTutor(db, uid);
  const approved = approvedSubjects(profile);
  const contactRef = privateContactRef(db, uid);
  let contact = await contactRef.get();

  // Move any older public-profile value into the private record the first time the owner opens settings.
  if (!contact.exists && profile.whatsappNumber) {
    const migratedNumber = normalizeE164(profile.whatsappNumber);
    if (migratedNumber) {
      await contactRef.set({ whatsappNumber: migratedNumber, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      contact = await contactRef.get();
    }
  }
  if (profile.whatsappNumber) {
    await profileRef.update({ whatsappNumber: admin.firestore.FieldValue.delete() });
  }

  const savedSettings = await userRef(db, uid).collection('tutorSubjectSettings').get();
  const groupLinks = {};
  savedSettings.docs.forEach((document) => {
    const setting = document.data();
    const subject = normalizeSupportedSubject(setting.subject);
    if (!subject || !approved.includes(subject) || !setting.groupLink) return;
    try {
      groupLinks[subject] = normalizeGroupInvite(setting.groupLink);
    } catch {
      // Ignore stale or manually corrupted invite links so profile settings still load.
    }
  });

  return { whatsappNumber: contact.exists ? contact.data()?.whatsappNumber || '' : '', groupLinks };
});

export const saveTutorWhatsAppNumber = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = getUid(request);
  const db = getDb();
  const { profileRef } = await requireTutor(db, uid);
  const whatsappNumber = requireE164(request.data?.whatsappNumber);
  await privateContactRef(db, uid).set({ whatsappNumber, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  if (request.data?.clearPublicValue !== false) {
    await profileRef.update({ whatsappNumber: admin.firestore.FieldValue.delete() });
  }
  return { whatsappNumber };
});

export const saveTutorWhatsAppGroupLink = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = getUid(request);
  const db = getDb();
  const { profile } = await requireTutor(db, uid);
  const subject = normalizeSupportedSubject(request.data?.subject);
  if (!subject || !approvedSubjects(profile).includes(subject)) {
    throw new HttpsError('failed-precondition', 'WhatsApp groups can only be set for an approved tutor subject.');
  }
  const groupLink = normalizeGroupInvite(request.data?.groupLink);
  const settingRef = subjectSettingsRef(db, uid, subject);
  if (!groupLink) {
    await settingRef.delete();
    return { subject, groupLink: '' };
  }
  await settingRef.set({ subject, groupLink, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  return { subject, groupLink };
});

export const getAuthorizedLessonWhatsAppAccess = onCall({ cpu: 'gcf_gen1' }, async (request) => {
  const uid = getUid(request);
  const { studentId, subjectInstanceId, lessonId } = request.data ?? {};
  if (!studentId || !subjectInstanceId || !lessonId || uid !== studentId) {
    throw new HttpsError('permission-denied', 'WhatsApp access is only available from your own assigned lesson.');
  }

  const db = getDb();
  const [studentSnapshot, episodeSnapshot] = await Promise.all([
    userRef(db, studentId).get(),
    userRef(db, studentId).collection('subjects').doc(subjectInstanceId).get(),
  ]);
  const student = studentSnapshot.exists ? studentSnapshot.data() : null;
  const episode = episodeSnapshot.exists ? episodeSnapshot.data() : null;
  if (student?.role !== 'student' || !episode || episode.status !== 'active' || episode.studentId !== studentId) {
    throw new HttpsError('permission-denied', 'This subject assignment is not active.');
  }

  const lessonSnapshot = await episodeSnapshot.ref.collection('lessons').doc(String(lessonId)).get();
  if (!lessonSnapshot.exists) throw new HttpsError('not-found', 'The assigned lesson could not be found.');
  const lesson = lessonSnapshot.data();
  const tutorId = String(lesson.tutorId ?? '');
  const tutorIsAssigned = tutorId && (episode.primaryTutorId === tutorId
    || (episode.activeStaffIds?.includes(tutorId) && episode.staffByUid?.[tutorId] === 'co-owner'));
  const subject = normalizeSupportedSubject(lesson.subject);
  if (!tutorIsAssigned || (lesson.studentId && lesson.studentId !== studentId)
    || (lesson.subjectInstanceId && lesson.subjectInstanceId !== subjectInstanceId)
    || !subject || subject !== normalizeSupportedSubject(episode.subjectKey)
    || lesson.status !== 'planned' || lesson.lessonType === 'inPerson') {
    throw new HttpsError('permission-denied', 'WhatsApp access is not available for this lesson.');
  }

  const sessionMode = lesson.sessionMode || 'one-on-one';
  const tutorSnapshot = await userRef(db, tutorId).get();
  const tutor = tutorSnapshot.exists ? tutorSnapshot.data() : null;
  if (!tutor || !isTutorProfile(tutor) || !approvedSubjects(tutor).includes(subject)) {
    throw new HttpsError('permission-denied', 'The lesson tutor is not currently approved for this subject.');
  }

  if (sessionMode === 'group') {
    if (!lesson.groupSessionId) throw new HttpsError('permission-denied', 'This group lesson has no active session.');
    const setting = await subjectSettingsRef(db, tutorId, subject).get();
    const groupLink = setting.exists && normalizeSupportedSubject(setting.data()?.subject) === subject
      ? normalizeGroupInvite(setting.data()?.groupLink)
      : '';
    return groupLink ? { accessType: 'group', url: groupLink } : null;
  }
  if (sessionMode !== 'one-on-one') throw new HttpsError('permission-denied', 'This lesson format is not eligible for WhatsApp access.');

  const contact = await privateContactRef(db, tutorId).get();
  const number = normalizeE164(contact.data()?.whatsappNumber);
  return number ? { accessType: 'one-on-one', url: `https://wa.me/${number.slice(1)}` } : null;
});
