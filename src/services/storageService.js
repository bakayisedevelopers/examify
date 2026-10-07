import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, isFirebaseConfigured, storage } from '../firebase/config';
import { callKiloImage, callKiloText } from './kiloService';
import { extractDocumentText } from './documentExtractionService';
import { collections } from '../firebase/schema';
import { SUBJECTS } from '../lib/constants';
import { extractTutorSubjectMarks, getApprovedTutorSubjects, getNewEligibleTutorSubjects, mergeBestTutorSubjectMarks } from '../utils/tutorSubjects';

const uploadFile = async ({ file, path }) => {
  const contentType = getImageContentType(file);
  if (!contentType) throw new Error('Only image files can be uploaded. Choose JPG, PNG, or HEIC files.');
  if (Number(file.size) > MAX_SUBMISSION_IMAGE_BYTES) throw new Error(`${file.name || 'This image'} exceeds the 25 MiB upload limit. Choose a smaller image.`);
  const storageRef = ref(storage, `${path}/${Date.now()}-${file.name}`);
  await uploadBytes(storageRef, file, { contentType });
  const url = await getDownloadURL(storageRef);
  return { 
    fileName: file.name, 
    url,
  };
};

const MAX_TUTOR_MARKS_DOCUMENT_BYTES = 25 * 1024 * 1024;
const getTutorMarksDocumentContentType = (file) => {
  const declaredType = String(file?.type ?? '').trim().toLowerCase();
  const extension = String(file?.name ?? '').split('.').pop()?.toLowerCase();
  if (declaredType.includes('pdf') || extension === 'pdf') return 'application/pdf';

  const imageContentType = getImageContentType(file);
  if (imageContentType) return imageContentType;
  throw new Error(`${file?.name || 'This file'} is not a supported marks document. Choose a PDF or image file.`);
};

const uploadTutorMarksDocumentFile = async ({ file, path, contentType }) => {
  if (Number(file.size) > MAX_TUTOR_MARKS_DOCUMENT_BYTES) {
    throw new Error(`${file.name || 'This document'} exceeds the 25 MiB upload limit. Choose a smaller file.`);
  }
  const storageRef = ref(storage, `${path}/${Date.now()}-${file.name}`);
  await uploadBytes(storageRef, file, { contentType });
  const url = await getDownloadURL(storageRef);
  return { fileName: file.name, url, contentType };
};

const MAX_SUBMISSION_IMAGE_BYTES = 25 * 1024 * 1024;
const IMAGE_MIME_BY_EXTENSION = {
  bmp: 'image/bmp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp',
};
const getImageContentType = (file) => {
  const declaredType = String(file?.type ?? '').trim().toLowerCase();
  if (declaredType.startsWith('image/')) return declaredType;
  if (declaredType) return '';
  const extension = String(file?.name ?? '').split('.').pop()?.toLowerCase();
  return IMAGE_MIME_BY_EXTENSION[extension] ?? '';
};
const getSouthAfricanDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const asDate = (value) => {
  const parsed = value?.toDate ? value.toDate() : value instanceof Date ? value : value ? new Date(value) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null;
};

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error ?? new Error('Could not read file for AI extraction.'));
  reader.readAsDataURL(file);
});

