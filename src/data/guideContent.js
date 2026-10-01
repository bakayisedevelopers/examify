import { BookOpen, CheckCircle2, ClipboardCheck, CreditCard, FileText, Image, LayoutDashboard, Sparkles, Upload, Users } from 'lucide-react';

export const guideContentByRole = {
  student: {
    heroTitle: 'Learn the Examifying student journey',
    heroDescription:
      'Follow the same order you will use in the app: complete billing, open only today’s exercise, upload your written answer as an image, and then complete peer review when it unlocks.',
    quickTips: [
      'Use the Billing page first if your dashboard says payment is still required.',
      'Only today\'s exercise is available for submission; missed work stays locked.',
      'Write answers on paper and upload a clear image of your working.',
      'Peer review unlocks after you have submitted your own answer.',
    ],
    sections: [
      {
        id: 'overview',
        title: 'Start on your dashboard',
        description: 'The dashboard shows your payment status, today\'s exercise, tutor support, and your recent activity in one place.',
        icon: LayoutDashboard,
        routeLabel: 'Overview',
        steps: [
          'Read the payment banner first so you know whether lessons and exercises are unlocked.',
          'Check the Today\'s Exercise card to see the current topic and instructions.',
          'Review the AI recommendations and tutor support cards for learning guidance.',
        ],
      },
      {
        id: 'billing',
        title: 'Complete billing before practice unlocks',
        description: 'Billing calculates the student subscription from your mark and session type. Once payment is verified, the learning flow can continue.',
        icon: CreditCard,
        routeLabel: 'Billing',
        steps: [
          'Open Billing from the left menu when the dashboard says payment is required.',
          'Review the monthly amount and recommended sessions.',
          'Use Pay Now and wait for confirmation before returning to the dashboard.',
        ],
      },
      {
        id: 'exercise',
        title: 'Complete only today\'s exercise',
        description: 'Examifying opens the current day\'s Maths exercise and keeps future or missed work unavailable for submission.',
        icon: BookOpen,
        routeLabel: 'Exercises',
        steps: [
          'Open the exercise title and read the topic and paper reference carefully.',
          'Complete the work on paper and show full Maths working steps.',
          'Do not wait for another day if the task is open now, because missed exercises are locked.',
        ],
      },
      {
        id: 'upload',
        title: 'Upload your answer image',
        description: 'Your answer is submitted as an image so your tutor and peer reviewer can check your written working.',
        icon: Upload,
        routeLabel: 'Overview',
        steps: [
          'Take a clear photo of the page with good lighting and the full answer visible.',
          'Use the upload panel after your daily exercise appears.',
          'Confirm the correct exercise before submitting the image.',
        ],
      },
      {
        id: 'review',
        title: 'Finish your peer review',
        description: 'Peer review becomes available after your own submission, helping you practise marking and reflection.',
        icon: ClipboardCheck,
        routeLabel: 'Peer reviews',
        steps: [
          'Open Peer reviews only after your own answer has been uploaded.',
          'Score the classmate\'s work honestly and explain the mark clearly.',
          'Use constructive comments that point out both strengths and corrections.',
        ],
      },
      {
        id: 'support',
        title: 'Use your extra support pages',
        description: 'Past papers and your profile help you stay organised while your tutor manages the learning path.',
        icon: FileText,
        routeLabel: 'Past papers / Profile',
        steps: [
          'Use Past papers to browse revision material that matches your level.',
          'Keep your profile and learning details up to date.',
          'Contact your tutor through the normal support process if anything looks incorrect.',
        ],
      },
    ],
    quizTitle: 'Student readiness check',
    quizDescription: 'Answer all questions to confirm you understand how to use Examifying as a student.',
    questions: [
      {
        id: 'student-q1',
        prompt: 'What should you do first if your dashboard says lessons are locked because payment is required?',
        options: [
          { id: 'a', text: 'Open Billing and complete payment verification.', correct: true },
          { id: 'b', text: 'Wait for a tutor report before paying.', correct: false },
          { id: 'c', text: 'Upload any answer image to unlock the exercise.', correct: false },
        ],
      },
      {
        id: 'student-q2',
        prompt: 'Which exercise should a student complete and submit?',
        options: [
          { id: 'a', text: 'Only today\'s assigned exercise.', correct: true },
          { id: 'b', text: 'Any exercise in the history list.', correct: false },
          { id: 'c', text: 'Tomorrow\'s exercise if you are ahead.', correct: false },
        ],
      },
      {
        id: 'student-q3',
        prompt: 'How must a student submit their Maths answer?',
        options: [
          { id: 'a', text: 'As an uploaded image of their written work.', correct: true },
          { id: 'b', text: 'As a typed paragraph in the dashboard.', correct: false },
          { id: 'c', text: 'As a voice note to the tutor.', correct: false },
        ],
      },
      {
        id: 'student-q4',
        prompt: 'When does peer review become available for a student?',
        options: [
          { id: 'a', text: 'After the student has submitted their own work.', correct: true },
          { id: 'b', text: 'Before the student opens any exercise.', correct: false },
          { id: 'c', text: 'Only after the admin approves the account manually.', correct: false },
        ],
      },
    ],
  },
  tutor: {
    heroTitle: 'Learn the Examifying tutor workflow',
    heroDescription:
      'Tutors manage the student learning path by assigning learners, creating reports, recording completed topics, and keeping the weekly exercise pipeline moving.',
    quickTips: [
      'Assign a student before trying to manage their lesson journey.',
      'Create the first report so the learner has proper learning context.',
      'Record completed topics with an understanding level after each lesson.',
      'Keep notes clear because they shape future exercise planning.',
    ],
    sections: [
      {
        id: 'assign',
        title: 'Assign students to yourself',
        description: 'The tutor dashboard shows assigned and unassigned learners so you can claim and manage your student list.',
        icon: Users,
        routeLabel: 'Overview / Students',
        steps: [
          'Open the Students area or tutor overview to see available learners.',
          'Assign a student so they are linked to you as their Maths tutor.',
          'Open the learner card to continue with reports and topic tracking.',
        ],
      },
      {
        id: 'report',
        title: 'Write the initial learner report',
        description: 'The initial report gives context on the learner’s current ability and becomes part of the planning history.',
        icon: FileText,
        routeLabel: 'Overview',
        steps: [
          'Select the learner from your assigned list.',
          'Write the first report clearly with strengths, concerns, and next focus areas.',
          'Save the report before moving into later lesson updates.',
        ],
      },
      {
        id: 'lessons',
        title: 'Mark completed topics after tutoring',
        description: 'Each completed lesson should record the topic taught, your topic report, and the learner understanding level.',
        icon: CheckCircle2,
        routeLabel: 'Overview',
        steps: [
          'Enter the topic name exactly as you want it tracked.',
          'Write a short topic report that describes performance and corrections.',
          'Choose the understanding level honestly so future work difficulty stays realistic.',
        ],
      },
      {
        id: 'papers',
        title: 'Use past papers to support practice',
        description: 'The platform uses available past paper data to support exercise planning for the student.',
        icon: BookOpen,
        routeLabel: 'Past papers',
        steps: [
          'Review available past papers relevant to the learner grade and region.',
          'Upload additional papers when they are needed for future exercise selection.',
          'Keep paper information complete so it can be used confidently later.',
        ],
      },
      {
        id: 'generation',
        title: 'Support the weekly learning cycle',
        description: 'When payment and paper requirements are in place, completed topics help the app prepare ongoing exercise work for the learner.',
        icon: Sparkles,
        routeLabel: 'Overview',
        steps: [
          'After saving the completed lesson, review the status message on the dashboard.',
          'If weekly work does not generate yet, check learner payment and matching papers.',
          'Continue updating lessons so the learner stays on a structured Maths path.',
        ],
      },
      {
        id: 'student-view',
        title: 'Understand the learner experience',
        description: 'Knowing the student journey helps tutors give better direction and reduce confusion.',
        icon: Image,
        routeLabel: 'Reports / Students',
        steps: [
          'Remind the learner that only today\'s exercise can be completed.',
          'Check that they upload a readable image of written Maths working.',
          'Use reports and topic notes to coach them toward the next step.',
        ],
      },
    ],
    quizTitle: 'Tutor readiness check',
    quizDescription: 'Answer all questions to confirm you understand how to use Examifying as a tutor.',
    questions: [
      {
        id: 'tutor-q1',
        prompt: 'What should a tutor do before managing reports and lessons for a learner?',
        options: [
          { id: 'a', text: 'Assign the student to themselves first.', correct: true },
          { id: 'b', text: 'Wait for the student to submit three exercises.', correct: false },
          { id: 'c', text: 'Change the learner profile role.', correct: false },
        ],
      },
      {
        id: 'tutor-q2',
        prompt: 'What information should be recorded when a lesson topic is completed?',
        options: [
          { id: 'a', text: 'Topic, topic report, and understanding level.', correct: true },
          { id: 'b', text: 'Only the learner name.', correct: false },
          { id: 'c', text: 'Only the next payment date.', correct: false },
        ],
      },
      {
        id: 'tutor-q3',
        prompt: 'Why should tutors keep reports and topic notes clear?',
        options: [
          { id: 'a', text: 'Because they help shape future exercise planning and support.', correct: true },
          { id: 'b', text: 'Because they replace the need for a student profile.', correct: false },
          { id: 'c', text: 'Because they automatically mark peer reviews.', correct: false },
        ],
      },
      {
        id: 'tutor-q4',
        prompt: 'What should a tutor check if weekly work does not generate after a lesson is saved?',
        options: [
          { id: 'a', text: 'The learner payment status and matching past papers.', correct: true },
          { id: 'b', text: 'Whether the admin has deleted the dashboard title.', correct: false },
          { id: 'c', text: 'Whether the student changed their password.', correct: false },
        ],
      },
    ],
  },
  teacher: {
    heroTitle: 'Learn the Examifying teacher workflow',
    heroDescription:
      'Teachers manage the student learning path by assigning learners, creating reports, recording completed topics, and keeping the weekly exercise pipeline moving.',
    quickTips: [
      'Assign a student before trying to manage their lesson journey.',
      'Create the first report so the learner has proper learning context.',
      'Record completed topics with an understanding level after each lesson.',
      'Keep notes clear because they shape future exercise planning.',
    ],
    sections: [
      {
        id: 'assign',
        title: 'Assign students to yourself',
        description: 'The teacher dashboard shows assigned and unassigned learners so you can claim and manage your student list.',
        icon: Users,
        routeLabel: 'Overview / Students',
        steps: [
          'Open the Students area or teacher overview to see available learners.',
          'Assign a student so they are linked to you as their Maths teacher.',
          'Open the learner card to continue with reports and topic tracking.',
        ],
      },
      {
        id: 'report',
        title: 'Write the initial learner report',
        description: 'The initial report gives context on the learner’s current ability and becomes part of the planning history.',
        icon: FileText,
        routeLabel: 'Overview',
        steps: [
          'Select the learner from your assigned list.',
          'Write the first report clearly with strengths, concerns, and next focus areas.',
          'Save the report before moving into later lesson updates.',
        ],
      },
      {
        id: 'lessons',
        title: 'Mark completed topics after teaching',
        description: 'Each completed lesson should record the topic taught, your topic report, and the learner understanding level.',
        icon: CheckCircle2,
        routeLabel: 'Overview',
        steps: [
          'Enter the topic name exactly as you want it tracked.',
          'Write a short topic report that describes performance and corrections.',
          'Choose the understanding level honestly so future work difficulty stays realistic.',
        ],
      },
      {
        id: 'papers',
        title: 'Use past papers to support practice',
        description: 'The platform uses available past paper data to support exercise planning for the student.',
        icon: BookOpen,
        routeLabel: 'Past papers',
        steps: [
          'Review available past papers relevant to the learner grade and region.',
          'Upload additional papers when they are needed for future exercise selection.',
          'Keep paper information complete so it can be used confidently later.',
        ],
      },
      {
        id: 'generation',
        title: 'Support the weekly learning cycle',
        description: 'When payment and paper requirements are in place, completed topics help the app prepare ongoing exercise work for the learner.',
        icon: Sparkles,
        routeLabel: 'Overview',
        steps: [
          'After saving the completed lesson, review the status message on the dashboard.',
          'If weekly work does not generate yet, check learner payment and matching papers.',
          'Continue updating lessons so the learner stays on a structured Maths path.',
        ],
      },
      {
        id: 'student-view',
        title: 'Understand the learner experience',
        description: 'Knowing the student journey helps teachers give better direction and reduce confusion.',
        icon: Image,
        routeLabel: 'Reports / Students',
        steps: [
          'Remind the learner that only today\'s exercise can be completed.',
          'Check that they upload a readable image of written Maths working.',
          'Use reports and topic notes to coach them toward the next step.',
        ],
      },
    ],
    quizTitle: 'Teacher readiness check',
    quizDescription: 'Answer all questions to confirm you understand how to use Examifying as a teacher.',
    questions: [
      {
        id: 'teacher-q1',
        prompt: 'What should a teacher do before managing reports and lessons for a learner?',
        options: [
          { id: 'a', text: 'Assign the student to themselves first.', correct: true },
          { id: 'b', text: 'Wait for the student to submit three exercises.', correct: false },
          { id: 'c', text: 'Change the learner profile role.', correct: false },
        ],
      },
      {
        id: 'teacher-q2',
        prompt: 'What information should be recorded when a lesson topic is completed?',
        options: [
          { id: 'a', text: 'Topic, topic report, and understanding level.', correct: true },
          { id: 'b', text: 'Only the learner name.', correct: false },
          { id: 'c', text: 'Only the next payment date.', correct: false },
        ],
      },
      {
        id: 'teacher-q3',
        prompt: 'Why should teachers keep reports and topic notes clear?',
        options: [
          { id: 'a', text: 'Because they help shape future exercise planning and support.', correct: true },
          { id: 'b', text: 'Because they replace the need for a student profile.', correct: false },
          { id: 'c', text: 'Because they automatically mark peer reviews.', correct: false },
        ],
      },
      {
        id: 'teacher-q4',
        prompt: 'What should a teacher check if weekly work does not generate after a lesson is saved?',
        options: [
          { id: 'a', text: 'The learner payment status and matching past papers.', correct: true },
          { id: 'b', text: 'Whether the admin has deleted the dashboard title.', correct: false },
          { id: 'c', text: 'Whether the student changed their password.', correct: false },
        ],
      },
    ],
  },
};
