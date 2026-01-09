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
    
    // First, fix literal control character escape errors from Gemini
    let cleaned = text
        .replace(/\\t/g, ' ')  
        .replace(/\t/g, ' ')   
        .replace(/\\n/g, '\n');

    // Fix common missing backslash issues in Gemini's math output
    // This part tries to intelligently add backslashes where Gemini might have missed them
    // but only inside what looks like math contexts or chemistry formulas
    cleaned = cleaned
        .replace(/(\d|\})\s*imes\s*(\d|10)/g, '$1 \\times $2')
        .replace(/\bimes\b/g, '\\times')
        .replace(/extmu/g, '\\mu')
        .replace(/(\d)\s*mu\b/g, '$1\\mu')
        .replace(/\^e\s*xto/g, '^\\circ') 
        .replace(/xto/g, '^\\circ')
        .replace(/\^e/g, '^\\circ')
        .replace(/deg/g, '^\\circ')
        .replace(/\\text\{o\}/g, '^\\circ')
        .replace(/Ksp/g, 'K_{sp}')
        .replace(/Ca\(OH\)2/g, 'Ca(OH)_2')
        .replace(/NaOH/g, 'NaOH');

    // Clean up unnecessary formatting that KaTeX might choke on
    cleaned = cleaned
        .replace(/\\boldsymbol/g, '')   
        .replace(/\\style/g, '')       
        .replace(/\\oldtext/g, '');

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
        const prompt = `Extract ALL MCQs from the document. Format math using LaTeX delimiters like $x^2$. Double check Bengali grammar. JSON array: q, o, a.`;
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
        // If we got a decent amount of questions, we've likely processed the whole file or enough of it
        if (news.length < 5 || allQuestions.length >= 200) hasMore = false;
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
            { label: "Varsity Core", prompt: "Generate high-quality MCQs (DU A-Unit standard). Use Bengali and LaTeX $...$." }
        ];
    } else {
        const standard = examType === 'ckruet' ? "CKRUET (CUET/KUET/RUET)" : "BUET";
        batches = [
            { 
                label: `${examType.toUpperCase()} Standard`, 
                prompt: `Generate 10 highly analytical MCQs for ${standard}. Ensure step-by-step logic. Exactly 5 options.` 
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
            const prompt = `Setter for ${examType.toUpperCase()}. ${batch.prompt}. Math: Wrap EVERY formula in $...$. Return JSON.`;
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
    const prompt = `Generate structured revision notes for ${examType.toUpperCase()}. Use Bengali markdown and LaTeX ($...$).`;
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

    while (hasMore && iteration < 5) {
        if (signal?.aborted) break;
        iteration++;
        
        try {
            // Updated prompt to encourage finding NEW questions that haven't been extracted yet
            const alreadyExtractedList = allExtracted.map(q => q.question.substring(0, 30)).join(', ');
            const prompt = `Act as an expert ${examType.toUpperCase()} Admission Question setter.
            Extract or generate ALL relevant written questions from the source.
            
            STRICT RULES:
            1. Language: Academic Bengali.
            2. Math Rendering: EVERY formula, variable, chemical compound (like Ca(OH)2), or equation MUST be wrapped in single dollar signs $...$. Example: $Ca(OH)_2$ or $x = 5$.
            3. Model Solution: The 'answer' must be a detailed, formatted step-by-step solution.
            4. Pagination: Find questions that are different from these: [${alreadyExtractedList}].
            
            Return a JSON array.`;

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
            
            // If the model returns fewer than 3 questions, it's likely done with the file
            if (generated.length < 3) hasMore = false;
        } catch (error) {
            hasMore = false;
        }
    }
};

export const createTutoringChat = (question: Question) => {
    const ai = getClient();
    return ai.chats.create({
        model: 'gemini-3-flash-preview',
        config: { systemInstruction: `Expert AI tutor. Explain solution in Bengali. Use LaTeX ($...$) for every formula or math term. Be very detailed and structured.` }
    });
};