export const uploadSubmissionImages = async ({ files, studentId, exerciseId, subjectInstanceId }) => {
  const imageFiles = (files ?? []).filter(Boolean);
  if (!imageFiles.length) throw new Error('Choose at least one image page to submit.');
  if (!isFirebaseConfigured) {
    const submittedImages = imageFiles.map((file, index) => ({
      fileName: file.name ?? `page-${index + 1}.png`,
      url: URL.createObjectURL(file),
      pageNumber: index + 1,
    }));
    return { submittedFileName: submittedImages[0].fileName, submittedImageUrl: submittedImages[0].url, submittedImages, exerciseId };
  }
  if (!subjectInstanceId) throw new Error('An active subject episode is required to submit work.');

  const uploadedFiles = [];
  try {
    if (!auth?.currentUser || auth.currentUser.uid !== studentId) {
      throw new Error('Sign in with the student account that owns this exercise before uploading answers.');
    }
    const exerciseRef = doc(db, 'users', studentId, 'subjects', subjectInstanceId, 'exercises', exerciseId);
    const exerciseSnapshot = await getDoc(exerciseRef);
    if (!exerciseSnapshot.exists()) throw new Error('This exercise could not be found.');
    const exercise = exerciseSnapshot.data();
    if (exercise.studentId && exercise.studentId !== studentId) throw new Error('This exercise belongs to another student.');
    if (exercise.submittedImageUrl || exercise.submitted === 'Yes' || exercise.submissionStatus === 'submitted') {
      throw new Error('Work has already been submitted for this exercise.');
    }
    const opensAt = asDate(exercise.assignmentOpensAt);
    const locksAt = asDate(exercise.locksAt);
    const isOpen = opensAt && locksAt
      ? opensAt <= new Date() && new Date() < locksAt
      : String(exercise.assignmentDate ?? '').slice(0, 10) === getSouthAfricanDateKey();
    if (!isOpen) throw new Error('This upload is outside the exercise submission window. Only today’s exercise can be submitted.');
    const invalidImage = imageFiles.find((file) => !getImageContentType(file));
    if (invalidImage) throw new Error(`${invalidImage.name || 'A selected file'} is not an image. Choose JPG, PNG, or HEIC files.`);
    const oversizedImage = imageFiles.find((file) => file.size > MAX_SUBMISSION_IMAGE_BYTES);
    if (oversizedImage) throw new Error(`${oversizedImage.name || 'An image'} exceeds the 25 MiB upload limit. Choose a smaller image.`);

    const uploadBasePath = `users/${studentId}/subjects/${subjectInstanceId}/exercises/${exerciseId}/submissions`;

    const uploads = await Promise.all(imageFiles.map(async (file, index) => {
      const namedFile = new File([file], `page-${index + 1}-${file.name || 'submission.png'}`, { type: getImageContentType(file) });
      const upload = await uploadFile({ file: namedFile, path: uploadBasePath });
      uploadedFiles[index] = upload;
      return upload;
    }));
    const submittedImages = uploads.map((upload, index) => ({ ...upload, pageNumber: index + 1 }));
    const firstImage = submittedImages[0];
    const resolvedSubjectInstanceId = subjectInstanceId;

    const submittedAt = serverTimestamp();
    const fileNames = submittedImages.map((image) => image.fileName);
    const submissionData = {
      studentId,
      exerciseId,
      subjectInstanceId: resolvedSubjectInstanceId || '',
      imageUrl: firstImage.url,
      submittedImageUrl: firstImage.url,
      submittedImages,
      fileName: firstImage.fileName,
      submittedFileName: firstImage.fileName,
      submittedFileNames: fileNames,
      subject: exercise.subject ?? '',
      topic: exercise.topic ?? '',
      exerciseTitle: exercise.title ?? '',
      assignmentDate: exercise.assignmentDate ?? '',
      status: 'submitted',
      submitted: 'Yes',
      submissionStatus: 'submitted',
      submittedAt,
      updatedAt: serverTimestamp(),
    };
    const batch = writeBatch(db);
    const exercisePatch = {
      studentId,
      exerciseId,
      subjectInstanceId: resolvedSubjectInstanceId || '',
      submittedImageUrl: firstImage.url,
      submittedImages,
      submittedFileName: firstImage.fileName,
      submittedFileNames: fileNames,
      submissionPageCount: submittedImages.length,
      submittedAt,
      updatedAt: serverTimestamp(),
      peerReviewed: 'No',
      peerReviewStatus: 'pending',
      peerNotes: '',
      peerReviewDate: null,
      submitted: 'Yes',
      submissionStatus: 'submitted',
    };

    batch.set(exerciseRef, exercisePatch, { merge: true });
    const nestedSubRef = doc(db, 'users', studentId, 'subjects', resolvedSubjectInstanceId, 'exercises', exerciseId, 'submissions', exerciseId);
    batch.set(nestedSubRef, submissionData, { merge: true });
    await batch.commit();

    callKiloImage({
      imageUrl: firstImage.url,
      prompt: [
        'Analyze this student answer image for tutor review.',
        `Subject: ${exercise.subject ?? 'Unknown'}.`,
        `Exercise: ${exercise.title ?? exercise.topic ?? exerciseId}.`,
        'Summarize what is visible, note whether the work is readable, and identify likely strengths or issues without inventing marks.',
      ].join('\n'),
          maxTokens: 3000,
    }).then((analysis) => updateDoc(exerciseRef, {
      submittedImageAnalysis: analysis.text ?? '',
      submittedImageAnalysisModel: analysis.model ?? null,
      submittedImageAnalyzedAt: serverTimestamp(),
    })).catch((error) => {
      console.warn('[Examifying][Storage] answer image analysis skipped:', error);
    });

    return { submittedFileName: firstImage.fileName, submittedImageUrl: firstImage.url, submittedImages, exerciseId };
  } catch (error) {
    if (uploadedFiles.some(Boolean)) {
      await Promise.all(uploadedFiles.filter(Boolean).map(async (uploadedFile) => {
        try {
          await deleteObject(ref(storage, uploadedFile.url));
        } catch (cleanupError) {
          console.warn('[Examifying][Storage] Could not clean up an incomplete submission upload:', cleanupError?.code || cleanupError?.message);
        }
      }));
    }
    console.error('Upload/Update failed:', error);
    throw error;
  }
};

