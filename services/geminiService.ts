import { GoogleGenAI, Type, Schema } from "@google/genai";
import { Question, NoteSection, WrittenQuestion } from "../types";

// Helper to convert file to base64
export const fileToGenerativePart = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        const base64Data = reader.result.split(',')[1];
        resolve(base64Data);
      } else {
        reject(new Error("Failed to read file as base64 string."));
      }
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
};

const getClient = () => {
    // Safety check for process.env
    const apiKey = typeof process !== 'undefined' && process.env ? process.env.API_KEY : undefined;
    if (!apiKey) throw new Error("API Key not found");
    return new GoogleGenAI({ apiKey });
}

// Internal Minified Interface for Token Efficiency
interface MinifiedQuestion {
    q: string; // text
    o: string[]; // options
    a: string; // answer
}

// Helper to sanitize/repair JSON if truncated
const safeParseJSON = (jsonString: string): any[] => {
    try {
        const parsed = JSON.parse(jsonString);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'object' && parsed !== null) {
            // Robustness: If model returns { "questions": [...] } instead of [...], extract the array
            const values = Object.values(parsed);
            const arrayValue = values.find(v => Array.isArray(v));
            if (arrayValue) return arrayValue as any[];
        }
        return [];
    } catch (error: any) {
        console.warn("JSON Parse failed, attempting repair:", error.message);
        
        let cleaned = jsonString.trim();
        const firstBracket = cleaned.indexOf('[');
        if (firstBracket !== -1) {
            cleaned = cleaned.substring(firstBracket);
        }

        const lastObjectEnd = cleaned.lastIndexOf('},');
        
        if (lastObjectEnd !== -1) {
            cleaned = cleaned.substring(0, lastObjectEnd + 1); 
            cleaned += ']';
            try {
                const repaired = JSON.parse(cleaned);
                return Array.isArray(repaired) ? repaired : [];
            } catch (e) {
                console.error("JSON repair failed:", e);
            }
        }
        return []; 
    }
};

// --- LATEX CLEANER ---
// Removes hallucinated commands that cause KaTeX rendering errors or bad formatting
const cleanLatex = (text: any): string => {
    if (typeof text !== 'string') return "";
    
    // Preliminary Cleanup for specific artifacts reported (imes, ext, mu without backslash)
    let fixed = text
        // Fix "imes" -> "\times" (often caused by \t interpretation)
        .replace(/(\d|\})\s*imes\s*(\d|10)/g, '$1 \\times $2')
        .replace(/\bimes\b/g, '\\times')

        // Fix "extmu" -> "\mu"
        .replace(/extmu/g, '\\mu')
        
        // Fix "ext" followed by Unit (e.g., extV, extJ -> V, J)
        .replace(/(\d)\s*ext([A-Z])/g, '$1 $2')
        .replace(/ext([A-Z])/g, '$1')

        // Fix generic "ext" that should be empty or was \text
        .replace(/\\?ext\{([^}]+)\}/g, '$1')
        .replace(/\\ext\b/g, '')

        // Fix missing backslash for mu if preceded by number
        .replace(/(\d)mu\b/g, '$1\\mu')
        
        // Fix degree symbol hallucinations (User reported: "3^e xto")
        .replace(/\^e\s*xto/g, '^\\circ') 
        .replace(/xto/g, '^\\circ')
        .replace(/\^e/g, '^\\circ')
        .replace(/\\text\{o\}/g, '^\\circ')
        .replace(/deg/g, '^\\circ')

        // Fix other common hallucinations
        .replace(/\\oldsymbol/g, '')   
        .replace(/\\extuparrow/g, '\\uparrow') 
        .replace(/\\extdownarrow/g, '\\downarrow') 
        .replace(/\\extrightarrow/g, '\\rightarrow') 
        .replace(/\\style/g, '')       
        .replace(/\\oldtext/g, '')     
        
        // Clean up nested braces left behind by removal
        .replace(/\{\s*\{\s*(\\uparrow|\\downarrow|\\rightarrow|\\to)\s*\}\s*\}/g, '$1')
        .replace(/\{\s*(\\uparrow|\\downarrow|\\rightarrow|\\to)\s*\}/g, '$1'); 

    return fixed;
};

