import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../../components/common/AppShell';
import { LoadingState } from '../../components/common/LoadingState';
import { useAuth } from '../../hooks/useAuth';
import { ROLES } from '../../lib/constants';
import { addStudentSubjects, getActiveSubjectsForStudent, getGlobalSubjects, getStudentSubjectHistoryOptions, getTutorMarksDocuments, removeUserSubject, updateUserSubjectAvailability } from '../../services/firestoreService';
import { deleteTutorMarksDocument, retryTutorMarksDocument, uploadTutorMarksDocument } from '../../services/storageService';
import { getApprovedTutorSubjects } from '../../utils/tutorSubjects';
import { useStudentSubscriptionState } from '../../hooks/useStudentSubscriptionState';
import { useOperationStatus } from '../../hooks/useOperationStatus';
import { getTutorWhatsAppSettings, saveTutorWhatsAppGroupLink } from '../../services/whatsappService';
import { normalizeWhatsAppGroupInviteLink } from '../../utils/whatsapp';
import { getSubjectsAvailableForGrade, isSubjectAvailableForGrade } from '../../../functions/src/subjects.js';

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
  const { runOperation } = useOperationStatus();
  const isTutorRole = role === ROLES.TUTOR || role === 'teacher';
  const subscriptionState = useStudentSubscriptionState(role === ROLES.STUDENT ? profile : null);
  const [selectedSubjects, setSelectedSubjects] = useState([]);
  const [subjectToAdd, setSubjectToAdd] = useState('');
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);
  const [documents, setDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(isTutorRole);
  const [activeDocumentId, setActiveDocumentId] = useState('');
  const [activeStudentSubjects, setActiveStudentSubjects] = useState([]);
  const [activeStudentSubjectsLoading, setActiveStudentSubjectsLoading] = useState(role === ROLES.STUDENT);
  const [globalSubjects, setGlobalSubjects] = useState([]);
  const [globalSubjectsLoading, setGlobalSubjectsLoading] = useState(role === ROLES.STUDENT);
  const [historyCandidates, setHistoryCandidates] = useState([]);
  const [historyCandidatesLoading, setHistoryCandidatesLoading] = useState(false);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState([]);
  const [historyCapacity, setHistoryCapacity] = useState(0);
  const [whatsappGroupLinks, setWhatsAppGroupLinks] = useState({});
  const [whatsappGroupDrafts, setWhatsAppGroupDrafts] = useState({});
  const [whatsappSettingsLoading, setWhatsAppSettingsLoading] = useState(isTutorRole);
  const tutorUploadFormRef = useRef(null);
  const loadStudentSubjects = useCallback(async () => {
    if (role !== ROLES.STUDENT || !profile?.uid) { setActiveStudentSubjectsLoading(false); return; }
    setActiveStudentSubjectsLoading(true);
    try {
      setActiveStudentSubjects(await getActiveSubjectsForStudent(profile.uid));
    } finally {
      setActiveStudentSubjectsLoading(false);
    }
  }, [profile?.uid, role]);
  const currentSubjects = useMemo(() => {
    if (isTutorRole) return getApprovedTutorSubjects(profile);
    return role === ROLES.STUDENT ? activeStudentSubjects : [];
  }, [activeStudentSubjects, isTutorRole, profile, role]);
  const availableSubjects = getSubjectsAvailableForGrade(profile?.grade, globalSubjects)
    .filter((subject) => !currentSubjects.includes(subject));
  const restorableHistoryCandidates = historyCandidates.filter((candidate) =>
    isSubjectAvailableForGrade(candidate.subject, profile?.grade) && !currentSubjects.includes(candidate.subject));
  const selectableSubjects = availableSubjects.filter((subject) => !selectedSubjects.includes(subject));
  const subjectLimit = Number(subscriptionState?.subscriptionSubjectCount) || 0;
  const remainingSubjectSlots = Math.max(0, subjectLimit - currentSubjects.length - selectedSubjects.length);
  const tutorMarkBySubject = useMemo(() => new Map(
    (profile?.tutorSubjectMarks ?? []).map((item) => [item.subject, item.mark]),
  ), [profile?.tutorSubjectMarks]);
  const subjectAvailability = profile?.subjectAvailability ?? {};

  const loadTutorDocuments = useCallback(async () => {
    if (!isTutorRole || !profile?.uid) { setDocumentsLoading(false); return; }
    setDocumentsLoading(true);
    try {
      const uploadedDocuments = await getTutorMarksDocuments(profile.uid);
      setDocuments(uploadedDocuments);
    } finally {
      setDocumentsLoading(false);
    }
  }, [isTutorRole, profile?.uid]);

  useEffect(() => {
    loadTutorDocuments().catch((error) => {
      console.error('[Examifying][TutorMarksDocuments] load:error', error);
      setStatus(error.message || 'Could not load uploaded tutor documents.');
    });
  }, [loadTutorDocuments]);

  useEffect(() => {
    if (!isTutorRole || !profile?.uid) return undefined;
    let active = true;
    setWhatsAppSettingsLoading(true);
    getTutorWhatsAppSettings().then((settings) => {
      if (!active) return;
      const links = settings.groupLinks || {};
      setWhatsAppGroupLinks(links);
      setWhatsAppGroupDrafts(links);
    }).catch((error) => {
      if (active) setStatus(error.message || 'Could not load WhatsApp group settings.');
    }).finally(() => { if (active) setWhatsAppSettingsLoading(false); });
    return () => { active = false; };
  }, [isTutorRole, profile?.uid]);

  useEffect(() => {
    loadStudentSubjects().catch((error) => setStatus(error.message || 'Could not load your active subjects.'));
  }, [loadStudentSubjects]);

  useEffect(() => {
    if (role !== ROLES.STUDENT) return undefined;
    let isActive = true;
    setGlobalSubjectsLoading(true);
    getGlobalSubjects().then((subjects) => {
      if (isActive) setGlobalSubjects(subjects);
    }).catch((error) => {
      console.error('[Examifying][GlobalSubjects] load:error', error);
      if (isActive) {
        setGlobalSubjects([]);
        setStatus(error.message || 'Could not load the global subject list.');
      }
    }).finally(() => {
      if (isActive) setGlobalSubjectsLoading(false);
    });
    return () => { isActive = false; };
  }, [role]);

  useEffect(() => {
    if (role !== ROLES.STUDENT || !profile?.uid || !profile?.grade) { setHistoryCandidatesLoading(false); return undefined; }
    let isActive = true;
    setHistoryCandidatesLoading(true);
    getStudentSubjectHistoryOptions({ studentId: profile.uid, grade: profile.grade }).then((result) => {
      if (!isActive) return;
      setHistoryCandidates(Array.isArray(result.candidates) ? result.candidates : []);
      setHistoryCapacity(Number(result.subjectCapacity) || 0);
    }).catch((error) => {
      console.error('[Examifying][SubjectHistory] load:error', error);
      if (isActive) {
        setHistoryCandidates([]);
        setHistoryCapacity(0);
      }
    }).finally(() => {
      if (isActive) setHistoryCandidatesLoading(false);
    });
    return () => { isActive = false; };
  }, [profile?.grade, profile?.uid, role]);

  const handleAddSubjectToSelection = () => {
    if (!subjectToAdd || selectedSubjects.includes(subjectToAdd)) return;
    if (!isSubjectAvailableForGrade(subjectToAdd, profile?.grade)) {
      setStatus(`That subject is not available for ${profile?.grade || 'your current grade'}.`);
      setSubjectToAdd('');
      return;
    }
    if (currentSubjects.length + selectedSubjects.length >= subjectLimit) {
      setStatus(`Your subscription includes up to ${subjectLimit} subjects. Remove a current subject before adding another.`);
      return;
    }
    setSelectedSubjects((current) => [...current, subjectToAdd]);
    setSubjectToAdd('');
  };

  const handleRemoveSelectedSubject = (subject) => {
    setSelectedSubjects((current) => current.filter((item) => item !== subject));
    const candidate = historyCandidates.find((item) => item.subject === subject);
    if (candidate) setSelectedHistoryIds((current) => current.filter((id) => id !== candidate.episodeId));
  };

  const handleRestoreHistoryChoice = (candidate, checked) => {
    if (checked && !isSubjectAvailableForGrade(candidate.subject, profile?.grade)) {
      setStatus(`${candidate.subject} is not available for ${profile?.grade || 'your current grade'}.`);
      return;
    }
    if (checked && !selectedSubjects.includes(candidate.subject)) {
      if (currentSubjects.length + selectedSubjects.length >= subjectLimit) {
        setStatus(`Your subscription includes up to ${subjectLimit} subjects. Remove a current subject before adding another.`);
        return;
      }
      setSelectedSubjects((current) => [...current, candidate.subject]);
    }
    setSelectedHistoryIds((current) => checked
      ? [...new Set([...current, candidate.episodeId])]
      : current.filter((id) => id !== candidate.episodeId));
  };

  const handleAddStudentSubjects = async (event) => {
    event.preventDefault();
    if (!selectedSubjects.length) {
      setStatus('Choose at least one subject to add.');
      return;
    }
    if (selectedSubjects.some((subject) => !isSubjectAvailableForGrade(subject, profile?.grade))) {
      setStatus(`Choose only subjects available for ${profile?.grade || 'your current grade'}.`);
      return;
    }
    if (!subscriptionState?.paymentCompleted || currentSubjects.length + selectedSubjects.length > subjectLimit) {
      setStatus(`Your active subscription allows up to ${subjectLimit} subjects. Remove a current subject or update your subscription first.`);
      return;
    }

    try {
      setSaving(true);
      setStatus('Adding subjects...');
      await runOperation({ operationName: 'Adding subjects', successMessage: 'Your subjects were updated.' }, async () => {
        await addStudentSubjects({ studentId: profile.uid, subjects: selectedSubjects, restoreSubjectInstanceIds: selectedHistoryIds });
        await loadStudentSubjects();
        await refreshProfile(profile.uid);
      });
      setStatus(`${selectedSubjects.join(', ')} added to your subjects.`);
      setSelectedSubjects([]);
      setSelectedHistoryIds([]);
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
      const uploadResult = await runOperation({ operationName: 'Uploading and processing tutor marks', successMessage: 'The marks document was processed.' }, () => uploadTutorMarksDocument({ file, tutor: profile, onProgress: setStatus }));
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
      const retryResult = await runOperation({ operationName: `Reprocessing ${documentRecord.fileName}`, successMessage: 'The marks document was processed.' }, () => retryTutorMarksDocument({ documentRecord, tutor: profile, onProgress: setStatus }));
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
      await runOperation({ operationName: 'Deleting uploaded marks document', successMessage: 'The document and its uploaded file were deleted.' }, () => deleteTutorMarksDocument(documentRecord));
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
      await runOperation({ operationName: `Removing ${subject}`, successMessage: 'The subject was removed.' }, async () => {
        await removeUserSubject({ uid: profile.uid, subject });
        await loadStudentSubjects();
        await refreshProfile(profile.uid);
      });
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
      await runOperation({ operationName: `${nextAvailability ? 'Activating' : 'Pausing'} ${subject}`, successMessage: 'Subject availability was updated.' }, async () => {
        await updateUserSubjectAvailability({ uid: profile.uid, subject, available: nextAvailability });
        await refreshProfile(profile.uid);
      });
      setStatus(`${subject} is now ${nextAvailability ? 'active' : 'paused'}.`);
    } catch (error) {
      setStatus(error.message || 'Could not update subject availability.');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveWhatsAppGroup = async (subject, remove = false) => {
    try {
      const groupLink = remove ? '' : normalizeWhatsAppGroupInviteLink(whatsappGroupDrafts[subject] || '');
      setSaving(true);
      setStatus(`${remove ? 'Removing' : 'Saving'} ${subject} WhatsApp group link...`);
      const result = await runOperation({ operationName: `${remove ? 'Removing' : 'Saving'} ${subject} group link`, successMessage: 'The lesson group link was updated.' }, () => saveTutorWhatsAppGroupLink({ subject, groupLink }));
      setWhatsAppGroupLinks((current) => ({ ...current, [subject]: result.groupLink || '' }));
      setWhatsAppGroupDrafts((current) => ({ ...current, [subject]: result.groupLink || '' }));
      setStatus(result.groupLink ? `${subject} WhatsApp group link saved.` : `${subject} WhatsApp group link removed.`);
    } catch (error) {
      setStatus(error.message || 'Could not save the WhatsApp group link.');
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
          {activeStudentSubjectsLoading ? <LoadingState className="sm:col-span-2 lg:col-span-3" label="Loading selected subjects…" /> : currentSubjects.length ? currentSubjects.map((subject) => {
            const isStudentSubjectActive = subjectAvailability[subject] !== false;

            return (
              <div key={subject} className="rounded-2xl bg-brand-50 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-brand-700">
                      {subject}
                      {isTutorRole && tutorMarkBySubject.has(subject) ? (
                        <span className="ml-2 rounded-full border border-lime-300 bg-lime-200 px-2 py-0.5 text-xs font-semibold text-slate-900">{tutorMarkBySubject.get(subject)}%</span>
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
                    className={`hidden mt-3 flex w-full items-center justify-between rounded-full p-1 text-xs font-semibold transition ${isStudentSubjectActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'}`}
                  >
                    <span className="px-3">{isStudentSubjectActive ? 'Available' : 'Unavailable'}</span>
                    <span className={`h-6 w-6 rounded-full bg-white shadow-sm transition ${isStudentSubjectActive ? 'translate-x-0' : ''}`} />
                  </button>
                ) : null}

                {isTutorRole ? (
                  <div className="mt-4 border-t border-lime-900/10 pt-3">
                    <label className="grid gap-2 text-xs font-semibold text-slate-800">
                      WhatsApp group invite link
                      <input
                        type="url"
                        className="input bg-white text-slate-900 placeholder:text-slate-500"
                        value={whatsappGroupDrafts[subject] || ''}
                        onChange={(event) => setWhatsAppGroupDrafts((current) => ({ ...current, [subject]: event.target.value }))}
                        placeholder={whatsappSettingsLoading ? 'Loading saved link…' : 'https://chat.whatsapp.com/...'}
                        disabled={saving || whatsappSettingsLoading}
                        aria-label={`${subject} WhatsApp group invite link`}
                      />
                    </label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button type="button" className="btn-secondary h-9 px-3 text-xs" onClick={() => handleSaveWhatsAppGroup(subject)} disabled={saving || whatsappSettingsLoading || !whatsappGroupDrafts[subject]?.trim()}>
                        Save group link
                      </button>
                      {whatsappGroupLinks[subject] ? <button type="button" className="h-9 rounded-full border border-rose-300 px-3 text-xs font-semibold text-rose-700 transition hover:bg-rose-50" onClick={() => handleSaveWhatsAppGroup(subject, true)} disabled={saving || whatsappSettingsLoading}>
                        Remove
                      </button> : null}
                    </div>
                    <p className="mt-2 text-xs text-slate-600">Only students assigned to you for this subject can receive the invite in an upcoming online group lesson.</p>
                  </div>
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
              disabled={globalSubjectsLoading || !selectableSubjects.length || remainingSubjectSlots === 0}
            >
              <option value="">{globalSubjectsLoading ? 'Loading subjects...' : !profile?.grade ? 'Set your grade to see eligible subjects' : selectableSubjects.length ? 'Select a subject' : `No additional subjects available for ${profile.grade}`}</option>
              {selectableSubjects.map((subject) => <option key={subject} value={subject}>{subject}</option>)}
            </select>
            <button type="button" className="btn-secondary" onClick={handleAddSubjectToSelection} disabled={!subjectToAdd || remainingSubjectSlots === 0}>
              Add to list
            </button>
          </div>
          {globalSubjectsLoading ? <LoadingState className="min-h-12 p-3" label="Loading available subjects…" /> : null}
          {restorableHistoryCandidates.length || historyCandidatesLoading ? <fieldset className="space-y-2 rounded-2xl bg-amber-50 p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-[0.15em] text-amber-800">Recent topic history (optional)</legend>
            <p className="text-xs text-amber-900">Choose a subject below if needed, then opt in to copy only its topics and understanding scores. Staff and lessons are not copied.</p>
            <div className="space-y-2">
              {historyCandidatesLoading ? <LoadingState label="Loading eligible subject history…" /> : null}
              {restorableHistoryCandidates.map((candidate) => (
                <label key={candidate.episodeId} className="flex items-start gap-3 rounded-xl bg-white/80 p-3 text-sm text-slate-700">
                  <input type="checkbox" className="mt-0.5" checked={selectedHistoryIds.includes(candidate.episodeId)} onChange={(event) => handleRestoreHistoryChoice(candidate, event.target.checked)} disabled={historyCapacity === 0 || !selectedSubjects.includes(candidate.subject) && remainingSubjectSlots === 0} />
                  <span><span className="font-semibold">{candidate.subject}</span><span className="block text-xs text-slate-500">Restore recent history from {new Date(candidate.cancelledAt).toLocaleDateString()} (capacity: {historyCapacity})</span></span>
                </label>
              ))}
            </div>
          </fieldset> : null}
          <div className="min-h-16 rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Selected subjects</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {selectedSubjects.length ? selectedSubjects.map((subject) => (
                <button
                  key={subject}
                  type="button"
                  onClick={() => handleRemoveSelectedSubject(subject)}
                  className="rounded-full border border-lime-300 bg-lime-100 px-3 py-1 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-rose-50 hover:text-rose-700"
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
              <p className="mt-1 text-sm text-slate-500">Upload a PDF or image of your results. PDF pages are rendered as images for AI review. Only listed subjects with marks of 60% or above are eligible.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <input type="file" className="input" accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
              <button className="btn-primary" disabled={saving}>{saving ? 'Checking...' : 'Upload marks proof'}</button>
            </div>
          </form>

          <section className="panel p-5">
            <p className="text-sm font-semibold text-slate-950">Uploaded marks documents</p>
            <div className="mt-4 space-y-3">
              {documentsLoading ? <LoadingState label="Loading uploaded documents…" /> : null}
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
              {!documentsLoading && !documents.length ? <p className="text-sm text-slate-500">No marks documents have been uploaded yet.</p> : null}
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