export const uploadSubmissionImage = async ({ file, studentId, exerciseId, subjectInstanceId }) =>
  uploadSubmissionImages({ files: [file], studentId, exerciseId, subjectInstanceId });

export const uploadTutorMarkedWork = async ({ file, studentId, exerciseId, subjectInstanceId }) => {
  if (!isFirebaseConfigured) {
    return { fileName: file?.name ?? 'marked-work.png', url: URL.createObjectURL(file) };
  }
  if (!subjectInstanceId) throw new Error('An active subject episode is required to upload marked work.');
  const path = `users/${studentId}/subjects/${subjectInstanceId}/exercises/${exerciseId}/tutor-marking`;
  return uploadFile({ file, path });
};

export const uploadPeerReviewImage = async ({ file, studentId, exerciseId, subjectInstanceId }) => {
  if (!isFirebaseConfigured) {
    return {
      fileName: file?.name ?? 'demo-review.png',
      url: URL.createObjectURL(file),
    };
  }

  try {
    if (!subjectInstanceId) throw new Error('An active subject episode is required to upload peer marking.');
    const path = `users/${studentId}/subjects/${subjectInstanceId}/exercises/${exerciseId}/peer-reviews`;
    const upload = await uploadFile({ file, path });
    return { 
      fileName: upload.fileName, 
      url: upload.url 
    };
  } catch (error) {
    console.error("Review upload failed:", error);
    throw error;
  }
};

export const deleteExerciseSubmissionFiles = async (urls = []) => {
  if (!isFirebaseConfigured || !storage) return;
  const uniqueUrls = [...new Set(urls.filter((url) => typeof url === 'string' && url.startsWith('https://')) )];
  await Promise.all(uniqueUrls.map(async (url) => {
    try {
      await deleteObject(ref(storage, url));
    } catch (error) {
      console.warn('[Examifying][Storage] Could not remove an exercise attachment:', error?.code || error?.message);
    }
  }));
};