// Generate a random unique ID to prevent React key collisions across multiple files
const generateUniqueId = () => Math.floor(Date.now() + Math.random() * 1000000);

interface FileData {
    mimeType: string;
    data: string;
}

// --- MODE 1: Extract Existing Questions ---
export const extractQuestions = async (
    fileData: FileData, 
    onBatch: (newQuestions: Question[]) => void,
    signal?: AbortSignal
): Promise<void> => {
  const ai = getClient();
  let allQuestions: Question[] = [];
  let hasMore = true;
  let retryCount = 0;
  const MAX_RETRIES = 3;
  
  // Start with a decent chunk to populate the list quickly
  let currentBatchSize = 20; 

  // OPTIMIZATION: Minified keys to save output tokens
  const schema: Schema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        q: { type: Type.STRING, description: "Question text. Fix broken Bengali unicode." },
        o: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Options" },
        a: { type: Type.STRING, description: "Correct Answer" }
      },
      required: ["q", "o", "a"]
    }
  };

  while (hasMore) {
    if (signal?.aborted) {
        console.log("Extraction aborted by user.");
        break;
    }

    try {
        const lastQuestion = allQuestions.length > 0 ? allQuestions[allQuestions.length - 1] : null;
        const lastTextSnippet = lastQuestion ? lastQuestion.text.slice(0, 50) : "";

        const prompt = `Task: Extract MCQ questions from the provided document/image.
        
        ${lastQuestion 
            ? `PREVIOUSLY EXTRACTED LAST QUESTION: "${lastTextSnippet}"... \nINSTRUCTION: Find this question in the document, ignore it, and extract the NEXT ${currentBatchSize} questions appearing immediately after it.` 
            : `INSTRUCTION: Start extracting from the very BEGINNING of the document. Get the first ${currentBatchSize} questions.`}
        
        CRITICAL RULES:
        1. **FIX BROKEN BENGALI TEXT**: The file might contain decomposed/broken Unicode. Reconstruct them into valid, readable Bengali words.
        2. **DOUBLE ESCAPE LATEX**: When writing JSON, you MUST double escape backslashes for LaTeX commands. 
           - **CORRECT**: "\\\\times", "\\\\mu", "\\\\text{V}", "\\\\circ"
           - **INCORRECT**: "\\times", "\\mu" (these will break JSON parsing or disappear)
        3. **SCIENTIFIC NOTATION**:
           - Degrees: Use $^\\circ$.
           - Units: $100 \\text{V}$ or just $100 V$. 
           - Symbols: $\\rightarrow, \\uparrow$.
        4. Infer options if missing labels.
        5. Solve if answer not marked.
        6. Return JSON array: q=question, o=options array, a=correct answer string.
        7. Return [] ONLY if you have reached the absolute end of the document.`;

        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: {
            parts: [
              { inlineData: { mimeType: fileData.mimeType, data: fileData.data } },
              { text: prompt }
            ]
          },
          config: {
            responseMimeType: "application/json",
            responseSchema: schema,
          }
        });

        const minifiedQuestions = response.text ? safeParseJSON(response.text) as MinifiedQuestion[] : [];
        
        // Robust filtering to prevent [object Object] and other type errors
        const newQuestions: Question[] = minifiedQuestions
            .filter(mq => mq && typeof mq.q === 'string' && Array.isArray(mq.o) && typeof mq.a === 'string')
            .map(mq => ({
                id: 0, 
                text: cleanLatex(mq.q),
                options: mq.o.map(opt => cleanLatex(opt)),
                correctAnswer: cleanLatex(mq.a)
            }));

        const uniqueNewQuestions = newQuestions.filter(nq => 
            !allQuestions.some(oq => oq.text.includes(nq.text.slice(0, 20)) || nq.text.includes(oq.text.slice(0, 20)))
        );

        if (uniqueNewQuestions.length === 0) {
            retryCount++;
            console.warn(`Batch produced no new questions. Retry ${retryCount}/${MAX_RETRIES}`);
            
            if (retryCount >= MAX_RETRIES) {
                console.log("Max retries reached. Assuming end of document.");
                hasMore = false;
            }
            continue; 
        }

        retryCount = 0;

        const preparedQuestions = uniqueNewQuestions.map((q) => ({
            ...q,
            id: generateUniqueId() // Fix: Use unique ID to prevent key collision
        }));

        allQuestions = [...allQuestions, ...preparedQuestions];
        onBatch(preparedQuestions);
        currentBatchSize = 30;

        if (allQuestions.length >= 500) hasMore = false;

    } catch (error) {
        console.error("Batch error:", error);
        if (signal?.aborted) break;
        
        retryCount++;
        if (retryCount >= MAX_RETRIES) {
             if (allQuestions.length > 0) hasMore = false;
             else throw error;
        }
    }
  }
};

