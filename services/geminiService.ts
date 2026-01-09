import { GoogleGenAI, Type, Schema } from "@google/genai";
import { Question, NoteSection, WrittenQuestion, ExamType } from "../types";

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
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API Key not found. Please set the API_KEY environment variable.");
    return new GoogleGenAI({ apiKey });
}

interface MinifiedQuestion {
    q: string;
    o: string[];
    a: string;
}

const safeParseJSON = (jsonString: string): any[] => {
    try {
        const parsed = JSON.parse(jsonString);
        if (Array.isArray(parsed)) return parsed;
        if (typeof parsed === 'object' && parsed !== null) {
            const values = Object.values(parsed);
            const arrayValue = values.find(v => Array.isArray(v));
            if (arrayValue) return arrayValue as any[];
        }
        return [];
    } catch (error: any) {
        let cleaned = jsonString.trim();
        const firstBracket = cleaned.indexOf('[');
        if (firstBracket !== -1) cleaned = cleaned.substring(firstBracket);
        const lastObjectEnd = cleaned.lastIndexOf('},');
        if (lastObjectEnd !== -1) {
            cleaned = cleaned.substring(0, lastObjectEnd + 1) + ']';
            try { return JSON.parse(cleaned); } catch (e) {}
        }
        return []; 
    }
};

const cleanLatex = (text: any): string => {
    if (typeof text !== 'string') return "";
    
    let cleaned = text
        .replace(/\\t/g, ' ')  
        .replace(/\t/g, ' ')   
        .replace(/\\n/g, '\n');

    // Recovery logic for mangled LaTeX (Gemini often drops backslashes or characters)
    cleaned = cleaned
        // Fix fractions
        .replace(/\\?rac\{/g, '\\frac{')
        .replace(/\brac\{/g, '\\frac{')
        // Fix times/multiplication
        .replace(/\\?imes\b/g, '\\times')
        .replace(/\bimes\b/g, '\\times')
        // Fix mangled units (extkg -> \text{kg}, extm -> \text{m}, etc.)
        .replace(/ext(kg|m|s|min|sec|Watt|hp|W|V|A|K|C|J|N|Pa|Hz|mol|L|g|cm|mm|km)\b/g, '\\text{$1}')
        .replace(/(\d)ext/g, '$1 \\text')
        .replace(/ext\{(.*?)\}/g, '\\text{$1}')
        .replace(/text\{(.*?)\}/g, '\\text{$1}')
        // Fix specific admission test notations
        .replace(/Ksp/g, 'K_{sp}')
        .replace(/Ca\(OH\)2/g, 'Ca(OH)_2')
        .replace(/NaOH/g, 'NaOH')
        .replace(/deg/g, '^\\circ')
        .replace(/\^e\b/g, '^\\circ')
        .replace(/xto/g, '^\\circ');

    // Clean up decorative backslashes that don't belong to any command
    cleaned = cleaned.replace(/\\(?![a-zA-Z{}()\[\]$])/g, '');

    return cleaned;
};

const generateUniqueId = () => Math.floor(Date.now() + Math.random() * 1000000);

interface FileData {
    mimeType: string;
    data: string;
}

export const extractQuestions = async (
    fileData: FileData, 
    onBatch: (newQuestions: Question[]) => void,
    signal?: AbortSignal
): Promise<void> => {
  const ai = getClient();
  let allQuestions: Question[] = [];
  let hasMore = true;
  let iteration = 0;

  const schema: Schema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        q: { type: Type.STRING },
        o: { type: Type.ARRAY, items: { type: Type.STRING } },
        a: { type: Type.STRING }
      },
      required: ["q", "o", "a"]
    }
  };

  while (hasMore && iteration < 10) {
    if (signal?.aborted) break;
    iteration++;
    try {
        const prompt = `Extract every single MCQ from the document. This is iteration ${iteration}. 
        Find questions NOT already extracted.
        Math: Must use proper LaTeX $...$. Use \\frac for fractions and \\text{} for units.
        JSON array: q, o, a.`;
        
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: { parts: [{ inlineData: { mimeType: fileData.mimeType, data: fileData.data } }, { text: prompt }] },
          config: { responseMimeType: "application/json", responseSchema: schema }
        });
        const minified = safeParseJSON(response.text) as MinifiedQuestion[];
        if (minified.length === 0) { hasMore = false; break; }
        
        const news = minified.map(mq => ({ id: generateUniqueId(), text: cleanLatex(mq.q), options: mq.o.map(opt => cleanLatex(opt)), correctAnswer: cleanLatex(mq.a) }));
        allQuestions = [...allQuestions, ...news];
        onBatch(news);
        if (minified.length < 5 || allQuestions.length >= 300) hasMore = false;
    } catch (error) { hasMore = false; }
  }
};