export const uploadQuestionPaperDocuments = async ({ paperFile, memoFile, uploaderId, onProgress }) => {
  const invalidFile = [paperFile, memoFile].find((file) => file && file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'));
  if (invalidFile) throw new Error(`${invalidFile.name} is not a PDF. Question-paper analysis currently supports PDF files only.`);

  if (!isFirebaseConfigured) {
    return {
      paperUrl: paperFile ? URL.createObjectURL(paperFile) : '',
      memoUrl: memoFile ? URL.createObjectURL(memoFile) : '',
      paperFileName: paperFile?.name ?? '',
      memoFileName: memoFile?.name ?? '',
      paperMimeType: paperFile?.type ?? '',
      memoMimeType: memoFile?.type ?? '',
    };
  }

  onProgress?.('Uploading question paper...');
  const paperUpload = paperFile ? await uploadFile({ file: paperFile, path: `questionPapers/${uploaderId}/paper` }) : null;
  onProgress?.(memoFile ? 'Uploading memorandum...' : 'Saving paper and starting analysis...');
  const memoUpload = memoFile ? await uploadFile({ file: memoFile, path: `questionPapers/${uploaderId}/memo` }) : null;

  return {
    paperUrl: paperUpload?.url ?? '',
    memoUrl: memoUpload?.url ?? '',
    paperFileName: paperUpload?.fileName ?? '',
    memoFileName: memoUpload?.fileName ?? '',
    paperMimeType: paperFile?.type ?? '',
    memoMimeType: memoFile?.type ?? '',
  };
};



const analyzeTutorMarksDocument = async ({ documentRef, documentRecord, tutor, file, documentDataUrl, onProgress }) => {
  const existingSubjects = getApprovedTutorSubjects(tutor);

  await updateDoc(documentRef, {
    status: 'processing',
    errorMessage: '',
    progressMessage: 'Results [Starting extraction]',
    updatedAt: serverTimestamp(),
  });

  const reportProgress = async (message) => {
    onProgress?.(message);
    try {
      await updateDoc(documentRef, {
        progressMessage: message,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      console.warn('[Examifying][Storage] progress update skipped:', error);
    }
  };

  let analysis = null;

  try {
    analysis = await extractDocumentText({
      file,
      documentUrl: documentRecord.fileUrl,
      documentDataUrl,
      documentMimeType: documentRecord.mimeType,
      fileName: documentRecord.fileName,
      label: 'Results',
      prompt: [
        'OCR this scanned academic results or marks document.',
        'Transcribe all visible text, tables, subject names, result codes, marks, percentages, symbols, and totals.',
        'Do not decide eligibility yet. Do not return an empty subjects array.',
        'If the document is difficult to read, return the best visible transcription with uncertain words marked as [unclear].',
        'Return plain text only, preserving rows and columns where possible.',
      ].join('\n'),
      maxPages: 12,
      onProgress: reportProgress,
    });

    let marksText = analysis.text ?? '';
    let normalizedModel = '';

    try {
      const normalized = await callKiloText({
        system: 'You convert OCR text from academic results into strict JSON only.',
        prompt: [
          'From the OCR text below, extract subjects and their marks or percentages.',
          'Return strict JSON only with this exact shape:',
          '{"subjects":[{"subject":"Subject name","mark":75}]}',
          'If a mark is shown as a fraction, convert it to a percentage.',
          `Only include subjects that could match one of these eligible Examifying subjects: ${SUBJECTS.join(', ')}.`,
          'Use the subject names exactly as they appear in the OCR text where possible.',
          'Do not include explanations, markdown, code fences, or extra text.',
          '',
          'OCR text:',
          marksText,
        ].join('\n'),
        responseFormat: { type: 'json_object' },
        maxTokens: 1200,
        temperature: 0,
      });
      normalizedModel = normalized?.model ?? '';
      marksText = [marksText, normalized?.text ?? ''].filter(Boolean).join('\n\n');
    } catch (error) {
      console.warn('[Examifying][Storage] marks normalization skipped:', error);
    }

    const extractedMarks = extractTutorSubjectMarks(marksText);
    if (!extractedMarks.length) {
      throw new Error('AI did not return any valid eligible subject marks from this document. Please upload a clearer marks document.');
    }

    const mergedMarks = mergeBestTutorSubjectMarks({
      existingMarks: tutor?.tutorSubjectMarks ?? [],
      extractedMarks,
      minimumMark: 60,
    });
    const mergedSubjects = mergedMarks.map((item) => item.subject);
    // Use the merged marks so a previously verified Mathematics result can
    // also grant Maths Literacy on a later upload. Maths Literacy is a subject
    // grant here; no mark is fabricated for it.
    const addedSubjects = getNewEligibleTutorSubjects({ extractedMarks: mergedMarks, existingSubjects, minimumMark: 60 });
    const eligibleSubjectSet = new Set(mergedSubjects);
    const skippedSubjects = extractedMarks.filter((item) => Number(item.mark) < 60 || !eligibleSubjectSet.has(item.subject));

    const tutorRef = doc(db, collections.users, tutor.uid);
    await updateDoc(tutorRef, {
      marksDocumentUrl: documentRecord.fileUrl,
      marksDocumentFileName: documentRecord.fileName,
      marksDocumentAnalysis: marksText,
      marksDocumentAnalysisModel: [analysis.model, normalizedModel].filter(Boolean).join(', '),
      marksDocumentAnalyzedAt: serverTimestamp(),
      tutorSubjectMarks: mergedMarks,
      updatedAt: serverTimestamp(),
    });

    await updateDoc(documentRef, {
      status: 'done',
      progressMessage: `Results [${analysis.pageCount || 1}/${analysis.pageCount || 1} Extracted]`,
      extractedMarks,
      addedSubjects,
      skippedSubjects,
      mergedMarks,
      aiText: marksText,
      model: [analysis.model, normalizedModel].filter(Boolean).join(', '),
      pageCount: analysis.pageCount ?? 1,
      updatedAt: serverTimestamp(),
    });

    return {
      id: documentRef.id,
      ...documentRecord,
      extractedMarks,
      addedSubjects,
      skippedSubjects,
      mergedMarks,
      aiText: marksText,
      model: [analysis.model, normalizedModel].filter(Boolean).join(', '),
      pageCount: analysis.pageCount ?? 1,
      status: 'done',
    };
  } catch (error) {
    await updateDoc(documentRef, {
      status: 'failed',
      errorMessage: error.message || 'Marks document processing failed.',
      aiText: analysis?.text ?? '',
      model: analysis?.model ?? '',
      pageCount: analysis?.pageCount ?? 0,
      updatedAt: serverTimestamp(),
    });
    throw error;
  }
};

export const uploadTutorMarksDocument = async ({ file, tutor, onProgress }) => {
  if (!file) {
    throw new Error('Please choose a marks document before uploading.');
  }

  const contentType = getTutorMarksDocumentContentType(file);

  if (!isFirebaseConfigured) {
    return {
      fileName: file.name,
      fileUrl: URL.createObjectURL(file),
      extractedMarks: [],
      addedSubjects: [],
      skippedSubjects: [],
      aiText: '',
      model: 'demo',
      status: 'done',
    };
  }

  const documentDataUrl = contentType === 'application/pdf' ? undefined : await fileToDataUrl(file);
  const upload = await uploadTutorMarksDocumentFile({
    file,
    path: `users/${tutor.uid}/tutorMarksDocuments`,
    contentType,
  });
  const documentRecord = {
    tutorId: tutor.uid,
    fileName: upload.fileName,
    fileUrl: upload.url,
    mimeType: upload.contentType,
    status: 'processing',
    progressMessage: 'Results [Queued]',
    extractedMarks: [],
    addedSubjects: [],
    skippedSubjects: [],
    errorMessage: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const documentRef = await addDoc(collection(db, 'users', tutor.uid, 'tutorMarksDocuments'), documentRecord);

  return analyzeTutorMarksDocument({
    documentRef,
    documentRecord: { ...documentRecord, id: documentRef.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    tutor,
    file,
    documentDataUrl,
    onProgress,
  });
};

export const retryTutorMarksDocument = async ({ documentRecord, tutor, onProgress }) => {
  if (!isFirebaseConfigured) return { ...documentRecord, status: 'done' };
  if (!documentRecord?.id || !documentRecord?.fileUrl) throw new Error('Cannot retry this document because its file record is incomplete.');

  return analyzeTutorMarksDocument({
    documentRef: doc(db, 'users', tutor.uid, 'tutorMarksDocuments', documentRecord.id),
    documentRecord,
    tutor,
    onProgress,
  });
};


export const deleteTutorMarksDocument = async (documentRecord) => {
  if (!isFirebaseConfigured) return true;
  if (!documentRecord?.id) throw new Error('Cannot delete this document because its record is incomplete.');

  if (!documentRecord.tutorId) throw new Error('Tutor document ownership is missing.');
  await deleteDoc(doc(db, 'users', documentRecord.tutorId, 'tutorMarksDocuments', documentRecord.id));

  if (documentRecord.fileUrl) {
    try {
      await deleteObject(ref(storage, documentRecord.fileUrl));
    } catch (error) {
      console.warn('[Examifying][Storage] tutor marks file delete skipped:', error);
    }
  }

  return true;
};
