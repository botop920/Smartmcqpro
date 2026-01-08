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
    return text
        .replace(/\\t/g, ' ')  // Remove literal \t (common error)
        .replace(/\t/g, ' ')   // Remove tab characters
        .replace(/(\d|\})\s*imes\s*(\d|10)/g, '$1 \\times $2')
        .replace(/\bimes\b/g, '\\times')
        .replace(/extmu/g, '\\mu')
        .replace(/(\d)\s*ext([A-Z])/g, '$1 $2')
        .replace(/ext([A-Z])/g, '$1')
        .replace(/\\?ext\{([^}]+)\}/g, '$1')
        .replace(/\\ext\b/g, '')
        .replace(/(\d)mu\b/g, '$1\\mu')
        .replace(/\^e\s*xto/g, '^\\circ') 
        .replace(/xto/g, '^\\circ')
        .replace(/\^e/g, '^\\circ')
        .replace(/\\text\{o\}/g, '^\\circ')
        .replace(/deg/g, '^\\circ')
        .replace(/\\oldsymbol/g, '')   
        .replace(/\\extuparrow/g, '\\uparrow') 
        .replace(/\\extdownarrow/g, '\\downarrow') 
        .replace(/\\extrightarrow/g, '\\rightarrow') 
        .replace(/\\style/g, '')       
        .replace(/\\oldtext/g, '')     
        .replace(/\{\s*\{\s*(\\uparrow|\\downarrow|\\rightarrow|\\to)\s*\}\s*\}/g, '$1')
        .replace(/\{\s*(\\uparrow|\\downarrow|\\rightarrow|\\to)\s*\}/g, '$1'); 
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
  let retryCount = 0;
  const MAX_RETRIES = 3;

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

  while (hasMore) {
    if (signal?.aborted) break;
    try {
        const lastQuestion = allQuestions.length > 0 ? allQuestions[allQuestions.length - 1] : null;
        const prompt = `Extract MCQs from document. Fix Bengali. Double escape LaTeX. JSON array: q, o, a.`;
        const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: { parts: [{ inlineData: { mimeType: fileData.mimeType, data: fileData.data } }, { text: prompt }] },
          config: { responseMimeType: "application/json", responseSchema: schema }
        });
        const minified = safeParseJSON(response.text) as MinifiedQuestion[];
        const news = minified.map(mq => ({ id: generateUniqueId(), text: cleanLatex(mq.q), options: mq.o.map(opt => cleanLatex(opt)), correctAnswer: cleanLatex(mq.a) }));
        if (news.length === 0) { if (++retryCount >= MAX_RETRIES) hasMore = false; continue; }
        retryCount = 0;
        allQuestions = [...allQuestions, ...news];
        onBatch(news);
        if (allQuestions.length >= 300) hasMore = false;
    } catch (error) { if (++retryCount >= MAX_RETRIES) hasMore = false; }
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
            { label: "Varsity Core", prompt: "Generate 5 MCQs (DU A-Unit standard). Concise, conceptual, 4 options each." }
        ];
    } else {
        // CKRUET or BUET style MCQ
        const standard = examType === 'ckruet' ? "CKRUET (CUET/KUET/RUET)" : "BUET";
        
        // Updated instructions for CKRUET specifically focusing on the 3-4 step solvable in 1-1.5 min logic
        const ckruetConstraint = examType === 'ckruet' ? 
            "Complexity: Questions must require exactly 3-4 intermediate logical or mathematical steps to solve. These steps should be standard but analytical. A well-practiced student should be able to finish each within 60-90 seconds." : 
            "Complexity: Highly analytical and challenging questions suitable for BUET standards.";

        batches = [
            { 
                label: `${examType.toUpperCase()} Analytical`, 
                prompt: `Generate 5 high-standard MCQs for ${standard}. ${ckruetConstraint} Each question is worth 6 marks in value. You MUST provide exactly 5 OPTIONS (A, B, C, D, E).` 
            },
            {
                label: `${examType.toUpperCase()} Math-Heavy`,
                prompt: `Generate 5 challenging Math/Physics MCQs for ${standard}. Focus on multiple formula applications that flow logically in 3-4 steps. Provide exactly 5 OPTIONS.`
            }
        ];
    }

    const schema: Schema = {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            q: { type: Type.STRING },
            o: { type: Type.ARRAY, items: { type: Type.STRING }, description: examType === 'varsity' ? "Exactly 4 options" : "Exactly 5 options (Engineering Standard)" },
            a: { type: Type.STRING }
          },
          required: ["q", "o", "a"]
        }
    };

    for (const batch of batches) {
        if (signal?.aborted) break;
        try {
            const prompt = `Expert Exam Setter for ${examType.toUpperCase()} Admission. 
            Task: ${batch.prompt}. 
            Source Context: Use the provided document/slides.
            Strictest Requirements: 
            - Language: Bengali. 
            - Options: ${examType === 'varsity' ? "4" : "5"}.
            - Math Rendering: Use Double Escaped LaTeX ($...$).
            - Tone: Formal academic Bengali.
            Return ONLY a JSON array.`;

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
    const prompt = `Generate structured revision notes for ${examType.toUpperCase()} admission. Use Bengali markdown. Focus on core concepts and traps.`;
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
    const schema: Schema = {
        type: Type.ARRAY,
        items: {
            type: Type.OBJECT,
            properties: { subject: { type: Type.STRING }, question: { type: Type.STRING }, answer: { type: Type.STRING }, marks: { type: Type.STRING }, type: { type: Type.STRING, enum: ["Theory", "Math", "Short Note"] } },
            required: ["subject", "question", "answer", "marks", "type"]
        }
    };
    const prompt = `Generate ${examType.toUpperCase()} standard written questions. Must have detailed step-by-step model solutions in Bengali. JSON array.`;
    const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: { parts: [{ inlineData: { mimeType: fileData.mimeType, data: fileData.data } }, { text: prompt }] },
        config: { responseMimeType: "application/json", responseSchema: schema }
    });
    const generated = safeParseJSON(response.text) as Omit<WrittenQuestion, 'id'>[];
    onBatch(generated.map(q => ({ id: generateUniqueId(), ...q, subject: cleanLatex(q.subject || "General"), question: cleanLatex(q.question), answer: cleanLatex(q.answer) })));
};

export const createTutoringChat = (question: Question) => {
    const ai = getClient();
    return ai.chats.create({
        model: 'gemini-3-flash-preview',
        config: { systemInstruction: `Expert AI tutor. Explain solution in Bengali for: ${question.text}. Use LaTeX ($...$).` }
    });
};