export const generateQuestionsFromSlides = async (
    fileData: FileData,
    onBatch: (newQuestions: Question[]) => void,
    signal?: AbortSignal,
    examType: ExamType = 'varsity'
): Promise<void> => {
    const ai = getClient();
    let batches = [];
    
    if (examType === 'varsity') {
        batches = [
            { label: "Standard", prompt: "Generate as many high-quality MCQs as possible covering the whole document. Use Bengali and proper LaTeX." }
        ];
    } else {
        const standard = examType === 'ckruet' ? "CKRUET (CUET/KUET/RUET)" : "BUET";
        batches = [
            { 
                label: `${examType.toUpperCase()} Standard`, 
                prompt: `Analyze the whole file and generate all possible standard MCQs for ${standard}. Use exactly 5 options.` 
            }
        ];
    }

    const schema: Schema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            q: { type: Type.STRING },
            o: { type: Type.ARRAY, items: { type: Type.STRING } },
            a: { type: Type.STRING }
          },
          required: ["q", "o", "a"]
        }
    };

    for (const batch of batches) {
        if (signal?.aborted) break;
        try {
            const prompt = `${batch.prompt}. STRICT: Use \\frac for fractions, \\text{} for units, and wrap everything in $...$. Bengali language. JSON output.`;
            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: { parts: [{ inlineData: { mimeType: fileData.mimeType, data: fileData.data } }, { text: prompt }] },
                config: { responseMimeType: "application/json", responseSchema: schema }
            });
            const minified = safeParseJSON(response.text) as MinifiedQuestion[];
            if (minified.length > 0) {
                onBatch(minified.map(mq => ({ id: generateUniqueId(), text: cleanLatex(`[${batch.label}] ${mq.q}`), options: mq.o.map(opt => cleanLatex(opt)), correctAnswer: cleanLatex(mq.a) })));
            }
        } catch (error) {}
    }
};

export const generateStudyNotes = async (
    fileData: FileData,
    onBatch: (newNotes: NoteSection[]) => void,
    signal?: AbortSignal,
    examType: ExamType = 'varsity'
): Promise<void> => {
    const ai = getClient();
    const schema: Schema = {
        type: Type.ARRAY,
        items: {
            type: Type.OBJECT,
            properties: { title: { type: Type.STRING }, content: { type: Type.STRING }, importance: { type: Type.STRING, enum: ["High", "Medium", "Normal"] } },
            required: ["title", "content", "importance"]
        }
    };
    const prompt = `Comprehensive notes for ${examType.toUpperCase()}. Bengali. Math in $...$. Use proper LaTeX commands.`;
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: { parts: [{ inlineData: { mimeType: fileData.mimeType, data: fileData.data } }, { text: prompt }] },
        config: { responseMimeType: "application/json", responseSchema: schema }
    });
    const notes = safeParseJSON(response.text) as Omit<NoteSection, 'id'>[];
    onBatch(notes.map(n => ({ id: generateUniqueId(), ...n, content: cleanLatex(n.content) })));
};

export const generateWrittenQuestions = async (
    fileData: FileData,
    onBatch: (newQuestions: WrittenQuestion[]) => void,
    signal?: AbortSignal,
    examType: ExamType = 'buet'
): Promise<void> => {
    const ai = getClient();
    let allExtracted: WrittenQuestion[] = [];
    let hasMore = true;
    let iteration = 0;
    const MAX_ITERATIONS = 15; // Increased significantly to find ALL questions
    
    const schema: Schema = {
        type: Type.ARRAY,
        items: {
            type: Type.OBJECT,
            properties: { 
                subject: { type: Type.STRING }, 
                question: { type: Type.STRING }, 
                answer: { type: Type.STRING }, 
                marks: { type: Type.STRING }, 
                type: { type: Type.STRING, enum: ["Theory", "Math", "Short Note"] } 
            },
            required: ["subject", "question", "answer", "marks", "type"]
        }
    };

    while (hasMore && iteration < MAX_ITERATIONS) {
        if (signal?.aborted) break;
        iteration++;
        
        try {
            const alreadyExtractedList = allExtracted.map(q => q.question.substring(0, 20)).join(', ');
            const prompt = `Extract all WRITTEN questions from the source file. This is iteration ${iteration}.
            Scan the entire document and extract questions NOT in this list: [${alreadyExtractedList}].
            
            STRICT RULES:
            1. Language: Bengali.
            2. LaTeX: Wrap all math in $...$. Use \\frac, \\times, \\text{}, etc. Do NOT skip backslashes.
            3. Detailed Solve: 'answer' must be a full step-by-step markdown solution.
            
            Return a JSON array. If no more questions exist, return an empty array [].`;

            const response = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: { parts: [{ inlineData: { mimeType: fileData.mimeType, data: fileData.data } }, { text: prompt }] },
                config: { responseMimeType: "application/json", responseSchema: schema }
            });
            
            const generated = safeParseJSON(response.text) as Omit<WrittenQuestion, 'id'>[];
            if (generated.length === 0) {
                hasMore = false;
                break;
            }
            
            const news = generated.map(q => ({ 
                id: generateUniqueId(), 
                ...q, 
                subject: cleanLatex(q.subject || "General"), 
                question: cleanLatex(q.question), 
                answer: cleanLatex(q.answer) 
            }));
            
            allExtracted = [...allExtracted, ...news];
            onBatch(news);
            
            // If less than 2 new questions found, we are likely at the end of the file
            if (generated.length < 2) hasMore = false;
        } catch (error) {
            hasMore = false;
        }
    }
};

export const createTutoringChat = (question: Question) => {
    const ai = getClient();
    return ai.chats.create({
        model: 'gemini-3-flash-preview',
        config: { systemInstruction: `Expert Admission Tutor. Bengali language. Use perfect LaTeX ($...$) for every variable, unit, and formula. Explain clearly step by step.` }
    });
};