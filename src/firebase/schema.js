export const collections = {
  users: 'users',
  questionPapers: 'questionPapers',
  topicResolverMappings: 'topicResolverMappings',
  settings: 'settings',
};

export const subcollections = {
  subjects: 'subjects',
  topics: 'topics',
  understandingScores: 'understandingScores',
  lessons: 'lessons',
  exercises: 'exercises',
  submissions: 'submissions',
  peerReviews: 'peerReviews',
  peerMarkingAssignments: 'peerMarkingAssignments',
  generationRuns: 'generationRuns',
  subscriptions: 'subscriptions',
  history: 'history',
  subscriptionAuthorizations: 'subscriptionAuthorizations',
  payments: 'payments',
  guideQuizResults: 'guideQuizResults',
  notifications: 'notifications',
  notificationTokens: 'notificationTokens',
  notificationLogs: 'notificationLogs',
  tutorMarksDocuments: 'tutorMarksDocuments',
};

export const paths = {
  user: (uid) => `users/${uid}`,
  studentSubjects: (studentId) => `users/${studentId}/subjects`,
  studentSubject: (studentId, subjectInstanceId) => `users/${studentId}/subjects/${subjectInstanceId}`,
  subjectTopics: (studentId, subjectInstanceId) => `users/${studentId}/subjects/${subjectInstanceId}/topics`,
  subjectTopic: (studentId, subjectInstanceId, canonicalTopicKey) => `users/${studentId}/subjects/${subjectInstanceId}/topics/${canonicalTopicKey}`,
  topicUnderstandingScores: (studentId, subjectInstanceId, canonicalTopicKey) => `users/${studentId}/subjects/${subjectInstanceId}/topics/${canonicalTopicKey}/understandingScores`,
  subjectLessons: (studentId, subjectInstanceId) => `users/${studentId}/subjects/${subjectInstanceId}/lessons`,
  subjectLesson: (studentId, subjectInstanceId, lessonId) => `users/${studentId}/subjects/${subjectInstanceId}/lessons/${lessonId}`,
  subjectExercises: (studentId, subjectInstanceId) => `users/${studentId}/subjects/${subjectInstanceId}/exercises`,
  subjectExercise: (studentId, subjectInstanceId, exerciseId) => `users/${studentId}/subjects/${subjectInstanceId}/exercises/${exerciseId}`,
  exerciseSubmissions: (studentId, subjectInstanceId, exerciseId) => `users/${studentId}/subjects/${subjectInstanceId}/exercises/${exerciseId}/submissions`,
  exercisePeerReviews: (studentId, subjectInstanceId, exerciseId) => `users/${studentId}/subjects/${subjectInstanceId}/exercises/${exerciseId}/peerReviews`,
  exercisePeerAssignments: (studentId, subjectInstanceId, exerciseId) => `users/${studentId}/subjects/${subjectInstanceId}/exercises/${exerciseId}/peerMarkingAssignments`,
  generationRuns: (studentId, subjectInstanceId) => `users/${studentId}/subjects/${subjectInstanceId}/generationRuns`,
  generationRun: (studentId, subjectInstanceId, dateKey) => `users/${studentId}/subjects/${subjectInstanceId}/generationRuns/${dateKey}`,
  studentSubscriptionCurrent: (studentId) => `users/${studentId}/subscriptions/current`,
  studentSubscriptionHistory: (studentId) => `users/${studentId}/subscriptions/current/history`,
  studentAuthCurrent: (studentId) => `users/${studentId}/subscriptionAuthorizations/current`,
  studentPayments: (studentId) => `users/${studentId}/payments`,
  studentPayment: (studentId, reference) => `users/${studentId}/payments/${reference}`,
  tutorMarksDocuments: (tutorId) => `users/${tutorId}/tutorMarksDocuments`,
  tutorMarksDocument: (tutorId, docId) => `users/${tutorId}/tutorMarksDocuments/${docId}`,
};

export const firestoreIndexes = {
  subjects: ['activeStaffIds', 'status'],
  peerMarkingAssignmentsGroup: ['reviewerId', 'status', 'assignmentDate'],
};
