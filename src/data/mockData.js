import { addDays, formatISO, subDays } from 'date-fns';
import { DEFAULT_SUBJECT, PAPER_MONTHS, ROLES } from '../lib/constants';

const today = new Date();

export const mockUsers = {
  'student@example.com': {
    uid: 'mock-student-1',
    email: 'student@example.com',
    displayName: 'Naledi Khumalo',
    role: ROLES.STUDENT,
    previousYearMark: 62,
    latestMark: 62,
    sessionType: 'online',
    grade: 'Grade 10',
    province: 'Gauteng',
    tutorId: 'mock-tutor-1',
    subscriptionStatus: 'active',
    paymentCompleted: true,
  },
  'student2@example.com': {
    uid: 'mock-student-2',
    email: 'student2@example.com',
    displayName: 'Ayanda Molefe',
    role: ROLES.STUDENT,
    previousYearMark: 48,
    latestMark: 48,
    sessionType: 'inPerson',
    grade: 'Grade 10',
    province: 'Gauteng',
    tutorId: null,
    subscriptionStatus: 'pending',
    paymentCompleted: false,
  },
  'tutor@example.com': {
    uid: 'mock-tutor-1',
    email: 'tutor@example.com',
    displayName: 'Mr. Dlamini',
    role: ROLES.TUTOR,
    subjects: [DEFAULT_SUBJECT],
    subject: DEFAULT_SUBJECT,
  },
  'admin@example.com': {
    uid: 'mock-admin-1',
    email: 'admin@example.com',
    displayName: 'Examifying Admin',
    role: ROLES.ADMIN,
  },
};

export const mockQuestionPapers = [
  {
    id: 'qp-1',
    subject: DEFAULT_SUBJECT,
    grade: 'Grade 10',
    year: 2023,
    month: 'June',
    region: 'Gauteng',
    paperUrl: 'https://example.com/gauteng-june-2023-maths-paper.pdf',
    memoUrl: 'https://example.com/gauteng-june-2023-maths-memo.pdf',
    createdBy: 'mock-tutor-1',
  },
  {
    id: 'qp-2',
    subject: DEFAULT_SUBJECT,
    grade: 'Grade 10',
    year: 2022,
    month: 'September',
    region: 'National',
    paperUrl: 'https://example.com/national-september-2022-maths-paper.pdf',
    memoUrl: '',
    createdBy: 'mock-admin-1',
  },
];

export const mockTutorReports = [
  {
    id: 'r-1',
    studentId: 'mock-student-1',
    tutorId: 'mock-tutor-1',
    subject: DEFAULT_SUBJECT,
    studentName: 'Naledi Khumalo',
    note: 'Confidence improving; assign mixed factorisation questions next week.',
    updatedAt: '2026-03-15T10:00:00.000Z',
  },
];

export const mockCompletedLessons = [
  {
    id: 'lesson-1',
    studentId: 'mock-student-1',
    tutorId: 'mock-tutor-1',
    subject: DEFAULT_SUBJECT,
    topic: 'Factorisation of trinomials',
    topicReport: 'Learner can factorise with some prompting and should revise sign handling.',
    understandingLevel: 6,
    completedOn: '2026-03-12',
  },
];

export const mockStudentAssignments = [
  { studentId: 'mock-student-1', tutorId: 'mock-tutor-1', subject: DEFAULT_SUBJECT, active: true },
];


export const mockGuideQuizResults = [
  {
    id: 'guide-result-student-1',
    userId: 'mock-student-1',
    role: ROLES.STUDENT,
    userName: 'Naledi Khumalo',
    percentage: 100,
    score: 4,
    totalQuestions: 4,
    answers: {
      'student-q1': 'a',
      'student-q2': 'a',
      'student-q3': 'a',
      'student-q4': 'a',
    },
    submittedAt: '2026-03-20T10:00:00.000Z',
  },
  {
    id: 'guide-result-tutor-1',
    userId: 'mock-tutor-1',
    role: ROLES.TUTOR,
    userName: 'Mr. Dlamini',
    percentage: 75,
    score: 3,
    totalQuestions: 4,
    answers: {
      'tutor-q1': 'a',
      'tutor-q2': 'a',
      'tutor-q3': 'a',
      'tutor-q4': 'b',
    },
    submittedAt: '2026-03-21T11:30:00.000Z',
  },
];