// --- MODE 2: Generate Questions from Slides ---
export const generateQuestionsFromSlides = async (
    fileData: FileData,
    onBatch: (newQuestions: Question[]) => void,
    signal?: AbortSignal,
    isVarsity: boolean = false
): Promise<void> => {
    const ai = getClient();
    
    // Define generation batches based on Mode (Varsity vs Engineering)
    let batches = [];
    
    if (isVarsity) {
        // VARSITY (DU/RU) - 1 Mark Standard
        // Characteristics: Conceptual, Calculator-free math, Memory-based, Tricky logic
        batches = [
            { 
                label: "DU Core Concepts", 
                prompt: "Generate 5 'Varsity Standard' MCQs (1 Mark each). Focus on fundamental definitions, core concepts, and direct recall suitable for Dhaka University A Unit." 
            },
            { 
                label: "Calculator-Free Math", 
                prompt: "Generate 5 MCQs involving short mathematical problems that can be solved WITHOUT a calculator. Use standard values ($g=9.8, \\pi \\approx 3.1416$) and tricky logic." 
            },
            { 
                label: "Conceptual Traps", 
                prompt: "Generate 5 'Tricky' Conceptual MCQs. Focus on common misconceptions, graph interpretations, and 'What happens if...' scenarios." 
            },
            {
                label: "Mixed Varsity Review",
                prompt: "Generate 5 mixed difficulty MCQs covering remaining topics. Ensure they are concise and fit the 1-minute time limit per question."
            }
        ];
    } else {
        // ENGINEERING (BUET/CKRUET) - 6 Mark Standard (converted to MCQ)
        // Characteristics: Multi-step calculation, Deep analysis, Written-quality problems
        batches = [
            { 
                label: "Engineering Analytical", 
                prompt: "Generate 5 'Engineering Standard' MCQs. These should be equivalent to 6-mark Written Questions but adapted for MCQ format. Focus on complex, multi-step calculations." 
            },
            { 
                label: "Deep Concept & Derivation", 
                prompt: "Generate 5 Hard MCQs based on derivations and deep physical/chemical mechanisms. Focus on edge cases suitable for BUET/RUET." 
            },
            { 
                label: "Complex Math Application", 
                prompt: "Generate 5 Mathematical Application MCQs. These should require robust formula application and significant calculation (calculator allowed standard)." 
            },
            {
                label: "Mixed Engineering Review",
                prompt: "Generate 5 challenging MCQs covering advanced topics and specific engineering applications found in the slides."
            }
        ];
    }

    const schema: Schema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            q: { type: Type.STRING, description: "Question text. Fix broken Bengali unicode." },
            o: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Options" },
            a: { type: Type.STRING, description: "Correct Answer" }
          },
          required: ["q", "o", "a"]
        }
    };

    for (const batch of batches) {
        if (signal?.aborted) break;

        try {
            const prompt = `
            Role: Expert Exam Setter for ${isVarsity ? "Dhaka University (DU A-Unit)" : "BUET/CKRUET Engineering Admission"}.
            Task: ${batch.prompt}
            
            Source Material: Analyze the attached Document/Image (Lecture Slides/Notes) thoroughly. extract content from all visible pages/areas.
            
            Strict Rules:
            1. **Language**: Bengali (Standard academic).
            2. **Unicode Fix**: Ensure Bengali text is perfectly formed.
            3. **DOUBLE ESCAPE LATEX**: You MUST double escape backslashes in the JSON string.
               - CORRECT: "\\\\times", "\\\\mu", "\\\\circ"
               - INCORRECT: "\\times", "\\mu"
            4. **Scientific Notation**: Use correct LaTeX.
               - Degrees: $^\\circ$
               - Arrows: $\\rightarrow, \\rightleftharpoons, \\uparrow, \\downarrow$.
            5. **Quality**: Options must be plausible distractors. Strictly one correct answer.
            6. **Format**: Return JSON array only.
            7. **Tags**: DO NOT add difficulty tags in 'q'.
            `;

            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: {
                  parts: [
                    { inlineData: { mimeType: fileData.mimeType, data: fileData.data } },
                    { text: prompt }
                  ]
                },
                config: {
                  responseMimeType: "application/json",
                  responseSchema: schema,
                }
            });
      
            const minifiedQuestions = response.text ? safeParseJSON(response.text) as MinifiedQuestion[] : [];
              
            if (minifiedQuestions.length > 0) {
                const newQuestions: Question[] = minifiedQuestions
                .filter(mq => mq && typeof mq.q === 'string' && Array.isArray(mq.o) && typeof mq.a === 'string')
                .map((mq) => ({
                    id: generateUniqueId(),
                    text: cleanLatex(`[${batch.label}] ${mq.q}`),
                    options: mq.o.map(opt => cleanLatex(opt)),
                    correctAnswer: cleanLatex(mq.a)
                }));
                
                onBatch(newQuestions);
            }

        } catch (error) {
            console.error(`Error generating batch ${batch.label}:`, error);
            if (signal?.aborted) break;
            // Continue to next batch even if one fails
        }
    }
};

