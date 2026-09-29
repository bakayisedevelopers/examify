import { deleteObject, getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db, isFirebaseConfigured, storage } from '../firebase/config';
import { callKiloImage, callKiloText } from './kiloService';
import { extractDocumentText } from './documentExtractionService';
import { collections } from '../firebase/schema';
import { SUBJECTS } from '../lib/constants';
import { extractTutorSubjectMarks, getApprovedTutorSubjects, getNewEligibleTutorSubjects, mergeBestTutorSubjectMarks } from '../utils/tutorSubjects';

const uploadFile = async ({ file, path }) => {
  const storageRef = ref(storage, `${path}/${Date.now()}-${file.name}`);
  await uploadBytes(storageRef, file, { contentType: file.type });
  const url = await getDownloadURL(storageRef);
  return { 
    fileName: file.name, 
    url,
  };
};

const fileToDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error ?? new Error('Could not read file for AI extraction.'));
  reader.readAsDataURL(file);
});

export const uploadSubmissionImage = async ({ file, studentId, exerciseId }) => {
  if (!isFirebaseConfigured) {
    return {
      submittedFileName: file?.name ?? 'demo-upload.jpg',
      submittedImageUrl: URL.createObjectURL(file),
      exerciseId: 'mock-id',
    };
  }

  try {
    const upload = await uploadFile({ file, path: `submissions/${studentId}/${exerciseId}` });
    const exerciseRef = doc(db, "dailyExerciseAssignments", exerciseId);
    const exerciseSnapshot = await getDoc(exerciseRef);
    const exercise = exerciseSnapshot.exists() ? exerciseSnapshot.data() : {};
    await updateDoc(exerciseRef, {
      studentId,
      exerciseId,
      submittedImageUrl: upload.url,
      submittedFileName: upload.fileName,
      updatedAt: serverTimestamp(),
      submitted: "Yes",
      peerReviewed: "No",
      peerReviewStatus: "pending",
      peerNotes: "",
      peerReviewDate: null,
    });

    callKiloImage({
      imageUrl: upload.url,
      prompt: [
        'Analyze this student answer image for tutor review.',
        `Subject: ${exercise.subject ?? 'Unknown'}.`,
        `Exercise: ${exercise.title ?? exercise.topic ?? exerciseId}.`,
        'Summarize what is visible, note whether the work is readable, and identify likely strengths or issues without inventing marks.',
      ].join('\n'),
      maxTokens: 1200,
    }).then((analysis) => updateDoc(exerciseRef, {
      submittedImageAnalysis: analysis.text ?? '',
      submittedImageAnalysisModel: analysis.model ?? null,
      submittedImageAnalyzedAt: serverTimestamp(),
    })).catch((error) => {
      console.warn('[Examifying][Storage] answer image analysis skipped:', error);
    });

    return { 
      submittedFileName: upload.fileName, 
      submittedImageUrl: upload.url, 
      exerciseId: exerciseId 
    };
  } catch (error) {
    console.error("Upload/Update failed:", error);
    throw error;
  }
};

export const uploadPeerReviewImage = async ({ file, studentId, exerciseId }) => {
  if (!isFirebaseConfigured) {
    return {
      fileName: file?.name ?? 'demo-review.png',
      url: URL.createObjectURL(file),
    };
  }

  try {
    const upload = await uploadFile({ file, path: `submissions/${studentId}/${exerciseId}` });
    return { 
      fileName: upload.fileName, 
      url: upload.url 
    };
  } catch (error) {
    console.error("Review upload failed:", error);
    throw error;
  }
};

export const getUreviewedExercises = async (studentId, subject) => {
  if (!isFirebaseConfigured) return [];

  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  const q = query(
    collection(db, "dailyExerciseAssignments"),
    where("assignmentDate", "==", todayLocal),
    ...(subject ? [where("subject", "==", subject)] : []),
    where("submittedImageUrl", "!=", ""),
    orderBy("assignmentDate", "asc"),
  );
  const querySnapshot = await getDocs(q);

  return querySnapshot.docs
    .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
    .filter((item) =>
      item.studentId !== studentId &&
      item.peerReviewed !== "Yes" &&
      item.peerReviewStatus !== "pending"
    );
};

export const uploadQuestionPaperDocuments = async ({ paperFile, memoFile, uploaderId, onProgress }) => {
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
    const addedSubjects = getNewEligibleTutorSubjects({ extractedMarks, existingSubjects, minimumMark: 60 });
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
      subjects: mergedSubjects,
      subject: existingSubjects[0] ?? mergedSubjects[0] ?? null,
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

  const documentDataUrl = await fileToDataUrl(file);
  const upload = await uploadFile({ file, path: `tutorMarks/${tutor.uid}` });
  const documentRecord = {
    tutorId: tutor.uid,
    fileName: upload.fileName,
    fileUrl: upload.url,
    mimeType: file.type || 'application/octet-stream',
    status: 'processing',
    progressMessage: 'Results [Queued]',
    extractedMarks: [],
    addedSubjects: [],
    skippedSubjects: [],
    errorMessage: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  const documentRef = await addDoc(collection(db, collections.tutorMarksDocuments), documentRecord);

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
    documentRef: doc(db, collections.tutorMarksDocuments, documentRecord.id),
    documentRecord,
    tutor,
    onProgress,
  });
};


export const deleteTutorMarksDocument = async (documentRecord) => {
  if (!isFirebaseConfigured) return true;
  if (!documentRecord?.id) throw new Error('Cannot delete this document because its record is incomplete.');

  await deleteDoc(doc(db, collections.tutorMarksDocuments, documentRecord.id));

  if (documentRecord.fileUrl) {
    try {
      await deleteObject(ref(storage, documentRecord.fileUrl));
    } catch (error) {
      console.warn('[Examifying][Storage] tutor marks file delete skipped:', error);
    }
  }

  return true;
};
