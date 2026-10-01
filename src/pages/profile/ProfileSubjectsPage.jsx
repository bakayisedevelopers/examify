import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { useAuth } from '../../hooks/useAuth';
import { ROLES, SUBJECTS } from '../../lib/constants';
import { addStudentSubjects, getTutorMarksDocuments, removeUserSubject, updateUserSubjectAvailability } from '../../services/firestoreService';
import { deleteTutorMarksDocument, retryTutorMarksDocument, uploadTutorMarksDocument } from '../../services/storageService';
import { getApprovedTutorSubjects, getUserSubjects } from '../../utils/tutorSubjects';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';

const statusStyles = {
  processing: 'bg-amber-50 text-amber-700',
  done: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-rose-50 text-rose-700',
};

const formatDate = (value) => {
  if (!value) return 'Just now';
  if (value?.toDate) return value.toDate().toLocaleString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Just now' : date.toLocaleString();
};

export const ProfileSubjectsPage = ({ role }) => {
  const { profile, logout, refreshProfile } = useAuth();
  const isTutorRole = role === ROLES.TUTOR || role === 'teacher';
  const subscriptionState = useStudentSubscriptionState(role === ROLES.STUDENT ? profile : null);
  const [selectedSubjects, setSelectedSubjects] = useState([]);
  const [subjectToAdd, setSubjectToAdd] = useState('');
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [activeDocumentId, setActiveDocumentId] = useState('');
  const tutorUploadFormRef = useRef(null);
  const currentSubjects = useMemo(() => {
    if (isTutorRole) return getApprovedTutorSubjects(profile);
    return getUserSubjects(profile);
  }, [profile, isTutorRole]);
  const availableSubjects = SUBJECTS.filter((subject) => !currentSubjects.includes(subject));
  const subjectLimit = Number(subscriptionState?.subscriptionSubjectCount) || 0;
  const remainingSubjectSlots = Math.max(0, subjectLimit - currentSubjects.length - selectedSubjects.length);
  const tutorMarkBySubject = useMemo(() => new Map(
    (profile?.tutorSubjectMarks ?? []).map((item) => [item.subject, item.mark]),
  ), [profile?.tutorSubjectMarks]);
  const subjectAvailability = profile?.subjectAvailability ?? {};

  const loadTutorDocuments = useCallback(async () => {
    if (!isTutorRole || !profile?.uid) return;
    const uploadedDocuments = await getTutorMarksDocuments(profile.uid);
    setDocuments(uploadedDocuments);
  }, [isTutorRole, profile?.uid]);

  useEffect(() => {
    loadTutorDocuments().catch((error) => {
      console.error('[Examifying][TutorMarksDocuments] load:error', error);
      setStatus(error.message || 'Could not load uploaded tutor documents.');
    });
  }, [loadTutorDocuments]);

  const handleAddSubjectToSelection = () => {
    if (!subjectToAdd || selectedSubjects.includes(subjectToAdd)) return;
    if (currentSubjects.length + selectedSubjects.length >= subjectLimit) {
      setStatus(`Your subscription includes up to ${subjectLimit} subjects. Remove a current subject before adding another.`);
      return;
    }
    setSelectedSubjects((current) => [...current, subjectToAdd]);
    setSubjectToAdd('');
  };

  const handleRemoveSelectedSubject = (subject) => {
    setSelectedSubjects((current) => current.filter((item) => item !== subject));
  };

  const handleAddStudentSubjects = async (event) => {
    event.preventDefault();
    if (!selectedSubjects.length) {
      setStatus('Choose at least one subject to add.');
      return;
    }
    if (!subscriptionState?.paymentCompleted || currentSubjects.length + selectedSubjects.length > subjectLimit) {
      setStatus(`Your active subscription allows up to ${subjectLimit} subjects. Remove a current subject or update your subscription first.`);
      return;
    }

    try {
      setSaving(true);
      setStatus('Adding subjects...');
      await addStudentSubjects({ studentId: profile.uid, subjects: selectedSubjects });
      await refreshProfile(profile.uid);
      setStatus(`${selectedSubjects.join(', ')} added to your subjects.`);
      setSelectedSubjects([]);
      setSubjectToAdd('');
    } catch (error) {
      setStatus(error.message || 'Could not add subjects.');
    } finally {
      setSaving(false);
    }
  };

  const handleTutorUpload = async (event) => {
    event.preventDefault();
    if (!file) {
      setStatus('Please choose a marks document first.');
      return;
    }

    const temporaryDocument = {
      id: `local-${Date.now()}`,
      fileName: file.name,
      status: 'processing',
      createdAt: new Date().toISOString(),
      addedSubjects: [],
      extractedMarks: [],
    };

    try {
      setSaving(true);
      setStatus('Uploading and checking marks...');
      setDocuments((current) => [temporaryDocument, ...current]);
      const uploadResult = await uploadTutorMarksDocument({ file, tutor: profile, onProgress: setStatus });
      setResult(uploadResult);
      await refreshProfile(profile.uid);
      await loadTutorDocuments();
      setStatus(uploadResult.addedSubjects.length ? `Added: ${uploadResult.addedSubjects.join(', ')}.` : 'No new eligible subjects were found at 60% or above.');
      tutorUploadFormRef.current?.reset();
      setFile(null);
    } catch (error) {
      setDocuments((current) => current.map((item) => item.id === temporaryDocument.id ? { ...item, status: 'failed', errorMessage: error.message } : item));
      setStatus(error.message || 'Could not process marks document.');
      await loadTutorDocuments();
    } finally {
      setSaving(false);
    }
  };

  const handleRetry = async (documentRecord) => {
    try {
      setActiveDocumentId(documentRecord.id);
      setStatus(`Retrying ${documentRecord.fileName}...`);
      setDocuments((current) => current.map((item) => item.id === documentRecord.id ? { ...item, status: 'processing', errorMessage: '' } : item));
      const retryResult = await retryTutorMarksDocument({ documentRecord, tutor: profile, onProgress: setStatus });
      setResult(retryResult);
      await refreshProfile(profile.uid);
      await loadTutorDocuments();
      setStatus(retryResult.addedSubjects.length ? `Added: ${retryResult.addedSubjects.join(', ')}.` : 'Retry complete. No new eligible subjects were found.');
    } catch (error) {
      setStatus(error.message || 'Retry failed.');
      await loadTutorDocuments();
    } finally {
      setActiveDocumentId('');
    }
  };

  const handleDelete = async (documentRecord) => {
    const shouldDelete = window.confirm(`Delete ${documentRecord.fileName}?`);
    if (!shouldDelete) return;

    try {
      setActiveDocumentId(documentRecord.id);
      setStatus(`Deleting ${documentRecord.fileName}...`);
      await deleteTutorMarksDocument(documentRecord);
      setDocuments((current) => current.filter((item) => item.id !== documentRecord.id));
      setStatus('Document deleted.');
    } catch (error) {
      setStatus(error.message || 'Could not delete document.');
    } finally {
      setActiveDocumentId('');
    }
  };

  const handleRemoveSubject = async (subject) => {
    const shouldRemove = window.confirm(`Remove ${subject} from your profile?`);
    if (!shouldRemove) return;

    try {
      setSaving(true);
      setStatus(`Removing ${subject}...`);
      await removeUserSubject({ uid: profile.uid, subject });
      await refreshProfile(profile.uid);
      setStatus(`${subject} removed from your profile.`);
    } catch (error) {
      setStatus(error.message || 'Could not remove subject.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStudentAvailability = async (subject) => {
    const nextAvailability = subjectAvailability[subject] === false;

    try {
      setSaving(true);
      setStatus(`${nextAvailability ? 'Activating' : 'Pausing'} ${subject}...`);
      await updateUserSubjectAvailability({ uid: profile.uid, subject, available: nextAvailability });
      await refreshProfile(profile.uid);
      setStatus(`${subject} is now ${nextAvailability ? 'active' : 'paused'}.`);
    } catch (error) {
      setStatus(error.message || 'Could not update subject availability.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppShell title="Subjects" subtitle="Manage the subjects connected to your Examifying account." role={role} user={profile} onLogout={logout}>
      <section className="panel p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-950">Current subjects</p>
          {role === ROLES.STUDENT && subscriptionState?.paymentCompleted ? <p className="text-xs font-medium text-slate-500">{currentSubjects.length} of {subjectLimit} included subjects selected</p> : null}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {currentSubjects.length ? currentSubjects.map((subject) => {
            const isStudentSubjectActive = subjectAvailability[subject] !== false;

            return (
              <div key={subject} className="rounded-2xl bg-brand-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-brand-700">
                      {subject}
                      {isTutorRole && tutorMarkBySubject.has(subject) ? (
                        <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-xs text-brand-600">{tutorMarkBySubject.get(subject)}%</span>
                      ) : null}
                    </p>
                    {role === ROLES.STUDENT ? (
                      <p className={`mt-1 text-xs font-medium ${isStudentSubjectActive ? 'text-emerald-700' : 'text-slate-500'}`}>
                        {isStudentSubjectActive ? 'Active' : 'Paused'}
                      </p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveSubject(subject)}
                    className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-white text-base font-bold leading-none text-rose-600 shadow-sm transition hover:bg-rose-50"
                    disabled={saving}
                    aria-label={`Remove ${subject}`}
                    title={`Remove ${subject}`}
                  >
                    ×
                  </button>
                </div>

                {role === ROLES.STUDENT ? (
                  <button
                    type="button"
                    onClick={() => handleToggleStudentAvailability(subject)}
                    disabled={saving}
                    className={`mt-3 flex w-full items-center justify-between rounded-full p-1 text-xs font-semibold transition ${isStudentSubjectActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}
                  >
                    <span className="px-3">{isStudentSubjectActive ? 'Available' : 'Unavailable'}</span>
                    <span className={`h-6 w-6 rounded-full bg-white shadow-sm transition ${isStudentSubjectActive ? 'translate-x-0' : ''}`} />
                  </button>
                ) : null}
              </div>
            );
          }) : <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-700">No subjects added yet</span>}
        </div>
      </section>

      {role === ROLES.STUDENT && subscriptionState?.paymentCompleted ? (
        <form onSubmit={handleAddStudentSubjects} className="panel space-y-4 p-5">
          <div>
            <p className="text-sm font-semibold text-slate-950">Add subjects</p>
            <p className="mt-1 text-sm text-slate-500">Your plan allows {subjectLimit} registered {subjectLimit === 1 ? 'subject' : 'subjects'}. Remove a current subject to make room for a replacement.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_auto]">
            <select
              className="input"
              value={subjectToAdd}
              onChange={(event) => setSubjectToAdd(event.target.value)}
              disabled={!availableSubjects.length || remainingSubjectSlots === 0}
            >
              <option value="">Select a subject</option>
              {availableSubjects
                .filter((subject) => !selectedSubjects.includes(subject))
                .map((subject) => <option key={subject} value={subject}>{subject}</option>)}
            </select>
            <button type="button" className="btn-secondary" onClick={handleAddSubjectToSelection} disabled={!subjectToAdd || remainingSubjectSlots === 0}>
              Add to list
            </button>
          </div>
          <div className="min-h-16 rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Selected subjects</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedSubjects.length ? selectedSubjects.map((subject) => (
                <button
                  key={subject}
                  type="button"
                  onClick={() => handleRemoveSelectedSubject(subject)}
                  className="rounded-full bg-white px-3 py-1 text-sm font-semibold text-brand-700 shadow-sm transition hover:bg-rose-50 hover:text-rose-600"
                  title="Remove subject"
                >
                  {subject} ×
                </button>
              )) : <span className="text-sm text-slate-500">No subjects selected yet.</span>}
            </div>
          </div>
          <button className="btn-primary w-full md:w-auto" disabled={saving || !selectedSubjects.length || selectedSubjects.length > subjectLimit - currentSubjects.length}>Save subjects</button>
        </form>
      ) : role === ROLES.STUDENT ? (
        <div className="panel p-5 text-sm text-slate-600">Choose Circle or Personalized to manage registered subjects.</div>
      ) : null}

      {isTutorRole ? (
        <>
          <form ref={tutorUploadFormRef} onSubmit={handleTutorUpload} className="panel space-y-4 p-5">
            <div>
              <p className="text-sm font-semibold text-slate-950">Add more tutor subjects</p>
              <p className="mt-1 text-sm text-slate-500">Upload another marks document. AI will only add eligible listed subjects with marks of 60% or above.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <input type="file" className="input" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              <button className="btn-primary" disabled={saving}>{saving ? 'Checking...' : 'Upload marks proof'}</button>
            </div>
          </form>

          <section className="panel p-5">
            <p className="text-sm font-semibold text-slate-950">Uploaded marks documents</p>
            <div className="mt-4 space-y-3">
              {documents.map((documentRecord) => (
                <div key={documentRecord.id} className="rounded-2xl bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-900">{documentRecord.fileName}</p>
                      <p className="mt-1 text-xs text-slate-500">Uploaded {formatDate(documentRecord.createdAt)}</p>
                    </div>
                    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${statusStyles[documentRecord.status] ?? 'bg-slate-100 text-slate-600'}`}>
                      {documentRecord.status ?? 'processing'}
                    </span>
                  </div>
                  {documentRecord.progressMessage ? <p className="mt-3 text-sm text-slate-600">{documentRecord.progressMessage}</p> : null}
                  {documentRecord.errorMessage ? <p className="mt-3 text-sm text-rose-600">{documentRecord.errorMessage}</p> : null}
                  {documentRecord.addedSubjects?.length ? <p className="mt-3 text-sm text-emerald-700">Added: {documentRecord.addedSubjects.join(', ')}</p> : null}
                  {documentRecord.extractedMarks?.length ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {documentRecord.extractedMarks.map((item) => (
                        <span key={`${documentRecord.id}-${item.subject}-${item.mark}`} className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-600">
                          {item.subject}: {item.mark}%
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-2">
                    <button type="button" className="btn-secondary px-4 py-2" onClick={() => handleRetry(documentRecord)} disabled={activeDocumentId === documentRecord.id || documentRecord.status === 'processing'}>
                      Retry
                    </button>
                    <button type="button" className="rounded-full bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-600 transition hover:bg-rose-100" onClick={() => handleDelete(documentRecord)} disabled={activeDocumentId === documentRecord.id || documentRecord.status === 'processing'}>
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {!documents.length ? <p className="text-sm text-slate-500">No marks documents have been uploaded yet.</p> : null}
            </div>
          </section>
        </>
      ) : null}

      {status ? <div className="panel p-5 text-sm text-slate-600">{status}</div> : null}
      {result?.extractedMarks?.length ? (
        <section className="panel p-5">
          <p className="text-sm font-semibold text-slate-950">Last extracted marks</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {result.extractedMarks.map((item) => (
              <div key={`${item.subject}-${item.mark}`} className="rounded-xl bg-slate-50 px-3 py-2 text-sm">
                <p className="font-semibold text-slate-900">{item.subject}</p>
                <p className={Number(item.mark) >= 60 ? 'text-emerald-600' : 'text-slate-500'}>{item.mark}%</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </AppShell>
  );
};