export const mockDashboardData = {
  student: {
    stats: [
      { label: 'Average mark', value: '62%', detail: 'Last 4 exercises' },
      { label: 'Completed topics', value: '1', detail: 'Tutor confirmed' },
      { label: 'Peer reviews', value: '3', detail: 'Awaiting 1' },
      { label: 'Subscription', value: 'Active', detail: 'Renews monthly' },
    ],
    todayExercise: {
      id: 'exercise-today',
      assignmentDate: formatISO(today, { representation: 'date' }),
      title: 'Quadratic factorisation practice',
      sourceLabel: '2023 Gauteng June Paper, Q4.2',
      topic: 'Factorisation of trinomials',
      instruction: 'Answer Q4.2 and show all working on paper before uploading your image.',
    },
    exerciseHistory: [
      {
        id: 'exercise-prev-1',
        assignmentDate: formatISO(subDays(today, 1), { representation: 'date' }),
        title: 'Linear equations word problem',
        topic: 'Linear equations',
        submitted: true,
      },
      {
        id: 'exercise-prev-2',
        assignmentDate: formatISO(subDays(today, 2), { representation: 'date' }),
        title: 'Percentages and ratio revision',
        topic: 'Ratios',
        submitted: false,
      },
      {
        id: 'exercise-next-1',
        assignmentDate: formatISO(addDays(today, 1), { representation: 'date' }),
        title: 'Upcoming simultaneous equations',
        topic: 'Simultaneous equations',
        submitted: false,
      },
    ],
    peerReviewAssignment: {
      id: 'peer-1',
      reviewerId: 'mock-student-1',
      submissionId: 'submission-peer-1',
      studentName: 'Ayanda Molefe',
      prompt: 'Mark correctness, method, and final answer clarity.',
      assignmentDate: formatISO(today, { representation: 'date' }),
      ownSubmissionComplete: true,
      peerReviewSubmitted: false,
    },
    progress: [
      { topic: 'Factorisation of trinomials', mark: 62 },
    ],
    feedback: [
      { id: 'fb-1', title: 'Tutor note', message: 'Focus on checking sign changes in factorisation.' },
    ],
  },
  tutor: {
    stats: [
      { label: 'Assigned students', value: '1', detail: DEFAULT_SUBJECT },
      { label: 'Unassigned students', value: '1', detail: 'Ready to add' },
      { label: 'Question papers', value: String(mockQuestionPapers.length), detail: 'Published' },
      { label: 'Reports due', value: '1', detail: 'This week' },
    ],
    students: [
      { id: 'mock-student-1', name: 'Naledi Khumalo', grade: 'Grade 10', latestMark: 62, province: 'Gauteng', paymentCompleted: true },
    ],
    unassignedStudents: [
      { id: 'mock-student-2', name: 'Ayanda Molefe', grade: 'Grade 10', latestMark: 48, province: 'Gauteng', paymentCompleted: false },
    ],
    completedTopics: mockCompletedLessons,
    reports: mockTutorReports,
    questionPapers: mockQuestionPapers,
  },
  admin: {
    stats: [
      { label: 'Active students', value: '2', detail: '1 has paid' },
      { label: 'Active tutors', value: '1', detail: 'Subject tutors' },
      { label: 'Monthly revenue', value: 'R440.00', detail: 'Projected' },
      { label: 'Platform alerts', value: '0', detail: 'All clear' },
    ],
    payments: [
      { id: 'pay-1', studentName: 'Naledi Khumalo', amount: 'R440.00', status: 'Paid', month: `${PAPER_MONTHS[0]} 2026` },
    ],
    tutors: [
      { id: 'mock-tutor-1', name: 'Mr. Dlamini', students: 1, province: 'Gauteng' },
    ],
  },
};
