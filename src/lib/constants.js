import { CAPS_SUBJECTS } from '../data/capsTopicCatalog.js';

export const ROLES = {
  STUDENT: 'student',
  TUTOR: 'tutor',
  ADMIN: 'admin',
  PARENT: 'parent',
};

export const DEFAULT_SUBJECT = 'Mathematics';

export const SUBJECTS = CAPS_SUBJECTS;

export const SUBJECT = DEFAULT_SUBJECT;

export const SOUTH_AFRICAN_GRADES = [
  'Select Grade',
  'Grade 4',
  'Grade 5',
  'Grade 6',
  'Grade 7',
  'Grade 8',
  'Grade 9',
  'Grade 10',
  'Grade 11',
  'Grade 12',
];

export const PAPER_MONTHS = ['March', 'June', 'September', 'December'];

export const PAPER_NUMBERS = ['Paper 1', 'Paper 2', 'Paper 3', 'Paper 4', 'Examplar'];

export const REGIONS = [
  'National',
  'Eastern Cape',
  'Free State',
  'Gauteng',
  'KwaZulu-Natal',
  'Limpopo',
  'Mpumalanga',
  'North West',
  'Northern Cape',
  'Western Cape',
];

export const MAX_EXERCISES_PER_DATE = 1;
export const MAX_QUESTIONS_PER_EXERCISE = 7;
export const MAX_DAILY_EXERCISES = MAX_EXERCISES_PER_DATE;
export const WEEKLY_EXERCISE_DAYS = 7;
export const MAX_EXERCISE_GENERATION_DAYS = 30;
export const TOPICS_PER_EXERCISE_WINDOW_STEP = 3;
export const MARKED_TOPIC_MIN_GENERATION_SCORE = 0.7;
export const MARKED_TOPIC_SUGGESTIONS_PER_SEVEN_EXERCISES = 2;
export const MIN_AI_SOURCE_PAPERS = 2;

export const APP_VERSION = '1.0.0';
