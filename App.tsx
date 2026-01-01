import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { extractQuestions, generateQuestionsFromSlides, generateStudyNotes, generateWrittenQuestions, fileToGenerativePart } from './services/geminiService';
import { Question, AppStep, QuizResult, NoteSection, WrittenQuestion } from './types';
import AIChat from './components/AIChat';
import { UploadIcon, BookOpenIcon, ClockIcon, SparklesIcon, HeartIcon, NoteIcon, DownloadIcon } from './components/Icons';

type UploadMode = 'extract' | 'generate' | 'notes' | 'written';

function App() {
  const [step, setStep] = useState<AppStep>(AppStep.UPLOAD);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [notes, setNotes] = useState<NoteSection[]>([]);
  const [writtenQuestions, setWrittenQuestions] = useState<WrittenQuestion[]>([]);
  const [uploadMode, setUploadMode] = useState<UploadMode>('extract');
  const [isVarsityMode, setIsVarsityMode] = useState(false);
  
  // Exam State
  const [currentQIndex, setCurrentQIndex] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, string>>({});
  const [answerTimes, setAnswerTimes] = useState<Record<number, number>>({});
  const [timeSpent, setTimeSpent] = useState(0); // Current question timer
  const [showExplanation, setShowExplanation] = useState(false);
  
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

  // --- Handlers ---

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Validate all files
    for (let i = 0; i < files.length; i++) {
        const type = files[i].type;
        const validTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
        if (!validTypes.includes(type)) {
             alert(`File "${files[i].name}" সমর্থিত নয়। অনুগ্রহ করে PDF বা ছবি (JPG, PNG, WEBP, HEIC) আপলোড করুন।`);
             return;
        }
    }

    // Reset State
    setQuestions([]);
    setNotes([]);
    setWrittenQuestions([]);
    setFavorites(new Set());
    setVisibleAnswers(new Set());
    
    setIsProcessing(true);
    
    // Setup Abort Controller
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    
    try {
      setIsBackgroundExtracting(true);
      
      // Iterate through all uploaded files
      for (let i = 0; i < files.length; i++) {
          const file = files[i];
          
          // Check if aborted before starting next file
          if (controller.signal.aborted) break;

          // Update status message
          const fileProgress = files.length > 1 ? `(${i + 1}/${files.length})` : '';
          
          if (uploadMode === 'notes') {
              setProcessingStatus(isVarsityMode 
                  ? `DU ভর্তি নোটের জন্য ফাইল ${fileProgress} বিশ্লেষণ করা হচ্ছে...` 
                  : `ইঞ্জিনিয়ারিং নোটের জন্য ফাইল ${fileProgress} বিশ্লেষণ করা হচ্ছে...`);
          } else if (uploadMode === 'written') {
              setProcessingStatus(`ফাইল ${fileProgress} থেকে লিখিত প্রশ্ন তৈরি করা হচ্ছে...`);
          } else if (uploadMode === 'extract') {
              setProcessingStatus(`ফাইল ${fileProgress} পড়া হচ্ছে: ${file.name}...`);
          } else {
              setProcessingStatus(isVarsityMode
                  ? `ফাইল ${fileProgress} থেকে ভার্সিটি স্ট্যান্ডার্ড MCQ তৈরি করা হচ্ছে...`
                  : `ফাইল ${fileProgress} থেকে ইঞ্জিনিয়ারিং স্ট্যান্ডার্ড MCQ তৈরি করা হচ্ছে...`
              );
          }

          const base64 = await fileToGenerativePart(file);
          const fileData = { mimeType: file.type, data: base64 };

          // -- Mode: Notes --
          if (uploadMode === 'notes') {
              await generateStudyNotes(fileData, (newNotes) => {
                  setNotes(prev => [...prev, ...newNotes]);
              }, controller.signal, isVarsityMode);
          }
          // -- Mode: Written --
          else if (uploadMode === 'written') {
              await generateWrittenQuestions(fileData, (newWQs) => {
                  setWrittenQuestions(prev => [...prev, ...newWQs]);
              }, controller.signal);
          }
          // -- Mode: MCQs (Extract or Generate) --
          else {
              const onBatch = (newBatch: Question[]) => {
                  setQuestions(prev => [...prev, ...newBatch]);
              };

              const processPromise = uploadMode === 'extract'
                ? extractQuestions(fileData, onBatch, controller.signal)
                : generateQuestionsFromSlides(fileData, onBatch, controller.signal, isVarsityMode);
              
              await processPromise;
          }
      }

      // All files processed
      setIsBackgroundExtracting(false);
      setIsProcessing(false);

      if (uploadMode === 'notes') {
          setStep(AppStep.NOTES_VIEW);
      } else if (uploadMode === 'written') {
          setStep(AppStep.WRITTEN_VIEW);
      } else {
          setStep(current => {
              if (current === AppStep.UPLOAD) return AppStep.SETUP;
              return current;
          });
      }

    } catch (err: any) {
      console.error(err);
      setIsProcessing(false);
      setIsBackgroundExtracting(false);
      
      // If we have some content, don't show error immediately, just stop.
      // But if we have NOTHING, show the error.
      if (questions.length === 0 && notes.length === 0 && writtenQuestions.length === 0) {
          const errorMessage = err.message || "অজানা সমস্যা হয়েছে";
          alert(`ফাইল পড়তে সমস্যা হয়েছে।\nত্রুটি: ${errorMessage}`);
      }
    }
  };

  // Monitor Questions Count for "Fast Start" (Only for MCQ modes)
  useEffect(() => {
      if (uploadMode === 'notes' || uploadMode === 'written') return;
      const threshold = uploadMode === 'extract' ? 20 : 5;
      if (step === AppStep.UPLOAD && questions.length >= threshold) {
          setIsProcessing(false); 
          setStep(AppStep.SETUP);
      }
  }, [questions.length, step, uploadMode]);

  useEffect(() => {
      return () => {
          if (abortControllerRef.current) abortControllerRef.current.abort();
      };
  }, []);

  // Timer Effect
  useEffect(() => {
    if (step === AppStep.EXAM && questions[currentQIndex]) {
        const qId = questions[currentQIndex].id;
        // Only run timer if not answered
        if (!userAnswers[qId]) {
            timerRef.current = window.setInterval(() => {
                setTimeSpent(t => t + 1);
            }, 1000);
        }
    }
    return () => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
    };
  }, [step, currentQIndex, userAnswers, questions]);

  const stopExtractionAndStart = () => {
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
      }
      setIsProcessing(false);
      setIsBackgroundExtracting(false);
      
      if (uploadMode === 'notes') {
          if (notes.length > 0) setStep(AppStep.NOTES_VIEW);
          else setStep(AppStep.UPLOAD);
      } else if (uploadMode === 'written') {
          if (writtenQuestions.length > 0) setStep(AppStep.WRITTEN_VIEW);
          else setStep(AppStep.UPLOAD);
      } else {
          if (questions.length > 0) setStep(AppStep.SETUP);
          else setStep(AppStep.UPLOAD);
      }
  };

  const startExam = () => {
    setCurrentQIndex(0);
    setUserAnswers({});
    setAnswerTimes({});
    setShowExplanation(false);
    setTimeSpent(0);
    setExamStartTime(Date.now()); 
    setStep(AppStep.EXAM);
  };

  const submitExam = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (examStartTime) {
        const durationSec = Math.floor((Date.now() - examStartTime) / 1000);
        setTotalExamDuration(durationSec);
    }
    if (isBackgroundExtracting && abortControllerRef.current) {
        abortControllerRef.current.abort();
        setIsBackgroundExtracting(false);
    }
    setStep(AppStep.RESULTS);
  };

  const handleAnswerSelect = (qId: number, option: string) => {
    if (userAnswers[qId]) return;
    const taken = timeSpent;
    setAnswerTimes(prev => ({ ...prev, [qId]: taken }));
    setUserAnswers(prev => ({ ...prev, [qId]: option }));
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const toggleFavorite = (qId: number) => {
      setFavorites(prev => {
          const newSet = new Set(prev);
          if (newSet.has(qId)) newSet.delete(qId);
          else newSet.add(qId);
          return newSet;
      });
  };

  const toggleWrittenAnswer = (id: number) => {
      setVisibleAnswers(prev => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
      });
  };

  const goToQuestion = (index: number) => {
      if (index >= 0 && index < questions.length) {
          setCurrentQIndex(index);
          setShowExplanation(false);
          setTimeSpent(0);
      }
  };

  // Helper to process markdown content
  const processMarkdownContent = (content: string) => {
      return content.replace(/(\*\*(?:Core Concept|Definitions|All Formulas|Chemical Reactions|Graphs|Problem Solving|Comparative Tables|PYQ Context|High-Yield MCQ Triggers|Concise Written Prep|Reaction Bank|Quick Mnemonics|Numerical Logic|Topic Importance|Conceptual MCQ Triggers|Concise Written\/Mechanism Prep|Formula & Identity Bank|Calculator-Free Numerical Logic|Mnemonics & Mnemonics \(Bengali\)|Graph & Diagram Analysis|Priority Tagging|কনসেপচুয়াল MCQ ট্রিক্স|লিখিত অংশের মূল থিওরি|ফর্মুলা ও শর্টকাট ব্যাংক|হাতে-কলমে ক্যালকুলেশন|মনে রাখার ছন্দ|গ্রাফ ও চিত্র বিশ্লেষণ|সতর্কতা ও গুরুত্ব))/g, '\n\n$1');
  };

  // Generic PDF Download Handler
  const handleDownloadPDF = (items: any[], title: string, type: 'questions' | 'notes' | 'written') => {
    if (items.length === 0) {
        alert("ডাউনলোড করার মতো কিছু নেই।");
        return;
    }
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    
    const isNotes = type === 'notes';

    const styles = `
      <style>
        body { 
            font-family: 'Hind Siliguri', sans-serif; 
            padding: ${isNotes ? '20px' : '40px'}; 
            color: #1e293b; 
            max-width: 800px; 
            margin: 0 auto; 
        }
        .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; }
        .header h1 { font-size: 24px; font-weight: bold; margin: 0; }
        .header p { color: #64748b; margin-top: 5px; font-size: 14px; }
        
        .section-header { 
            font-size: 20px; font-weight: 700; color: #dc2626; 
            margin-top: 30px; margin-bottom: 15px; border-bottom: 2px solid #e2e8f0; 
            padding-bottom: 5px; text-transform: uppercase; letter-spacing: 0.05em;
        }

        .card { 
            border: 1px solid #e2e8f0; 
            border-radius: 8px; 
            padding: 20px; 
            margin-bottom: 20px; 
            background-color: #fff; 
            page-break-inside: avoid;
            break-inside: avoid;
        }
        
        /* MCQ Styles */
        .q-text { font-size: 18px; font-weight: 600; margin-bottom: 15px; color: #0f172a; }
        .options { margin-left: 10px; }
        .option { margin-bottom: 8px; padding: 8px 12px; border-radius: 6px; background: white; border: 1px solid #e2e8f0; }
        .correct { color: #15803d; font-weight: bold; border-color: #bbf7d0; background-color: #f0fdf4; }
        
        /* Written Styles */
        .written-q { font-size: 18px; font-weight: 700; color: #1e293b; margin-bottom: 10px; }
        .written-meta { font-size: 12px; color: #64748b; margin-bottom: 15px; text-transform: uppercase; font-weight: 600; }
        .written-answer { 
            margin-top: 15px; 
            padding: 15px; 
            background-color: #f8fafc; 
            border-left: 4px solid #dc2626; 
            border-radius: 4px;
        }
        .answer-label { font-size: 12px; font-weight: bold; color: #dc2626; margin-bottom: 5px; display: block; }
        
        /* Note Styles */
        .note-title { 
            font-size: 20px; font-weight: 700; color: #dc2626; 
            margin-bottom: 8px; border-bottom: 1px solid #f1f5f9; padding-bottom: 5px;
        }
        .badge { font-size: 10px; padding: 2px 6px; border-radius: 9999px; color: white; text-transform: uppercase; display: inline-block; vertical-align: middle; margin-left: 10px; }
        .badge-High { background-color: #ef4444; }
        .badge-Medium { background-color: #eab308; }
        .badge-Normal { background-color: #3b82f6; }
        
        .markdown p { margin-bottom: 8px; line-height: 1.6; font-size: 14px; }
        .markdown ul { list-style: disc; margin-left: 20px; margin-bottom: 8px; }
        .katex { font-size: 1.1em; }
      </style>
    `;

    // Grouping Logic for PDF
    let finalDataToRender: any[] = [];

    if (type === 'written') {
        // Sort/Group Written questions by Subject
        const grouped: Record<string, WrittenQuestion[]> = {};
        items.forEach((item: WrittenQuestion) => {
            const sub = item.subject || "General";
            if (!grouped[sub]) grouped[sub] = [];
            grouped[sub].push(item);
        });

        // Flatten with Headers
        Object.keys(grouped).forEach(subject => {
            finalDataToRender.push({ type: 'header', text: subject });
            grouped[subject].forEach((w, i) => {
                finalDataToRender.push({
                    type: 'written',
                    index: i + 1,
                    question: w.question,
                    answer: w.answer,
                    marks: w.marks,
                    qType: w.type
                });
            });
        });

    } else {
        // Standard non-grouped rendering for Notes/MCQs
        finalDataToRender = items.map((item, i) => {
            if (type === 'questions') {
                const q = item as Question;
                return {
                    type: 'question',
                    index: i + 1,
                    text: q.text,
                    options: q.options,
                    correctAnswer: q.correctAnswer
                };
            } else {
                const n = item as NoteSection;
                return {
                    type: 'note',
                    title: n.title,
                    importance: n.importance,
                    content: processMarkdownContent(n.content)
                };
            }
        });
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>${title}</title>
          <link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@300;400;500;600;700&display=swap" rel="stylesheet">
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
          ${styles}
          <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
          <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
          <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
        </head>
        <body>
          <div class="header"><h1>${title}</h1><p>স্মার্ট MCQ মাস্টার - AI জেনারেটেড কন্টেন্ট</p></div>
          <div id="content-area">লোড হচ্ছে...</div>

          <script>
             const data = ${JSON.stringify(finalDataToRender)};
             
             window.onload = function() {
                 const container = document.getElementById('content-area');
                 container.innerHTML = '';

                 data.forEach(item => {
                     if (item.type === 'header') {
                         const header = document.createElement('div');
                         header.className = 'section-header';
                         header.textContent = item.text;
                         container.appendChild(header);
                         return;
                     }

                     const card = document.createElement('div');
                     card.className = 'card';
                     
                     if (item.type === 'question') {
                         let optionsHtml = '<div class="options">';
                         item.options.forEach(opt => {
                             const isCorrect = opt === item.correctAnswer;
                             optionsHtml += \`<div class="option \${isCorrect ? 'correct' : ''}">\${isCorrect ? '✓ ' : '○ '} \${opt}</div>\`;
                         });
                         optionsHtml += '</div>';
                         
                         card.innerHTML = \`
                             <div class="q-text">Q\${item.index}. <span class="md-target">\${item.text}</span></div>
                             \${optionsHtml}
                         \`;
                     } else if (item.type === 'written') {
                         card.innerHTML = \`
                             <div class="written-meta">Q\${item.index} • \${item.qType} • \${item.marks} Marks</div>
                             <div class="written-q md-target">\${item.question}</div>
                             <div class="written-answer">
                                <span class="answer-label">Model Answer:</span>
                                <div class="md-target">\${item.answer}</div>
                             </div>
                         \`;
                     } else if (item.type === 'note') {
                         card.innerHTML = \`
                            <div class="note-title">
                                \${item.title}
                                <span class="badge badge-\${item.importance}">\${item.importance}</span>
                            </div>
                            <div class="markdown md-target">\${item.content}</div>
                         \`;
                     }
                     container.appendChild(card);
                 });

                 // Render Markdown
                 const cards = container.querySelectorAll('.card');
                 data.forEach((item, idx) => {
                     if (item.type === 'header') return; 
                     // Since headers are siblings, we need to find the correct card.
                     // A safer way is to just query all .card elements again, but for now standard query works
                     // as long as we iterate properly.
                     // Simpler approach: query all .md-target inside container
                 });
                 
                 const targets = container.querySelectorAll('.md-target');
                 targets.forEach(t => {
                    marked.use({ breaks: true });
                    t.innerHTML = marked.parse(t.textContent);
                 });

                 // Render Math
                 renderMathInElement(document.body, {
                    delimiters: [
                        {left: '$$', right: '$$', display: true},
                        {left: '$', right: '$', display: false}
                    ],
                    throwOnError: false
                 });
                 
                 setTimeout(() => window.print(), 800);
             };
          </script>
        </body>
      </html>
    `;
    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
  
  const formatDurationVerbose = (seconds: number) => {
      const mins = Math.floor(seconds / 60);
      const secs = seconds % 60;
      if (mins === 0) return `${secs} সেকেন্ড`;
      return `${mins} মিনিট ${secs} সেকেন্ড`;
  };

  const calculateScore = (): QuizResult => {
    let score = 0;
    questions.forEach(q => {
      if (userAnswers[q.id] === q.correctAnswer) score++;
    });
    return { score, total: questions.length, answers: userAnswers };
  };

  // Helper for rendering math text 
  const renderMathText = (text: string, isOption = false) => (
    <ReactMarkdown 
        remarkPlugins={[remarkMath]} 
        rehypePlugins={[rehypeKatex]}
        components={{
            p: ({node, ...props}) => isOption ? <span {...props} /> : <p {...props} />
        }}
    >
        {text}
    </ReactMarkdown>
  );

  // --- Renders ---

  const renderUpload = () => (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-6 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-rose-400 mb-4 leading-tight">
          Smart MCQ Master
        </h1>
        <p className="text-secondary text-lg max-w-md mx-auto">
          {uploadMode === 'extract' && 'প্রশ্নপত্র আপলোড করুন (PDF/ছবি)। AI প্রশ্ন খুঁজে বের করবে।'}
          {uploadMode === 'generate' && 'লেকচার স্লাইড আপলোড করুন (PDF/ছবি)। AI MCQ তৈরি করবে।'}
          {uploadMode === 'notes' && 'লেকচার নোট আপলোড করুন (PDF/ছবি)। AI শর্ট নোট তৈরি করবে।'}
          {uploadMode === 'written' && 'লেকচার স্লাইড আপলোড করুন (PDF/ছবি)। AI লিখিত প্রশ্ন তৈরি করবে।'}
        </p>
      </div>
      
      {/* Mode Toggle */}
      <div className="flex bg-neutral-900 p-1 rounded-xl mb-8 border border-neutral-800 flex-wrap justify-center gap-1">
          <button onClick={() => setUploadMode('extract')} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${uploadMode === 'extract' ? 'bg-red-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}>প্রশ্নপত্র</button>
          <button onClick={() => setUploadMode('generate')} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${uploadMode === 'generate' ? 'bg-red-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}>লেকচার স্লাইড</button>
          <button onClick={() => setUploadMode('notes')} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${uploadMode === 'notes' ? 'bg-red-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}>শর্ট নোটস</button>
          <button onClick={() => setUploadMode('written')} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${uploadMode === 'written' ? 'bg-red-600 text-white shadow-lg' : 'text-gray-400 hover:text-white'}`}>লিখিত প্রস্তুতি</button>
      </div>

      <div className="w-full max-w-md">
        <label className={`
          flex flex-col items-center justify-center w-full h-64 
          border-2 border-dashed rounded-3xl cursor-pointer 
          transition-all duration-300 relative overflow-hidden
          ${isProcessing ? 'border-red-500 bg-neutral-900' : 'border-neutral-700 hover:border-red-400 hover:bg-neutral-900'}
        `}>
          <div className="flex flex-col items-center justify-center pt-5 pb-6 z-10 w-full px-4">
             {isProcessing ? (
                <div className="flex flex-col items-center w-full">
                    <div className="w-12 h-12 border-4 border-red-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                    <p className="text-red-400 font-medium animate-pulse mb-4 text-center">{processingStatus}</p>
                    {/* Show "Launch Quiz" button ONLY for MCQ modes */}
                    {uploadMode !== 'notes' && uploadMode !== 'written' && questions.length > 0 && (
                         <button 
                            onClick={(e) => { 
                                e.preventDefault(); 
                                e.stopPropagation(); 
                                stopExtractionAndStart(); 
                            }}
                            className="mt-4 px-8 py-3 bg-red-600 hover:bg-red-500 text-white rounded-xl font-bold shadow-lg shadow-red-500/30 transition-all transform hover:scale-105 z-20"
                        >
                            কুইজ শুরু করুন ({questions.length} টি রেডি)
                        </button>
                    )}
                </div>
             ) : (
                <>
                    {uploadMode === 'notes' ? <NoteIcon /> : uploadMode === 'generate' ? <BookOpenIcon /> : uploadMode === 'written' ? <SparklesIcon /> : <UploadIcon />}
                    <p className="mb-2 text-sm text-gray-400 mt-2 text-center">
                        <span className="font-semibold text-white">PDF বা ছবি আপলোড করতে ক্লিক করুন</span>
                    </p>
                </>
             )}
          </div>
          <input type="file" className="hidden" accept="application/pdf, image/png, image/jpeg, image/webp, image/heic, image/heif" multiple onChange={handleFileUpload} disabled={isProcessing} />
        </label>
        
        {/* Varsity Mode Toggle - Only in Notes Mode or Generate Mode */}
        {(uploadMode === 'notes' || uploadMode === 'generate') && (
          <div className="flex items-center justify-center mt-6 animate-fade-in">
              <label className="flex items-center cursor-pointer gap-3 bg-neutral-900/80 px-5 py-3 rounded-full border border-neutral-800 hover:border-red-500/50 transition-colors shadow-lg">
                 <div className="relative">
                   <input type="checkbox" className="sr-only" checked={isVarsityMode} onChange={e => setIsVarsityMode(e.target.checked)} />
                   <div className={`block w-10 h-6 rounded-full transition-colors ${isVarsityMode ? 'bg-red-600' : 'bg-neutral-600'}`}></div>
                   <div className={`absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${isVarsityMode ? 'translate-x-4' : 'translate-x-0'}`}></div>
                 </div>
                 <span className={`text-sm font-bold transition-colors ${isVarsityMode ? 'text-red-400' : 'text-gray-400'}`}>
                   {isVarsityMode ? 'ভার্সিটি মোড (DU/RU)' : 'ইঞ্জিনিয়ারিং মোড (BUET/CKRUET)'}
                 </span>
              </label>
          </div>
        )}
      </div>
    </div>
  );

  const renderSetup = () => (
    <div className="flex flex-col items-center justify-center min-h-[50vh] animate-fade-in p-4">
      <div className="bg-surface/80 backdrop-blur-sm p-8 rounded-3xl shadow-2xl w-full max-w-lg border border-neutral-800 text-center">
        <h2 className="text-3xl font-bold mb-4 text-white">
            {uploadMode === 'extract' ? 'প্রশ্ন এক্সট্র্যাক্ট করা হয়েছে' : 'প্রশ্ন তৈরি করা হয়েছে'}
        </h2>
        <div className="flex flex-col items-center justify-center mb-8 bg-neutral-900 rounded-2xl p-6 border border-neutral-800 w-full">
            <p className="text-secondary text-sm mb-2">মোট প্রশ্ন</p>
            <p className="text-5xl font-bold text-white mb-2">{questions.length}</p>
            {isBackgroundExtracting && (
                <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 px-3 py-1 rounded-full animate-pulse mt-2">
                    <div className="w-2 h-2 bg-red-400 rounded-full"></div>
                    {uploadMode === 'extract' ? 'আরও খোঁজা হচ্ছে...' : 'আরও তৈরি হচ্ছে...'}
                </div>
            )}
        </div>
        <button onClick={startExam} className="w-full bg-gradient-to-r from-red-600 to-rose-500 hover:from-red-500 hover:to-rose-400 text-white font-bold py-4 rounded-xl shadow-lg shadow-red-500/25 transition-all transform hover:scale-[1.02] active:scale-[0.98]">
            পরীক্ষা শুরু করুন
        </button>
      </div>
    </div>
  );

  const renderExam = () => {
    if (!questions[currentQIndex]) return null;
    const currentQuestion = questions[currentQIndex];
    const isAnswered = !!userAnswers[currentQuestion.id];
    const isCorrect = userAnswers[currentQuestion.id] === currentQuestion.correctAnswer;
    const timeTaken = answerTimes[currentQuestion.id];

    return (
      <div className="max-w-4xl mx-auto w-full p-4 animate-fade-in">
        <div className="flex justify-between items-center mb-6">
            <div className="text-sm font-mono text-secondary flex items-center gap-2">
                <span>প্রশ্ন <span className="text-white font-bold">{currentQIndex + 1}</span> / {questions.length}</span>
                {isBackgroundExtracting && <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>}
            </div>
            <div className={`flex items-center gap-2 px-4 py-2 rounded-full border transition-colors ${isAnswered ? 'bg-red-900/30 border-red-500/30' : 'bg-neutral-900 border-neutral-800'}`}>
                <ClockIcon />
                {isAnswered ? <span className="font-mono font-bold text-red-400">{timeTaken}s</span> : <span className="font-mono font-bold text-gray-300">{formatTime(timeSpent)}</span>}
            </div>
        </div>

        <div className="bg-surface rounded-2xl p-6 md:p-10 shadow-2xl border border-neutral-800 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-neutral-800">
                <div className="h-full bg-red-600 transition-all duration-300 ease-out" style={{ width: `${((currentQIndex + 1) / questions.length) * 100}%` }} />
            </div>

            <div className="flex justify-between items-start gap-4 mb-8 mt-2">
                <div className="text-xl md:text-2xl font-bold text-white leading-relaxed w-full">
                    {renderMathText(currentQuestion.text)}
                </div>
                <button onClick={() => toggleFavorite(currentQuestion.id)} className="text-pink-500 hover:scale-110 transition-transform p-2 flex-shrink-0">
                    <HeartIcon filled={favorites.has(currentQuestion.id)} />
                </button>
            </div>

            <div className="grid gap-3">
                {currentQuestion.options.map((option, idx) => {
                    const isSelected = userAnswers[currentQuestion.id] === option;
                    const isThisCorrect = option === currentQuestion.correctAnswer;
                    let className = "p-4 rounded-xl border-2 text-left transition-all relative flex items-start ";
                    if (isAnswered) {
                        if (isThisCorrect) className += "border-green-600 bg-green-900/20 text-green-100 ";
                        else if (isSelected) className += "border-red-600 bg-red-900/20 text-red-100 ";
                        else className += "border-neutral-800 bg-neutral-900/50 text-gray-500 opacity-60 ";
                    } else {
                        className += "border-neutral-800 bg-neutral-900/50 hover:border-red-500/50 hover:bg-neutral-800 text-gray-200 ";
                    }
                    return (
                        <button key={idx} onClick={() => handleAnswerSelect(currentQuestion.id, option)} disabled={isAnswered} className={className}>
                            <span className="inline-block w-6 font-mono opacity-50 mr-2 flex-shrink-0 mt-0.5">{String.fromCharCode(65 + idx)}.</span>
                            <span className="flex-1 text-left">{renderMathText(option, true)}</span>
                        </button>
                    );
                })}
            </div>

            <div className="mt-8 border-t border-neutral-800 pt-6 animate-fade-in">
                <div className="flex flex-wrap gap-4 items-center justify-between mb-6 min-h-[2.5rem]">
                    <div className="flex items-center gap-4 animate-fade-in">
                        {isAnswered && (
                            <span className={isCorrect ? "text-green-400 font-bold flex items-center gap-2" : "text-red-400 font-bold flex items-center gap-2"}>
                                {isCorrect ? "সঠিক উত্তর" : "ভুল উত্তর"}
                            </span>
                        )}
                    </div>
                    <button onClick={() => setShowExplanation(!showExplanation)} className="px-4 py-2 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors text-sm font-medium flex items-center gap-2 ml-auto">
                        <SparklesIcon /> {showExplanation ? 'টিউটর বন্ধ করুন' : 'AI টিউটর'}
                    </button>
                </div>

                <div className="flex justify-between items-center">
                    <button onClick={() => goToQuestion(currentQIndex - 1)} disabled={currentQIndex === 0} className={`px-6 py-2.5 rounded-xl font-medium transition-all flex items-center gap-2 ${currentQIndex === 0 ? 'opacity-0 pointer-events-none' : 'bg-neutral-800 text-gray-300 hover:bg-neutral-700 hover:text-white'}`}>পূর্ববর্তী</button>
                    {currentQIndex < questions.length - 1 ? (
                        <button onClick={() => goToQuestion(currentQIndex + 1)} className="px-6 py-2.5 rounded-xl bg-white text-black font-bold hover:bg-gray-200 transition-colors flex items-center gap-2">পরবর্তী</button>
                    ) : (
                        <button onClick={submitExam} className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-green-600 to-emerald-600 text-white font-bold hover:from-green-700 hover:to-emerald-700 transition-all shadow-lg shadow-green-500/20">পরীক্ষা শেষ করুন</button>
                    )}
                </div>
            </div>
            {showExplanation && <AIChat question={currentQuestion} />}
        </div>
      </div>
    );
  };

  const renderResults = () => {
    const { score, total } = calculateScore();
    const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
    return (
      <div className="max-w-4xl mx-auto w-full animate-fade-in p-6">
          <div className="bg-surface rounded-3xl p-8 md:p-12 text-center border border-neutral-800 shadow-2xl mb-8">
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
                       <div className="text-center"><span className="text-4xl font-bold text-white block">{score}</span><span className="text-sm text-secondary">/{total}</span></div>
                  </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4 max-w-sm mx-auto mb-8">
                   <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800"><div className="text-2xl font-bold text-green-400">{score}</div><div className="text-xs text-secondary uppercase tracking-wider">সঠিক</div></div>
                   <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800"><div className="text-2xl font-bold text-red-400">{total - score}</div><div className="text-xs text-secondary uppercase tracking-wider">ভুল</div></div>
              </div>

              <div className="flex flex-wrap gap-4 justify-center">
                  <button onClick={() => setStep(AppStep.UPLOAD)} className="px-6 py-3 rounded-xl bg-neutral-800 text-white hover:bg-neutral-700 transition-colors font-medium">নতুন ফাইল আপলোড</button>
                  <button onClick={startExam} className="px-6 py-3 rounded-xl bg-red-600 text-white hover:bg-red-500 transition-colors font-bold shadow-lg shadow-red-500/20">পুনরায় পরীক্ষা</button>
                  <button onClick={() => handleDownloadPDF(questions, 'Full Exam Questions', 'questions')} className="px-6 py-3 rounded-xl bg-neutral-800 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/10 transition-colors font-bold flex items-center gap-2">
                     <DownloadIcon /> প্রশ্ন ডাউনলোড করুন
                  </button>
              </div>
          </div>
          {favorites.size > 0 && (
              <div className="text-center mb-12">
                  <button onClick={() => handleDownloadPDF(questions.filter(q => favorites.has(q.id)), 'Favorite Questions', 'questions')} className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-pink-500/10 text-pink-500 border border-pink-500/20 hover:bg-pink-500/20 transition-all">
                      <HeartIcon filled={true} /> {favorites.size} টি প্রিয় প্রশ্ন ডাউনলোড করুন
                  </button>
              </div>
          )}
      </div>
    );
  };

  const renderNotesView = () => (
      <div className="max-w-4xl mx-auto w-full p-4 animate-fade-in">
          <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-bold text-white flex items-center gap-3">
                  <NoteIcon /> {isVarsityMode ? 'DU ভার্সিটি নোটস' : 'ইঞ্জিনিয়ারিং মাস্টার নোটস'}
              </h2>
              <button 
                onClick={() => handleDownloadPDF(notes, isVarsityMode ? 'DU Admission Notes' : 'Engineering Master Notes', 'notes')}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold shadow-lg flex items-center gap-2 text-sm"
              >
                  <DownloadIcon /> PDF ডাউনলোড
              </button>
          </div>

          <div className="space-y-6">
              {notes.map((note) => (
                  <div key={note.id} className="bg-surface rounded-2xl p-6 border border-neutral-800 shadow-xl">
                      <div className="flex items-center justify-between mb-4 border-b border-neutral-800 pb-3">
                          <h3 className="text-xl font-bold text-red-400">{note.title}</h3>
                          <span className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
                              note.importance === 'High' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                              note.importance === 'Medium' ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' :
                              'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                          }`}>
                              {note.importance} Priority
                          </span>
                      </div>
                      <div className="text-gray-300 prose prose-invert max-w-none markdown-content">
                          <ReactMarkdown 
                            remarkPlugins={[remarkMath]} 
                            rehypePlugins={[rehypeKatex]}
                            components={{
                                // Custom renderer to color specific important headers in red
                                strong: ({node, ...props}) => {
                                    const text = String(props.children);
                                    // Check for "Important" or "সতর্কতা" to color red
                                    const isImportant = text.includes('সতর্কতা') || text.includes('গুরুত্ব') || text.includes('🔴');
                                    return <strong style={{ color: isImportant ? '#ef4444' : '#f87171' }} {...props} />
                                }
                            }}
                          >
                              {processMarkdownContent(note.content)}
                          </ReactMarkdown>
                      </div>
                  </div>
              ))}
          </div>
          
          <div className="mt-12 text-center">
              <button onClick={() => setStep(AppStep.UPLOAD)} className="px-6 py-3 rounded-xl bg-neutral-800 text-white hover:bg-neutral-700 transition-colors font-medium">
                  অন্য ফাইল আপলোড করুন
              </button>
          </div>
      </div>
  );

  const renderWrittenView = () => {
    // Group Questions by Subject
    const groupedQuestions: Record<string, WrittenQuestion[]> = {};
    writtenQuestions.forEach(q => {
        const sub = q.subject || "General";
        if (!groupedQuestions[sub]) groupedQuestions[sub] = [];
        groupedQuestions[sub].push(q);
    });

    return (
    <div className="max-w-4xl mx-auto w-full p-4 animate-fade-in">
        <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
                <SparklesIcon /> লিখিত প্রস্তুতি
            </h2>
            <button 
              onClick={() => handleDownloadPDF(writtenQuestions, 'Written Admission Questions & Solutions', 'written')}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-lg font-bold shadow-lg flex items-center gap-2 text-sm"
            >
                <DownloadIcon /> PDF ডাউনলোড
            </button>
        </div>

        {Object.keys(groupedQuestions).length === 0 ? (
            <div className="text-center text-gray-500 mt-12">কোন প্রশ্ন তৈরি হয়নি।</div>
        ) : (
            <div className="space-y-10">
                {Object.entries(groupedQuestions).map(([subject, questions]) => (
                    <div key={subject} className="animate-fade-in">
                        <div className="flex items-center gap-3 mb-4 border-b border-red-500/30 pb-2">
                             <div className="w-2 h-6 bg-red-500 rounded-full"></div>
                             <h3 className="text-xl font-bold text-red-300 uppercase tracking-wide">{subject}</h3>
                        </div>
                        
                        <div className="space-y-6">
                            {questions.map((item, index) => {
                                const isOpen = visibleAnswers.has(item.id);
                                return (
                                    <div key={item.id} className="bg-surface rounded-2xl border border-neutral-800 shadow-xl overflow-hidden">
                                        <div className="p-6">
                                            <div className="flex justify-between items-start mb-4">
                                                <span className="inline-block bg-neutral-900 text-red-400 text-xs font-bold px-3 py-1 rounded-full border border-neutral-800 uppercase">
                                                    {item.type}
                                                </span>
                                                <span className="text-sm font-bold text-gray-400">{item.marks} Marks</span>
                                            </div>
                                            
                                            <div className="text-xl font-bold text-white mb-6 leading-relaxed">
                                                <span className="text-red-500 mr-2">Q{index+1}.</span>
                                                {renderMathText(item.question)}
                                            </div>

                                            <button 
                                                onClick={() => toggleWrittenAnswer(item.id)}
                                                className="w-full py-3 px-4 bg-neutral-900 hover:bg-neutral-800 border border-neutral-800 rounded-xl text-sm font-bold text-gray-300 transition-colors flex items-center justify-center gap-2"
                                            >
                                                {isOpen ? 'উত্তর লুকান' : 'সমাধান দেখুন'}
                                            </button>
                                        </div>
                                        
                                        {isOpen && (
                                            <div className="bg-neutral-900/50 p-6 border-t border-neutral-800 border-l-4 border-l-red-600 animate-fade-in">
                                                <h4 className="text-sm font-bold text-red-400 mb-3 uppercase tracking-wider">মডেল সমাধান</h4>
                                                <div className="text-gray-300 prose prose-invert max-w-none markdown-content">
                                                    <ReactMarkdown 
                                                        remarkPlugins={[remarkMath]} 
                                                        rehypePlugins={[rehypeKatex]}
                                                    >
                                                        {item.answer}
                                                    </ReactMarkdown>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ))}
            </div>
        )}

        <div className="mt-12 text-center">
            <button onClick={() => setStep(AppStep.UPLOAD)} className="px-6 py-3 rounded-xl bg-neutral-800 text-white hover:bg-neutral-700 transition-colors font-medium">
                অন্য ফাইল আপলোড করুন
            </button>
        </div>
    </div>
    );
  };

  return (
    <div className="min-h-screen bg-black text-gray-100 font-sans selection:bg-red-500/30">
      <div className="container mx-auto px-4 py-8">
        {step !== AppStep.UPLOAD && (
            <div className="flex items-center justify-between mb-8 animate-fade-in">
                <div className="font-bold text-xl tracking-tight text-white cursor-pointer" onClick={() => setStep(AppStep.UPLOAD)}>
                    Smart MCQ <span className="text-red-500">Master</span>
                </div>
                {step === AppStep.EXAM && (
                   <div className="flex gap-2">
                       <button onClick={submitExam} className="text-sm text-red-400 hover:text-red-300 transition-colors">পরীক্ষা শেষ করুন</button>
                   </div>
                )}
            </div>
        )}
        <main className="flex flex-col items-center w-full">
            {step === AppStep.UPLOAD && renderUpload()}
            {step === AppStep.SETUP && renderSetup()}
            {step === AppStep.EXAM && renderExam()}
            {step === AppStep.RESULTS && renderResults()}
            {step === AppStep.NOTES_VIEW && renderNotesView()}
            {step === AppStep.WRITTEN_VIEW && renderWrittenView()}
        </main>
        <footer className="mt-20 py-6 text-center text-neutral-600 text-sm border-t border-neutral-900 w-full">
            <p>© {new Date().getFullYear()} Smart MCQ Master. Powered by Gemini AI.</p>
        </footer>
      </div>
    </div>
  );
}

export default App;