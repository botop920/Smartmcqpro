import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { extractQuestions, generateQuestionsFromSlides, generateStudyNotes, generateWrittenQuestions, fileToGenerativePart } from './services/geminiService';
import { Question, AppStep, QuizResult, NoteSection, WrittenQuestion, ExamType } from './types';
import AIChat from './components/AIChat';
import { UploadIcon, BookOpenIcon, ClockIcon, SparklesIcon, HeartIcon, NoteIcon, DownloadIcon, PencilIcon } from './components/Icons';

type UploadMode = 'extract' | 'generate' | 'notes' | 'written';

function App() {
  const [step, setStep] = useState<AppStep>(AppStep.UPLOAD);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [notes, setNotes] = useState<NoteSection[]>([]);
  const [writtenQuestions, setWrittenQuestions] = useState<WrittenQuestion[]>([]);
  const [uploadMode, setUploadMode] = useState<UploadMode>('extract');
  const [examType, setExamType] = useState<ExamType>('varsity');
  
  // Exam State
  const [currentQIndex, setCurrentQIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, string>>({});
  const [answerTimes, setAnswerTimes] = useState<Record<number, number>>({});
  const [timeSpent, setTimeSpent] = useState(0); 
  const [showExplanation, setShowExplanation] = useState(false);
  const [userNotes, setUserNotes] = useState<Record<number, string>>({});
  const [showNoteInput, setShowNoteInput] = useState(false);
  
  // Global Time Tracking
  const [examStartTime, setExamStartTime] = useState<number | null>(null);
  const [totalExamDuration, setTotalExamDuration] = useState<number>(0);

  // Processing State
  const [isProcessing, setIsProcessing] = useState(false); 
  const [isBackgroundExtracting, setIsBackgroundExtracting] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  
  // Favorites State
  const [favorites, setFavorites] = useState<Set<number>>(new Set());

  // Written View State
  const [visibleAnswers, setVisibleAnswers] = useState<Set<number>>(new Set());

  const timerRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setQuestions([]);
    setNotes([]);
    setWrittenQuestions([]);
    setFavorites(new Set());
    setVisibleAnswers(new Set());
    setUserNotes({});
    setIsProcessing(true);
    
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    
    let hasGeneratedData = false;

    try {
      setIsBackgroundExtracting(true);
      for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (controller.signal.aborted) break;
          const progress = files.length > 1 ? `(${i + 1}/${files.length})` : '';
          
          let statusText = "";
          if (uploadMode === 'notes') statusText = `${examType.toUpperCase()} নোটের জন্য ফাইল ${progress} বিশ্লেষণ করা হচ্ছে...`;
          else if (uploadMode === 'written') statusText = `${examType.toUpperCase()} লিখিত প্রশ্নের জন্য ফাইল ${progress} পড়া হচ্ছে...`;
          else if (uploadMode === 'extract') statusText = `ফাইল ${progress} থেকে প্রশ্ন খোঁজা হচ্ছে...`;
          else statusText = `${examType.toUpperCase()} স্ট্যান্ডার্ড MCQ তৈরি হচ্ছে ${progress}...`;
          
          setProcessingStatus(statusText);

          const base64 = await fileToGenerativePart(file);
          const fileData = { mimeType: file.type, data: base64 };

          if (uploadMode === 'notes') {
              await generateStudyNotes(fileData, (newBatch) => {
                  setNotes(prev => [...prev, ...newBatch]);
                  if (newBatch.length > 0) hasGeneratedData = true;
              }, controller.signal, examType);
          } else if (uploadMode === 'written') {
              await generateWrittenQuestions(fileData, (newBatch) => {
                  setWrittenQuestions(prev => [...prev, ...newBatch]);
                  if (newBatch.length > 0) hasGeneratedData = true;
              }, controller.signal, examType);
          } else {
              const onBatch = (batch: Question[]) => {
                  setQuestions(prev => [...prev, ...batch]);
                  if (batch.length > 0) hasGeneratedData = true;
              };
              if (uploadMode === 'extract') await extractQuestions(fileData, onBatch, controller.signal);
              else await generateQuestionsFromSlides(fileData, onBatch, controller.signal, examType);
          }
      }
      setIsBackgroundExtracting(false);
      setIsProcessing(false);
      
      // Only navigate if the user hasn't already manually started the quiz
      setStep(prevStep => {
          if (prevStep === AppStep.UPLOAD && hasGeneratedData) {
              if (uploadMode === 'notes') return AppStep.NOTES_VIEW;
              else if (uploadMode === 'written') return AppStep.WRITTEN_VIEW;
              else return AppStep.SETUP;
          }
          return prevStep;
      });
      
    } catch (err: any) {
      if (err.name !== 'AbortError') {
          setIsProcessing(false);
          setIsBackgroundExtracting(false);
          if (!hasGeneratedData) {
              alert(`ফাইল পড়তে সমস্যা হয়েছে।\nত্রুটি: ${err.message}`);
          }
      }
    }
  };

  useEffect(() => {
    if (step === AppStep.EXAM && questions[currentQIndex]) {
        const qId = questions[currentQIndex].id;
        setShowNoteInput(false); // Close note input when changing questions
        if (!userAnswers[qId]) {
            timerRef.current = window.setInterval(() => setTimeSpent(t => t + 1), 1000);
        }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [step, currentQIndex, userAnswers, questions]);

  const startQuizWhileExtracting = () => {
      // Do not abort extraction. Let it run in background.
      setIsProcessing(false);
      if (uploadMode === 'notes') setStep(AppStep.NOTES_VIEW);
      else if (uploadMode === 'written') setStep(AppStep.WRITTEN_VIEW);
      else setStep(AppStep.SETUP);
  };

  const startExam = () => {
    setCurrentQIndex(0); setUserAnswers({}); setAnswerTimes({}); setShowExplanation(false); setTimeSpent(0); setUserNotes({});
    setExamStartTime(Date.now()); setStep(AppStep.EXAM);
  };

  const submitExam = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (examStartTime) setTotalExamDuration(Math.floor((Date.now() - examStartTime) / 1000));
    setIsBackgroundExtracting(false); 
    if (abortControllerRef.current) abortControllerRef.current.abort(); // Stop extraction on finish
    setStep(AppStep.RESULTS);
  };

  const handleAnswerSelect = (qId: number, option: string) => {
    if (userAnswers[qId]) return;
    setAnswerTimes(prev => ({ ...prev, [qId]: timeSpent }));
    setUserAnswers(prev => ({ ...prev, [qId]: option }));
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const toggleFavorite = (id: number) => {
      setFavorites(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id); else next.add(id);
          return next;
      });
  };

  const formatDurationVerbose = (seconds: number) => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      if (mins === 0) return `${secs} সেকেন্ড`;
      return `${mins} মিনিট ${secs} সেকেন্ড`;
  };

  const handleDownloadPDF = (items: any[], title: string, type: 'questions' | 'notes' | 'written') => {
    if (items.length === 0) {
        alert("ডাউনলোড করার মতো কিছু নেই।");
        return;
    }
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    
    // Enrich items with user notes if applicable
    const itemsToPrint = items.map(item => ({
        ...item,
        userNote: type === 'questions' ? userNotes[item.id] : undefined
    }));
    
    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>${title}</title>
          <link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap" rel="stylesheet">
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
          <style>
            body { 
              font-family: 'Hind Siliguri', sans-serif; 
              padding: 40px; 
              color: #1e293b; 
              max-width: 900px; 
              margin: 0 auto; 
              line-height: 1.6;
            }
            .header { text-align: center; margin-bottom: 40px; border-bottom: 2px solid #f1f5f9; padding-bottom: 20px; }
            .header h1 { margin: 0; font-size: 28px; color: #0f172a; }
            .header p { margin: 5px 0 0; color: #64748b; font-size: 14px; }
            .card { border: 1px solid #e2e8f0; border-radius: 12px; padding: 25px; margin-bottom: 25px; page-break-inside: avoid; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
            .q-text { font-size: 19px; font-weight: 700; margin-bottom: 15px; color: #0f172a; display: block; }
            .option { margin-bottom: 8px; padding: 10px 15px; border-radius: 8px; border: 1px solid #f1f5f9; font-size: 16px; display: flex; align-items: center; }
            .correct { background: #f0fdf4; border: 1px solid #bbf7d0; font-weight: 700; color: #15803d; }
            .correct-marker { margin-right: 10px; font-weight: bold; }
            .importance-badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; text-transform: uppercase; font-weight: bold; margin-left: 10px; }
            .importance-High { background: #fee2e2; color: #dc2626; }
            .importance-Medium { background: #fef9c3; color: #a16207; }
            .importance-Normal { background: #e0f2fe; color: #0369a1; }
            .note-title { font-size: 20px; font-weight: 700; color: #dc2626; margin-bottom: 10px; display: flex; align-items: center; }
            .written-meta { font-size: 12px; font-weight: 700; text-transform: uppercase; color: #64748b; margin-bottom: 8px; display: block; }
            .answer-box { margin-top: 15px; padding: 15px; background: #f8fafc; border-left: 4px solid #dc2626; border-radius: 4px; font-size: 15px; }
            .answer-label { font-size: 11px; font-weight: 800; color: #dc2626; text-transform: uppercase; display: block; margin-bottom: 5px; }
            .user-note { margin-top: 15px; padding: 12px; background-color: #fefce8; border: 1px solid #fde047; border-radius: 8px; color: #854d0e; }
            .note-label { font-weight: 700; font-size: 12px; text-transform: uppercase; display: block; margin-bottom: 4px; color: #ca8a04; }
            .katex { font-size: 1.1em !important; }
            p { margin-bottom: 10px; }
          </style>
          <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
          <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
          <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
        </head>
        <body>
          <div class="header"><h1>${title}</h1><p>Smart MCQ Master - AI Admission Assistant</p></div>
          <div id="content"></div>
          <script>
            const items = ${JSON.stringify(itemsToPrint)};
            const type = "${type}";
            const container = document.getElementById('content');
            
            items.forEach((item, i) => {
              const card = document.createElement('div');
              card.className = 'card';
              
              if (type === 'questions') {
                card.innerHTML = \`<span class="q-text">Q\${i+1}. \${item.text}</span>\`;
                const optsDiv = document.createElement('div');
                item.options.forEach(opt => {
                  const isCorrect = opt === item.correctAnswer;
                  const optDiv = document.createElement('div');
                  optDiv.className = 'option' + (isCorrect ? ' correct' : '');
                  optDiv.innerHTML = \`<span class="correct-marker">\${isCorrect ? '✓ ' : '○ '}</span>\${opt}\`;
                  optsDiv.appendChild(optDiv);
                });
                card.appendChild(optsDiv);
                
                if (item.userNote) {
                    const noteDiv = document.createElement('div');
                    noteDiv.className = 'user-note';
                    noteDiv.innerHTML = \`<span class="note-label">My Note / Analysis:</span><div class="md-content">\${item.userNote}</div>\`;
                    card.appendChild(noteDiv);
                }

              } else if (type === 'notes') {
                card.innerHTML = \`
                  <div class="note-title">
                    \${item.title} 
                    <span class="importance-badge importance-\${item.importance}">\${item.importance} Priority</span>
                  </div>
                  <div class="md-content">\${item.content}</div>
                \`;
              } else if (type === 'written') {
                card.innerHTML = \`
                  <span class="written-meta">\${item.subject} • \${item.type} • \${item.marks} Marks</span>
                  <span class="q-text">Q\${i+1}. \${item.question}</span>
                  <div class="answer-box">
                    <span class="answer-label">Model Solution:</span>
                    <div class="md-content">\${item.answer}</div>
                  </div>
                \`;
              }
              container.appendChild(card);
            });

            window.onload = () => {
              // First render Markdown
              const mdTargets = document.querySelectorAll('.md-content');
              mdTargets.forEach(target => {
                target.innerHTML = marked.parse(target.textContent);
              });

              // Then render KaTeX Math
              renderMathInElement(document.body, {
                delimiters: [
                  {left: '$$', right: '$$', display: true},
                  {left: '$', right: '$', display: false},
                  {left: '\\\\(', right: '\\\\)', display: false},
                  {left: '\\\\[', right: '\\\\]', display: true}
                ],
                throwOnError: false
              });

              // Trigger print
              setTimeout(() => {
                window.print();
              }, 1000);
            };
          </script>
        </body>
      </html>
    `;
    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  const renderMathText = (text: string, isOption = false) => (
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]} components={{ p: ({node, ...props}) => isOption ? <span {...props} /> : <p {...props} /> }}>
        {text}
    </ReactMarkdown>
  );

  const renderUpload = () => (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-rose-400 mb-4 leading-tight">Smart MCQ Master</h1>
        <p className="text-secondary text-lg max-w-md mx-auto">AI এর সাহায্যে ভর্তি পরীক্ষার সর্বোচ্চ প্রস্তুতি নিন</p>
      </div>
      
      <div className="flex bg-neutral-900 p-1 rounded-xl mb-6 border border-neutral-800 flex-wrap justify-center gap-1">
          <button onClick={() => setUploadMode('extract')} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${uploadMode === 'extract' ? 'bg-red-600 text-white' : 'text-gray-400 hover:text-white'}`}>প্রশ্ন এক্সট্র্যাক্ট</button>
          <button onClick={() => setUploadMode('generate')} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${uploadMode === 'generate' ? 'bg-red-600 text-white' : 'text-gray-400 hover:text-white'}`}>MCQ তৈরি</button>
          <button onClick={() => setUploadMode('written')} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${uploadMode === 'written' ? 'bg-red-600 text-white' : 'text-gray-400 hover:text-white'}`}>লিখিত প্রশ্ন</button>
          <button onClick={() => setUploadMode('notes')} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${uploadMode === 'notes' ? 'bg-red-600 text-white' : 'text-gray-400 hover:text-white'}`}>শর্ট নোটস</button>
      </div>

      <div className="flex items-center gap-2 mb-8 bg-neutral-950 p-1.5 rounded-2xl border border-neutral-800">
          <button onClick={() => { setExamType('varsity'); if(uploadMode === 'written') setUploadMode('generate'); }} className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${examType === 'varsity' ? 'bg-white text-black' : 'text-gray-500 hover:text-gray-300'}`}>Varsity (DU/RU)</button>
          <button onClick={() => { setExamType('ckruet'); if(uploadMode === 'written') setUploadMode('generate'); }} className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${examType === 'ckruet' ? 'bg-white text-black' : 'text-gray-500 hover:text-gray-300'}`}>CKRUET (MCQ)</button>
          <button onClick={() => { setExamType('buet'); setUploadMode('written'); }} className={`px-5 py-2.5 rounded-xl text-sm font-bold transition-all ${examType === 'buet' ? 'bg-white text-black' : 'text-gray-500 hover:text-gray-300'}`}>BUET (Written)</button>
      </div>

      <div className="w-full max-w-md px-4 md:px-0">
        <label className={`flex flex-col items-center justify-center w-full h-64 border-2 border-dashed rounded-3xl cursor-pointer transition-all duration-300 relative overflow-hidden ${isProcessing ? 'border-red-500 bg-neutral-900' : 'border-neutral-700 hover:border-red-400 hover:bg-neutral-900'}`}>
          <div className="flex flex-col items-center justify-center pt-5 pb-6 z-10 w-full px-4">
             {isProcessing ? (
                <div className="flex flex-col items-center w-full">
                    <div className="w-12 h-12 border-4 border-red-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                    <p className="text-red-400 font-medium animate-pulse mb-4 text-center">{processingStatus}</p>
                    {questions.length > 0 && uploadMode !== 'notes' && uploadMode !== 'written' && (
                         <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); startQuizWhileExtracting(); }} className="mt-4 px-8 py-3 bg-red-600 text-white rounded-xl font-bold shadow-lg transform hover:scale-105 transition-all">কুইজ শুরু করুন ({questions.length})</button>
                    )}
                </div>
             ) : (
                <>
                    {uploadMode === 'notes' ? <NoteIcon /> : uploadMode === 'written' ? <SparklesIcon /> : <UploadIcon />}
                    <p className="mb-2 text-sm text-gray-400 mt-2 text-center"><span className="font-semibold text-white">PDF বা ছবি আপলোড করুন</span></p>
                </>
             )}
          </div>
          <input type="file" className="hidden" accept="application/pdf, image/*" multiple onChange={handleFileUpload} disabled={isProcessing} />
        </label>
      </div>
    </div>
  );

  const renderExam = () => {
    const q = questions[currentQIndex];
    if (!q) return null;
    const isAnswered = !!userAnswers[q.id];
    const hasNote = !!userNotes[q.id];

    return (
      <div className="max-w-4xl mx-auto w-full md:p-4 animate-fade-in">
        <div className="flex justify-between items-center mb-6 px-4 md:px-0">
            <div className="text-sm font-mono text-secondary">প্রশ্ন {currentQIndex + 1} / {questions.length}</div>
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full border ${isAnswered ? 'bg-red-900/30 border-red-500/30' : 'bg-neutral-900 border-neutral-800'}`}>
                <ClockIcon /> <span className="font-mono font-bold text-white">{isAnswered ? `${answerTimes[q.id]}s` : `${Math.floor(timeSpent/60)}:${(timeSpent%60).toString().padStart(2,'0')}`}</span>
            </div>
        </div>
        
        {/* Main Card Container - Full width and borderless on mobile */}
        <div className="md:bg-surface bg-transparent md:rounded-2xl md:p-10 p-0 md:shadow-2xl md:border md:border-neutral-800 border-0 w-full overflow-hidden">
            <div className="flex justify-between items-start gap-4 mb-8 px-4 md:px-0">
                <div className="text-xl md:text-2xl font-bold text-white leading-relaxed break-words max-w-full overflow-x-auto">{renderMathText(q.text)}</div>
                <div className="flex gap-2 flex-shrink-0">
                    <button onClick={() => setShowNoteInput(!showNoteInput)} className={`${showNoteInput || hasNote ? 'text-yellow-400 bg-yellow-500/10' : 'text-gray-500 hover:text-gray-300'} p-2 rounded-lg transition-all`}>
                        <PencilIcon filled={hasNote} />
                    </button>
                    <button onClick={() => toggleFavorite(q.id)} className="text-pink-500 p-2"><HeartIcon filled={favorites.has(q.id)} /></button>
                </div>
            </div>

            {showNoteInput && (
                <div className="mb-6 animate-fade-in px-4 md:px-0">
                    <textarea
                        value={userNotes[q.id] || ''}
                        onChange={(e) => setUserNotes(prev => ({...prev, [q.id]: e.target.value}))}
                        placeholder="আপনার নোট এখানে লিখুন (যেমন: কেন ভুল হলো, বা মনে রাখার টেকনিক)..."
                        className="w-full bg-neutral-900 border border-yellow-500/30 rounded-xl p-4 text-white focus:outline-none focus:border-yellow-500 focus:ring-1 focus:ring-yellow-500/50 min-h-[100px] placeholder-gray-600"
                    />
                </div>
            )}

            <div className="grid gap-3 px-2 md:px-0">
                {q.options.map((option, idx) => {
                    const isSelected = userAnswers[q.id] === option;
                    const isCorrect = option === q.correctAnswer;
                    let cls = "p-4 rounded-xl border-2 text-left transition-all flex items-start w-full overflow-hidden ";
                    if (isAnswered) cls += isCorrect ? "border-green-600 bg-green-900/20 text-green-100" : isSelected ? "border-red-600 bg-red-900/20 text-red-100" : "border-neutral-800 bg-neutral-900/50 opacity-60";
                    else cls += "border-neutral-800 bg-neutral-900/50 hover:border-red-500/50 hover:bg-neutral-800";
                    return (
                        <button key={idx} onClick={() => handleAnswerSelect(q.id, option)} disabled={isAnswered} className={cls}>
                            <span className="w-6 font-mono opacity-50 mr-2 flex-shrink-0">{String.fromCharCode(65 + idx)}.</span>
                            <span className="flex-1 min-w-0 break-words whitespace-normal text-sm md:text-base">{renderMathText(option, true)}</span>
                        </button>
                    );
                })}
            </div>
            <div className="mt-8 md:border-t md:border-neutral-800 pt-6 flex justify-between items-center px-4 md:px-0">
                <button onClick={() => { setCurrentQIndex(prev => prev - 1); setShowExplanation(false); setTimeSpent(0); }} disabled={currentQIndex === 0} className="px-6 py-2.5 rounded-xl bg-neutral-800 text-gray-300 disabled:opacity-0">পূর্ববর্তী</button>
                <button onClick={() => setShowExplanation(!showExplanation)} className="px-4 py-2 bg-red-500/10 text-red-400 rounded-lg text-sm font-bold flex items-center gap-2"><SparklesIcon /> {showExplanation ? 'টিউটর বন্ধ' : 'AI টিটিউটর'}</button>
                {currentQIndex < questions.length - 1 ? (
                    <button onClick={() => { setCurrentQIndex(prev => prev + 1); setShowExplanation(false); setTimeSpent(0); }} className="px-6 py-2.5 rounded-xl bg-white text-black font-bold">পরবর্তী</button>
                ) : (
                    <button onClick={submitExam} className="px-6 py-2.5 rounded-xl bg-green-600 text-white font-bold">শেষ করুন</button>
                )}
            </div>
            {showExplanation && <AIChat question={q} />}
        </div>
      </div>
    );
  };

  const renderResults = () => {
    const correctCount = questions.filter(q => userAnswers[q.id] === q.correctAnswer).length;
    const totalCount = questions.length;
    const percentage = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;

    return (
      <div className="max-w-4xl mx-auto w-full animate-fade-in md:p-6 p-0">
          <div className="md:bg-surface bg-transparent md:rounded-3xl md:p-12 p-4 text-center md:border md:border-neutral-800 md:shadow-2xl border-0 mb-8 w-full">
              <h2 className="text-3xl font-bold text-white mb-2">পরীক্ষা সম্পন্ন!</h2>
              <div className="flex items-center justify-center gap-2 text-secondary mb-8 bg-neutral-900/50 w-fit mx-auto px-4 py-1.5 rounded-full border border-neutral-800">
                  <ClockIcon /> <span className="font-mono text-sm">মোট সময়: {formatDurationVerbose(totalExamDuration)}</span>
              </div>
              
              <div className="flex justify-center items-center mb-8 relative">
                  <div className="w-40 h-40 rounded-full border-8 border-neutral-800 flex items-center justify-center relative">
                       <svg className="w-full h-full -rotate-90 absolute top-0 left-0" viewBox="0 0 100 100">
                           <circle cx="50" cy="50" r="46" fill="transparent" stroke="currentColor" strokeWidth="8" className="text-neutral-800"/>
                           <circle cx="50" cy="50" r="46" fill="transparent" stroke="currentColor" strokeWidth="8" strokeDasharray={289} strokeDashoffset={289 - (289 * percentage) / 100} className={percentage >= 80 ? 'text-green-500' : percentage >= 50 ? 'text-yellow-500' : 'text-red-500'} style={{ transition: 'stroke-dashoffset 1s ease-out' }}/>
                       </svg>
                       <div className="text-center"><span className="text-4xl font-bold text-white block">{correctCount}</span><span className="text-sm text-secondary">/{totalCount}</span></div>
                  </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4 max-w-sm mx-auto mb-8">
                   <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800"><div className="text-2xl font-bold text-green-400">{correctCount}</div><div className="text-xs text-secondary uppercase tracking-wider">সঠিক</div></div>
                   <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800"><div className="text-2xl font-bold text-red-400">{totalCount - correctCount}</div><div className="text-xs text-secondary uppercase tracking-wider">ভুল</div></div>
              </div>

              <div className="flex flex-wrap gap-4 justify-center">
                  <button onClick={() => setStep(AppStep.UPLOAD)} className="px-6 py-3 rounded-xl bg-neutral-800 text-white hover:bg-neutral-700 transition-colors font-medium">নতুন ফাইল আপলোড</button>
                  <button onClick={startExam} className="px-6 py-3 rounded-xl bg-red-600 text-white hover:bg-red-500 transition-colors font-bold shadow-lg shadow-red-500/20">পুনরায় পরীক্ষা</button>
                  <button onClick={() => handleDownloadPDF(questions, 'Full Exam Questions', 'questions')} className="px-6 py-3 rounded-xl bg-neutral-800 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/10 transition-colors font-bold flex items-center gap-2">
                     <DownloadIcon /> প্রশ্ন ডাউনলোড
                  </button>
              </div>
          </div>
          
          {favorites.size > 0 && (
              <div className="text-center mb-12">
                  <button onClick={() => handleDownloadPDF(questions.filter(q => favorites.has(q.id)), 'Favorite Questions', 'questions')} className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-pink-500/10 text-pink-500 border border-pink-500/20 hover:bg-pink-500/20 transition-all">
                      <HeartIcon filled={true} /> {favorites.size} টি প্রিয় প্রশ্ন ডাউনলোড
                  </button>
              </div>
          )}
      </div>
    );
  };

  const renderNotesView = () => (
    <div className="max-w-4xl mx-auto w-full md:p-4 p-0 md:space-y-6 space-y-0 animate-fade-in">
        <div className="flex justify-between items-center mb-6 px-4 pt-4 md:px-0">
            <h2 className="text-2xl font-bold text-white flex items-center gap-3"><NoteIcon /> {examType.toUpperCase()} শর্ট নোটস</h2>
            <button onClick={() => handleDownloadPDF(notes, `${examType.toUpperCase()} Study Notes`, 'notes')} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2 text-sm font-bold"><DownloadIcon /> ডাউনলোড</button>
        </div>
        {notes.map(n => (
            <div key={n.id} className="md:bg-surface bg-transparent md:p-6 p-5 md:rounded-2xl md:border md:border-neutral-800 border-b border-neutral-900 md:shadow-xl shadow-none">
                <div className="flex justify-between items-center mb-4 pb-3 border-b border-neutral-800/50">
                    <h3 className="text-xl font-bold text-red-400">{n.title}</h3>
                    <span className="px-3 py-1 bg-red-500/10 text-red-400 text-xs font-bold rounded-full">{n.importance} Priority</span>
                </div>
                <div className="prose prose-invert max-w-none text-gray-300"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{n.content}</ReactMarkdown></div>
            </div>
        ))}
        <div className="text-center mt-10 pb-10"><button onClick={() => setStep(AppStep.UPLOAD)} className="px-6 py-3 bg-neutral-800 rounded-xl">নতুন ফাইল</button></div>
    </div>
  );

  const renderWrittenView = () => {
    return (
      <div className="max-w-4xl mx-auto w-full md:p-4 p-0 animate-fade-in">
          <div className="flex justify-between items-center mb-8 px-4 pt-4 md:px-0">
              <h2 className="text-2xl font-bold text-white flex items-center gap-3"><SparklesIcon /> {examType === 'buet' ? 'BUET লিখিত প্রস্তুতি' : 'ইঞ্জিনিয়ারিং লিখিত প্রশ্ন'}</h2>
              <button onClick={() => handleDownloadPDF(writtenQuestions, `${examType.toUpperCase()} Written Prep`, 'written')} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2 text-sm font-bold"><DownloadIcon /> ডাউনলোড</button>
          </div>
          <div className="md:space-y-6 space-y-0">
              {writtenQuestions.map((item, idx) => (
                  <div key={item.id} className="md:bg-surface bg-transparent md:rounded-2xl md:border md:border-neutral-800 border-b border-neutral-900 md:shadow-xl shadow-none overflow-hidden">
                      <div className="md:p-6 p-5">
                          <div className="flex justify-between items-start mb-4">
                              <span className="bg-neutral-900 text-red-400 text-xs font-bold px-3 py-1 rounded-full uppercase">{item.subject} • {item.type}</span>
                              <span className="text-sm font-bold text-gray-400">{item.marks} Marks</span>
                          </div>
                          <div className="text-xl font-bold text-white mb-6 leading-relaxed break-words">{renderMathText(item.question)}</div>
                          <button onClick={() => setVisibleAnswers(prev => { const n = new Set(prev); if(n.has(item.id)) n.delete(item.id); else n.add(item.id); return n; })} className="w-full py-3 bg-neutral-900 border border-neutral-800 rounded-xl text-sm font-bold text-gray-300">{visibleAnswers.has(item.id) ? 'উত্তর লুকান' : 'মডেল সমাধান দেখুন'}</button>
                      </div>
                      {visibleAnswers.has(item.id) && (
                          <div className="bg-neutral-900/50 p-6 border-t border-neutral-800 border-l-4 border-l-red-600">
                              <h4 className="text-sm font-bold text-red-400 mb-3 uppercase">ধাপে ধাপে সমাধান:</h4>
                              <div className="text-gray-300 prose prose-invert max-w-none"><ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{item.answer}</ReactMarkdown></div>
                          </div>
                      )}
                  </div>
              ))}
          </div>
          <div className="text-center mt-10 pb-10"><button onClick={() => setStep(AppStep.UPLOAD)} className="px-6 py-3 bg-neutral-800 rounded-xl">নতুন ফাইল</button></div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-black text-gray-100 font-sans">
      <div className="container mx-auto md:px-4 py-4 md:py-8">
        {step !== AppStep.UPLOAD && (
            <div className="flex items-center justify-between mb-8 px-4 md:px-0 animate-fade-in">
                <div className="font-bold text-xl text-white cursor-pointer" onClick={() => setStep(AppStep.UPLOAD)}>Smart MCQ <span className="text-red-500">Master</span></div>
                {isBackgroundExtracting && (
                    <div className="flex items-center gap-2 text-xs text-red-400 animate-pulse bg-red-500/10 px-3 py-1 rounded-full border border-red-500/20">
                         <div className="w-2 h-2 bg-red-500 rounded-full animate-ping" />
                         আরো প্রশ্ন খোঁজা হচ্ছে...
                    </div>
                )}
            </div>
        )}
        <main className="flex flex-col items-center w-full">
            {step === AppStep.UPLOAD && renderUpload()}
            {step === AppStep.SETUP && (
                <div className="flex flex-col items-center justify-center min-h-[50vh] animate-fade-in p-4">
                  <div className="md:bg-surface bg-transparent md:p-8 p-4 md:rounded-3xl md:shadow-2xl w-full max-w-lg md:border md:border-neutral-800 border-0 text-center">
                    <h2 className="text-3xl font-bold mb-4 text-white">{examType.toUpperCase()} স্ট্যান্ডার্ড প্রশ্ন তৈরি</h2>
                    <div className="flex flex-col items-center justify-center mb-8 bg-neutral-900 rounded-2xl p-6 border border-neutral-800 w-full">
                        <p className="text-secondary text-sm mb-2">রেডি প্রশ্ন</p>
                        <p className="text-5xl font-bold text-white">{questions.length}</p>
                    </div>
                    <button onClick={startExam} className="w-full bg-red-600 hover:bg-red-500 text-white font-bold py-4 rounded-xl shadow-lg transition-all transform hover:scale-[1.02]">পরীক্ষা শুরু করুন</button>
                  </div>
                </div>
            )}
            {step === AppStep.EXAM && renderExam()}
            {step === AppStep.RESULTS && renderResults()}
            {step === AppStep.NOTES_VIEW && renderNotesView()}
            {step === AppStep.WRITTEN_VIEW && renderWrittenView()}
        </main>
      </div>
    </div>
  );
}

export default App;