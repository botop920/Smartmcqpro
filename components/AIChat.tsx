import React, { useState, useEffect, useRef } from 'react';
import { Chat } from "@google/genai";
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { ChatMessage, Question } from '../types';
import { createTutoringChat } from '../services/geminiService';
import { SendIcon, SparklesIcon } from './Icons';

interface AIChatProps {
  question: Question;
}

const AIChat: React.FC<AIChatProps> = ({ question }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const chatSession = useRef<Chat | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    // block: 'nearest' prevents the whole page from jumping if the chat is partly out of view
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Initialize chat when component mounts or question changes
  useEffect(() => {
    const initChat = async () => {
      setIsLoading(true);
      setMessages([]); // Clear previous messages
      try {
        chatSession.current = createTutoringChat(question);
        
        // Initial explanation prompt
        const initialPrompt = "Explain the solution in Bengali. Use LaTeX formatting ($...$) for all math formulas.";
        
        await streamResponse(initialPrompt);
      } catch (error) {
        console.error("Failed to init chat", error);
        setMessages(prev => [...prev, { role: 'model', text: "AI টিউটর সংযোগ বিচ্ছিন্ন হয়েছে।" }]);
      } finally {
        setIsLoading(false);
      }
    };

    initChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question]);

  const streamResponse = async (prompt: string) => {
    if (!chatSession.current) return;

    setIsLoading(true);
    // Add placeholder for model response
    setMessages(prev => [...prev, { role: 'model', text: '', isStreaming: true }]);

    try {
      const result = await chatSession.current.sendMessageStream({ message: prompt });
      
      let fullText = '';
      for await (const chunk of result) {
        const text = chunk.text || '';
        fullText += text;
        
        setMessages(prev => {
          const newHistory = [...prev];
          const lastMsg = newHistory[newHistory.length - 1];
          if (lastMsg.role === 'model' && lastMsg.isStreaming) {
            lastMsg.text = fullText;
          }
          return newHistory;
        });
      }
      
      // Finalize message
      setMessages(prev => {
         const newHistory = [...prev];
         const lastMsg = newHistory[newHistory.length - 1];
         lastMsg.isStreaming = false;
         return newHistory;
      });

    } catch (e) {
      console.error(e);
      setMessages(prev => [...prev, { role: 'model', text: 'উত্তর পেতে সমস্যা হয়েছে।' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    
    const userText = input.trim();
    setInput('');
    setMessages(prev => [...prev, { role: 'user', text: userText }]);
    
    await streamResponse(userText);
  };

  return (
    <div className="mt-8 pt-6 border-t border-neutral-800 animate-fade-in">
      <div className="bg-surface rounded-2xl border border-neutral-800 overflow-hidden shadow-2xl">
        
        {/* Header */}
        <div className="bg-neutral-900 p-4 border-b border-neutral-800 flex items-center gap-3">
          <div className="p-1.5 bg-red-500/10 rounded-lg">
             <span className="text-red-400"><SparklesIcon /></span>
          </div>
          <div>
              <h3 className="font-bold text-base text-white">AI টিউটর</h3>
              <p className="text-xs text-secondary">তাৎক্ষণিক ধারণা এবং ব্যাখ্যা</p>
          </div>
        </div>

        {/* Messages Area */}
        <div className="max-h-[400px] overflow-y-auto p-5 space-y-6 scroll-smooth custom-scrollbar bg-black/40">
          {messages.map((msg, idx) => (
            <div 
              key={idx} 
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div 
                className={`max-w-[95%] md:max-w-[85%] rounded-2xl p-4 text-base leading-relaxed shadow-lg ${
                  msg.role === 'user' 
                    ? 'bg-red-600 text-white rounded-tr-sm' 
                    : 'bg-neutral-900 text-gray-200 border border-neutral-800 rounded-tl-sm'
                }`}
              >
                {/* React Markdown Component */}
                <div className="markdown-content">
                  <ReactMarkdown 
                      remarkPlugins={[remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                  >
                      {msg.text}
                  </ReactMarkdown>
                </div>
                
                {msg.isStreaming && <span className="inline-block w-2 h-4 ml-1 bg-red-400 animate-pulse align-middle rounded-full"></span>}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 bg-neutral-900/50 border-t border-neutral-800">
          <div className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="প্রশ্ন করুন (Ask a follow-up)..."
              disabled={isLoading}
              className="flex-1 bg-neutral-900 border border-neutral-700 rounded-xl px-5 py-3 text-sm text-white focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500/50 transition-all placeholder-neutral-500 font-sans"
            />
            <button 
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="bg-red-600 hover:bg-red-500 disabled:bg-neutral-800 disabled:text-neutral-500 disabled:cursor-not-allowed text-white p-3 rounded-xl transition-all shadow-lg shadow-red-500/20"
            >
              <SendIcon />
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

export default AIChat;