export interface Question {
  id: number;
  text: string;
  options: string[];
  correctAnswer: string; // The text of the correct option
}

export interface WrittenQuestion {
  id: number;
  subject: string; // e.g. "Physics", "Chemistry", "Higher Math"
  question: string;
  answer: string;
  marks: string; // e.g. "2.5", "5", "10"
  type: 'Theory' | 'Math' | 'Short Note';
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
  isStreaming?: boolean;
}

export interface NoteSection {
  id: number;
  title: string;
  content: string; // Markdown text
  importance: 'High' | 'Medium' | 'Normal';
}

export enum AppStep {
  UPLOAD = 'UPLOAD',
  SETUP = 'SETUP',
  EXAM = 'EXAM',
  RESULTS = 'RESULTS',
  NOTES_VIEW = 'NOTES_VIEW',
  WRITTEN_VIEW = 'WRITTEN_VIEW'
}

export interface QuizResult {
  score: number;
  total: number;
  answers: Record<number, string>; // questionId -> selectedOptionText
}