// --- MODE 3: Generate Compact Notes ---
export const generateStudyNotes = async (
    fileData: FileData,
    onBatch: (newNotes: NoteSection[]) => void,
    signal?: AbortSignal,
    isVarsity: boolean = false
): Promise<void> => {
    const ai = getClient();
    
    const schema: Schema = {
        type: Type.ARRAY,
        items: {
            type: Type.OBJECT,
            properties: {
                title: { type: Type.STRING, description: "Topic title" },
                content: { type: Type.STRING, description: "Structured revision note content in Markdown." },
                importance: { type: Type.STRING, enum: ["High", "Medium", "Normal"] }
            },
            required: ["title", "content", "importance"]
        }
    };

    const engineeringPrompt = `
    Role: You are an expert STEM educator specializing in engineering university admission exams (like BUET, KUET, RUET, IUT). 

    Task: Analyze the provided document/image (Lecture Slide/Note) and generate a 'High-Yield Master Note' that is sufficient for both written and MCQ engineering exams.

    Generate a structured note for EACH key topic found in the content.
    
    STRICT LANGUAGE RULE:
    - **DETECT THE LANGUAGE OF THE SOURCE.** (Likely Bengali/Bangla).
    - **WRITE THE EXPLANATIONS IN THE SAME LANGUAGE.**
    - If the slides are in Bengali, the notes MUST be in **Bengali**.
    - If the slides are in English, use English.
    - **KEEP THE SECTION HEADERS (e.g., 'Core Concept & Definitions') IN ENGLISH** to maintain structure for the app.
    - Mathematical terms and formulas should remain in standard scientific notation/English.

    STRICT CONTENT STRUCTURE (Use these headers in Markdown for the 'content' field):

    1. **Core Concept & Definitions:** List all fundamental concepts. Do not just define them; explain the 'Why' and 'How' based on the slide's depth.
    2. **All Formulas & Units:** Extract every single mathematical formula. Define each variable and provide its standard unit. Highlight any specific conditions for a formula to be applicable. Use LaTeX ($...$) for math.
    3. **Chemical Reactions & Mechanisms:** Transcribe every chemical equation ($...$) from the slides. For mechanisms (like Hydrolysis or Hybridization), explain the step-by-step electron movement or orbital overlapping.
    4. **Graphs, Trends & Exceptions:** Identify all graphs. Explain the relationship between the axes. Specifically, point out and explain any 'Exceptions' or 'Dips/Peaks' in the trends (e.g., anomalies in melting/boiling points).
    5. **Problem Solving Shortcuts:** If the slides contain any special techniques or shortcuts for fast calculation, list them clearly.
    6. **Comparative Tables:** Create Markdown tables to compare related topics (e.g., Diamond vs Graphite, Strong vs Weak Ligands).
    7. **PYQ Context:** Based on the 'Importance Table' in the slides or general knowledge, list which topics are most frequent in BUET/RUET/KUET exams.

    Constraint: Do not skip any numerical data or specific reactions. Ensure the explanations match the original slide language (e.g. Bengali).
    
    Output: JSON Array of Note objects.
    `;
    
    const varsityPrompt = `
    Role: You are a University Admission Specialist for DU A-Unit, expert in Physics, Chemistry, and Mathematics.

    Task: Analyze the uploaded document/image (Lecture Slides) and generate a "DU Success Compact Note" that covers 100% of the conceptual depth required for MCQ and concise Written sections.

    Generate a structured note for EACH key topic found in the content.
    
    STRICT LANGUAGE RULE:
    - **DETECT THE LANGUAGE OF THE SOURCE.** (Likely Bengali/Bangla).
    - **WRITE THE EXPLANATIONS IN THE SAME LANGUAGE.**
    - If the slides are in Bengali, the notes MUST be in **Bengali**.
    - If the slides are in English, use English.
    - **HEADERS MUST BE IN BENGALI.**
    - Mathematical terms and formulas should remain in standard scientific notation/English.

    STRICT CONTENT STRUCTURE (Use these EXACT Bengali headers in Markdown for the 'content' field):

    1. **কনসেপচুয়াল MCQ ট্রিক্স:** Identify all Exceptions, Trends, and Comparison Orders (e.g., Ionization Energy, Boiling Point trends, Graph behaviors in Physics, or Function domains in Math). Highlight "What happens if..." scenarios that are common in DU conceptual questions.
    2. **লিখিত অংশের মূল থিওরি:** Summarize key theories, derivations (Physics), or mechanisms (Chemistry) in exactly 2-3 bullet points. Focus on the "Core Logic" (e.g., why a certain result occurs) to fit DU's small written answer space.
    3. **ফর্মুলা ও শর্টকাট ব্যাংক:** Extract all Formulas (Physics), Reactions (Chemistry), and Identities/Shortcuts (Math). Define variables and mention specific conditions/constraints for each formula. Use LaTeX ($...$) for math.
    4. **হাতে-কলমে ক্যালকুলেশন:** Identify numerical problems and provide logic for fast mental calculation. Include unit conversions and constant values (e.g., h, G, R, or unit multipliers like 1 eV/atom = 96.48 kJ/mol).
    5. **মনে রাখার ছন্দ (Mnemonics):** Capture every mnemonic or "Chondo" mentioned in the slides for memorizing lists or complex orders.
    6. **গ্রাফ ও চিত্র বিশ্লেষণ:** Briefly describe the nature of graphs (Linear, Inverse, Parabolic) and what the slope/area represents (especially for Physics).
    7. **সতর্কতা ও গুরুত্ব (🔴):** Mark topics as 'DU MUST-READ', 'MCQ TRAP', or 'WRITTEN CORE'. Use the red circle emoji in the header.

    Constraint: Avoid long paragraphs. Use tables, bold keywords, and bullet points to ensure 100% scannability. Use a mix of Bengali and English terms as used in the lectures.
    
    Output: JSON Array of Note objects.
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: {
                parts: [
                    { inlineData: { mimeType: fileData.mimeType, data: fileData.data } },
                    { text: isVarsity ? varsityPrompt : engineeringPrompt }
                ]
            },
            config: {
                responseMimeType: "application/json",
                responseSchema: schema,
                temperature: 0.2, // Slightly higher than 0.1 to allow for better phrasing but still structured
                topP: 0.95,
                topK: 40
            }
        });

        const generatedNotes = response.text ? safeParseJSON(response.text) as Omit<NoteSection, 'id'>[] : [];
        
        if (generatedNotes.length > 0) {
            const newNotes: NoteSection[] = generatedNotes
            .filter(n => n && typeof n.content === 'string')
            .map((n) => ({
                id: generateUniqueId(),
                ...n,
                content: cleanLatex(n.content)
            } as NoteSection));
            onBatch(newNotes);
        }

    } catch (error) {
        console.error("Error generating notes:", error);
        throw error;
    }
};

// --- MODE 4: Generate Written Questions ---
export const generateWrittenQuestions = async (
    fileData: FileData,
    onBatch: (newQuestions: WrittenQuestion[]) => void,
    signal?: AbortSignal
): Promise<void> => {
    const ai = getClient();
    
    // Schema update: Added 'subject' field to force categorization
    const schema: Schema = {
        type: Type.ARRAY,
        items: {
            type: Type.OBJECT,
            properties: {
                subject: { type: Type.STRING, description: "The Subject Name (e.g. Physics, Chemistry, Math, Biology). Must be detected from context." },
                question: { type: Type.STRING, description: "The written question text. MUST be in the same language as the input PDF." },
                answer: { type: Type.STRING, description: "Detailed step-by-step solution/answer in Markdown." },
                marks: { type: Type.STRING, description: "Estimated marks (e.g. 2.5, 5, 10)" },
                type: { type: Type.STRING, enum: ["Theory", "Math", "Short Note"] }
            },
            required: ["subject", "question", "answer", "marks", "type"]
        }
    };

    // Single robust prompt to handle subject detection and grouping
    const prompt = `
    Role: University Admission Exam Setter (Written Part - DU/BUET Standard).
    
    Task: Analyze the uploaded Document/Image (Exam Paper/Slide).
    1. **Identify ALL distinct subjects** covered in the document (e.g., Physics, Chemistry, Higher Math, Biology, ICT).
    2. For EACH subject found, generate **4-6 High-Quality Written Questions**.
    3. **STRICTLY GROUP/TAG** each question with its correct 'subject'. Do not mix Physics questions under Chemistry.
    
    **Content Rules**:
    - **Language**: STRICTLY MATCH the language of the source text. (If PDF is Bengali, output Bengali. If English, output English).
    - **Mix**: Include both 'Theoretical/Conceptual' (Why/How/Explain) and 'Mathematical/Derivation' questions for each subject.
    - **Standard**: Questions should be at the level of University Admission Tests.
    
    **Formatting**:
    - **LaTeX**: Double escape backslashes ($...$). Use $^\\circ$ for degrees.
    - Output a JSON Array.
    `;

    try {
        if (signal?.aborted) return;

        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: {
              parts: [
                { inlineData: { mimeType: fileData.mimeType, data: fileData.data } },
                { text: prompt }
              ]
            },
            config: {
              responseMimeType: "application/json",
              responseSchema: schema,
              temperature: 0.2
            }
        });

        const generated = response.text ? safeParseJSON(response.text) as Omit<WrittenQuestion, 'id'>[] : [];

        if (generated.length > 0) {
             const newQuestions: WrittenQuestion[] = generated.map(q => ({
                 id: generateUniqueId(),
                 subject: cleanLatex(q.subject || "General"), // Fallback if subject missing
                 question: cleanLatex(q.question),
                 answer: cleanLatex(q.answer),
                 marks: q.marks,
                 type: q.type as any
             }));
             onBatch(newQuestions);
        }
    } catch(e) {
        console.error("Error generating written questions:", e);
        throw e;
    }
};

export const createTutoringChat = (question: Question) => {
    const ai = getClient();
    const systemInstruction = `You are an expert AI tutor.
    Context:
    Q: ${question.text}
    Options: ${question.options.join(', ')}
    Answer: ${question.correctAnswer}

    Task: Explain the solution in Bengali.
    - **Fix any broken Bengali text** in the explanation.
    - Use Markdown & LaTeX ($...$).
    - Do NOT use non-standard LaTeX like \\oldsymbol, \\ext, \\oldtext, \\style, \\extuparrow, xto, ^e.
    - Be concise and encouraging.`;

    return ai.chats.create({
        model: 'gemini-3-flash-preview',
        config: { systemInstruction }
    });
};