import React, { useState, useEffect, useMemo, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  onAuthStateChanged,
  signInWithCustomToken
} from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  onSnapshot, 
  addDoc, 
  deleteDoc, 
  doc 
} from 'firebase/firestore';
import { 
  Wallet, 
  Mic, 
  Plus, 
  Trash2, 
  PieChart, 
  ArrowDownCircle, 
  ArrowUpCircle, 
  Loader2, 
  User,
  Calendar,
  FileText,
  Sparkles,
  Users,
  MessageCircle,
  X,
  Send
} from 'lucide-react';

// --- FIREBASE INITIALIZATION ---
// Použijeme konfiguráciu náhľadu (aby to fungovalo tu v okne), 
// ale ak si kód stiahnete, automaticky sa použije vaša konfigurácia.
const isCanvas = typeof __firebase_config !== 'undefined';
const firebaseConfig = isCanvas ? JSON.parse(__firebase_config) : {
  apiKey: "AIzaSyBE28q-SzULErxz_kObGV4npeN62S5PVg4",
  authDomain: "rodinny-rozpocet-a0839.firebaseapp.com",
  projectId: "rodinny-rozpocet-a0839",
  storageBucket: "rodinny-rozpocet-a0839.firebasestorage.app",
  messagingSenderId: "493212511541",
  appId: "1:493212511541:web:1efa3a4ff1e005eb9a307c"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : "rodinny-rozpocet-app";

// --- GEMINI API HELPERS ---
const API_KEY = ""; // Prostredie poskytne kľúč automaticky
const GEMINI_MODEL = "gemini-2.5-flash-preview-09-2025";

const callGemini = async (prompt, inlineData = null) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${API_KEY}`;
  
  const parts = [{ text: prompt }];
  if (inlineData) {
    parts.push({ inlineData });
  }

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.2, // Nízka teplota pre faktické odpovede
    }
  };

  let delay = 1000;
  for (let i = 0; i < 5; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Prázdna odpoveď od AI");
      
      return text;
    } catch (err) {
      console.error(`Attempt ${i + 1} failed:`, err);
      if (i === 4) throw err;
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
};

const extractJSON = (text) => {
  try {
    const start = text.indexOf('{');
    const startArr = text.indexOf('[');
    const end = text.lastIndexOf('}');
    const endArr = text.lastIndexOf(']');
    
    let jsonStr = text;
    if (startArr !== -1 && endArr !== -1 && (start === -1 || startArr < start)) {
       jsonStr = text.substring(startArr, endArr + 1);
    } else if (start !== -1 && end !== -1) {
       jsonStr = text.substring(start, end + 1);
    }
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse JSON:", text);
    throw new Error("Nepodarilo sa spracovať dáta z AI.");
  }
};

// --- PROJECTION HELPER ---
const getTransactionsForMonth = (txs, targetMonth, mode) => {
  const projected = [];
  const [year, month] = targetMonth.split('-');
  const maxDays = new Date(year, month, 0).getDate();

  txs.forEach(t => {
    // Filter podľa vlastníka
    if (mode !== 'spolocne' && (t.owner || 'spolocne') !== mode) return;

    const txMonth = t.date.slice(0, 7);
    
    if (t.regularity === 'regular') {
      // Zahrnie pravidelné platby z aktuálneho a VŠETKÝCH predchádzajúcich mesiacov
      if (txMonth <= targetMonth) {
        let day = parseInt(t.date.slice(8, 10), 10);
        if (day > maxDays) day = maxDays; // Ošetrenie konca mesiaca (napr. 31. -> 28. feb)
        const dayStr = day.toString().padStart(2, '0');
        
        projected.push({
          ...t,
          date: `${targetMonth}-${dayStr}`,
          originalDate: t.date // Uchováme si pôvodný dátum v dátach
        });
      }
    } else {
      // Nepravidelné platby sa musia zhodovať presne s mesiacom
      if (txMonth === targetMonth) {
        projected.push(t);
      }
    }
  });
  
  // Zoradenie podľa nového (premietnutého) dátumu
  projected.sort((a, b) => new Date(b.date) - new Date(a.date));
  return projected;
};

export default function App() {
  // --- DATA STATE ---
  const [user, setUser] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading] = useState(true);
  
  // App specific state
  const [memberName, setMemberName] = useState(() => localStorage.getItem('budgetMemberName') || 'Ja');
  const [isEditingName, setIsEditingName] = useState(false);
  
  // Filtering & View state
  const [currentMonth, setCurrentMonth] = useState(new Date().toISOString().slice(0, 7)); // YYYY-MM
  const [viewMode, setViewMode] = useState('spolocne'); // 'spolocne', 'manzel', 'manzelka'
  
  // UI states
  const [showForm, setShowForm] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [aiMessage, setAiMessage] = useState("");
  const [appError, setAppError] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  
  // AI Summary & Chat State
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiSummary, setAiSummary] = useState(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([
    { role: 'ai', text: 'Ahoj! Som váš finančný AI asistent. Spýtajte sa ma čokoľvek o aktuálnom mesiaci (napr. "Môžeme si dovoliť večeru za 50€?").' }
  ]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const chatMessagesEndRef = useRef(null);

  // Form state
  const [formData, setFormData] = useState({
    type: 'expense',
    amount: '',
    category: 'Potraviny',
    description: '',
    regularity: 'irregular',
    date: new Date().toISOString().slice(0, 10),
    owner: 'spolocne'
  });

  const fileInputRef = useRef(null);

  // --- FIREBASE DATA FETCHING ---
  useEffect(() => {
    const initAuth = async () => {
      try {
        if (isCanvas && typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        console.error("Auth error:", err);
        setAppError("Zlyhalo prihlásenie do databázy (Chyba konfigurácie). Skontrolujte, či ste vo Firebase povolili Anonymous prihlásenie.");
        setLoading(false); // Zastavíme loading, aby sme zobrazili chybu
      }
    };
    initAuth();

    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser === null && !loading) {
          // Ak sme mimo načítania a nie je používateľ (zlyhala autha)
          setLoading(false);
      }
    });
    return () => unsubscribeAuth();
  }, [loading]);

  useEffect(() => {
    if (!user) return;

    const transactionsRef = collection(db, 'artifacts', appId, 'public', 'data', 'budget_transactions');
    
    const unsubscribe = onSnapshot(transactionsRef, (snapshot) => {
      const data = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      data.sort((a, b) => new Date(b.date) - new Date(a.date));
      setTransactions(data);
      setLoading(false);
    }, (error) => {
      console.error("Error fetching transactions:", error);
      setAppError("Chyba pri čítaní dát z databázy.");
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user]);

  // Handle Tab Switch
  const handleTabSwitch = (mode) => {
    setViewMode(mode);
    setAiSummary(null); 
    setFormData(prev => ({ ...prev, owner: mode }));
  };

  // --- HANDLERS ---
  const handleNameChange = (e) => {
    const newName = e.target.value;
    setMemberName(newName);
    localStorage.setItem('budgetMemberName', newName);
  };

  const saveTransaction = async (data) => {
    if (!user) return;
    try {
      const transactionsRef = collection(db, 'artifacts', appId, 'public', 'data', 'budget_transactions');
      await addDoc(transactionsRef, {
        ...data,
        amount: parseFloat(data.amount),
        addedBy: memberName,
        createdAt: Date.now()
      });
    } catch (error) {
      console.error("Error adding document: ", error);
      setAppError("Chyba pri ukladaní transakcie.");
    }
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    if (!formData.amount || !formData.description) return;
    await saveTransaction(formData);
    setShowForm(false);
    setFormData({ ...formData, amount: '', description: '' });
  };

  const handleDelete = async (id) => {
    if (!user) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'budget_transactions', id));
      setConfirmDeleteId(null);
    } catch (error) {
      console.error("Error deleting document: ", error);
      setAppError("Chyba pri mazaní položky.");
    }
  };

  // --- DERIVED DATA (FILTERED BY MONTH AND VIEWMODE) ---
  const filteredTransactions = useMemo(() => {
    return getTransactionsForMonth(transactions, currentMonth, viewMode);
  }, [transactions, currentMonth, viewMode]);

  const stats = useMemo(() => {
    return filteredTransactions.reduce((acc, curr) => {
      if (curr.type === 'income') {
        acc.income += curr.amount;
        if (curr.regularity === 'regular') acc.regularIncome += curr.amount;
      } else {
        acc.expense += curr.amount;
        if (curr.regularity === 'regular') acc.regularExpense += curr.amount;
      }
      return acc;
    }, { income: 0, expense: 0, regularIncome: 0, regularExpense: 0 });
  }, [filteredTransactions]);

  const balance = stats.income - stats.expense;

  // --- AI SUMMARY GENERATION ---
  const generateAISummary = async () => {
    setIsAnalyzing(true);
    setAppError("");
    try {
      const currDate = new Date(`${currentMonth}-01`);
      currDate.setMonth(currDate.getMonth() - 1);
      const prevMonthStr = currDate.toISOString().slice(0, 7);

      const currTx = getTransactionsForMonth(transactions, currentMonth, viewMode);
      const prevTx = getTransactionsForMonth(transactions, prevMonthStr, viewMode);

      const prompt = `
        Si rodinný finančný asistent. Analyzuj rozpočet pre dashboard: "${viewMode.toUpperCase()}".
        
        Transakcie za AKTUÁLNY MESIAC (${currentMonth}):
        ${JSON.stringify(currTx.map(e => ({typ: e.type, suma: e.amount, kategoria: e.category, popis: e.description})))}
        
        Transakcie za MINULÝ MESIAC (${prevMonthStr}):
        ${JSON.stringify(prevTx.map(e => ({typ: e.type, suma: e.amount, kategoria: e.category})))}
        
        Zadanie:
        Napíš stručný, priateľský a prehľadný sumár (max 5-6 viet).
        1. Uveď celkové príjmy a celkové výdavky tohto mesiaca.
        2. Porovnaj aktuálne výdavky s minulým mesiacom (či sú vyššie/nižšie).
        3. Vypichni, na akú kategóriu sa minulo NAJVIAC a na akú NAJMENEJ.
        4. Pridaj 1 krátke odporúčanie alebo zhodnotenie.

        Formátuj to ako čistý text, použi zopár odrážok (-) pre prehľadnosť. NEPOUŽÍVAJ markdown znaky ako hviezdicky (**).
      `;

      const responseText = await callGemini(prompt);
      setAiSummary(responseText);
    } catch (error) {
      console.error(error);
      setAppError("Nepodarilo sa vygenerovať AI analýzu.");
    } finally {
      setIsAnalyzing(false);
    }
  };

  // --- AI CHAT ASSISTANT ---
  const handleChatSubmit = async (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const userMessage = chatInput.trim();
    setChatInput("");
    setChatMessages(prev => [...prev, { role: 'user', text: userMessage }]);
    setIsChatLoading(true);

    try {
      // Pripravíme zjednodušený kontext o výdavkoch pre LLM
      const contextData = filteredTransactions.map(t => 
        `${t.type === 'expense' ? '-' : '+'}${t.amount}€ (${t.category}: ${t.description})`
      ).join(', ');

      const prompt = `
        Si priateľský, empatický a inteligentný rodinný finančný poradca. 
        Máš prístup k aktuálnemu rozpočtu používateľa za tento mesiac pre dashboard "${viewMode}".
        
        KONTEX O ROZPOČTE (mesiac ${currentMonth}):
        Aktuálny zostatok: ${balance.toFixed(2)}€
        Celkové príjmy: ${stats.income.toFixed(2)}€
        Celkové výdavky: ${stats.expense.toFixed(2)}€
        Zoznam všetkých transakcií (kladné sú príjmy, záporné výdavky): [${contextData || "Žiadne transakcie zatiaľ."}]

        Používateľ sa ťa pýta nasledujúcu otázku: "${userMessage}"

        Tvoja úloha: 
        Odpovedz na otázku používateľa na základe týchto dát. Buď stručný, nápomocný a konverzačný. Odpovedaj v slovenčine. Ak sa pýta, či si môže niečo dovoliť, zohľadni aktuálny zostatok a celkové výdavky. Odpovedz v 2-4 vetách.
      `;

      const aiReply = await callGemini(prompt);
      setChatMessages(prev => [...prev, { role: 'ai', text: aiReply }]);
    } catch (error) {
      console.error(error);
      setChatMessages(prev => [...prev, { role: 'ai', text: 'Prepáčte, vyskytol sa problém so spojením s AI. Skúste to o chvíľu.' }]);
    } finally {
      setIsChatLoading(false);
    }
  };

  // Scroll to bottom of chat
  useEffect(() => {
    if (chatMessagesEndRef.current) {
      chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatOpen]);


  // --- AI VOICE INPUT ---
  const startVoiceInput = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setAppError("Váš prehliadač nepodporuje rozpoznávanie reči. Skúste Google Chrome.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'sk-SK';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      setIsListening(true);
      setAiMessage("Počúvam... (napr. 'Dnes som minul 20 eur na benzín')");
    };

    recognition.onresult = async (event) => {
      const transcript = event.results[0][0].transcript;
      setIsListening(false);
      processAIInput(transcript);
    };

    recognition.onerror = (event) => {
      console.error("Speech recognition error", event.error);
      setIsListening(false);
      setAiMessage("");
      setAppError("Chyba pri počúvaní. Skúste znova.");
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.start();
  };

  const processAIInput = async (text) => {
    setIsProcessingAI(true);
    setAiMessage(`Spracovávam: "${text}"...`);
    
    try {
      const today = new Date().toISOString().slice(0, 10);
      const prompt = `
        Si finančný asistent. Používateľ povedal túto vetu: "${text}".
        Extrahuj údaje o transakcii do JSON formátu:
        - "type": "income" alebo "expense"
        - "amount": číslo (suma, musí byť kladné číslo)
        - "category": (Potraviny, Bývanie, Doprava, Zdravie, Zábava, Oblečenie, Výplata, Iné)
        - "description": krátky výstižný popis
        - "regularity": "regular" alebo "irregular"
        - "owner": urč komu platba patrí na základe kontextu. Ak nevieš, použi: "${viewMode}". (Možnosti: "manzel", "manzelka", "spolocne")
        - "date": dátum v tvare YYYY-MM-DD. Ak používateľ nepovedal kedy, použi: ${today}.

        Vráť IBA platný JSON objekt, nič iné.
      `;

      const aiResponse = await callGemini(prompt);
      const parsedData = extractJSON(aiResponse);
      
      await saveTransaction(parsedData);
      setAiMessage("Transakcia úspešne pridaná!");
      setTimeout(() => setAiMessage(""), 3000);
      
    } catch (error) {
      console.error(error);
      setAiMessage("");
      setAppError("Nepodarilo sa spracovať hlasový vstup.");
    } finally {
      setIsProcessingAI(false);
    }
  };

  // --- AI FILE/PDF SCANNING ---
  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsProcessingAI(true);
    setAiMessage("Analyzujem dokument (môže to chvíľu trvať)...");

    try {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64String = reader.result.split(',')[1];
        const mimeType = file.type;

        const prompt = `
          Si finančný analytik. Extrahuj VŠETKY transakcie. 
          Vráť pole JSON objektov:
          - "type": "income" alebo "expense"
          - "amount": číslo
          - "category": (Potraviny, Bývanie, Doprava, Zdravie, Zábava, Oblečenie, Výplata, Iné)
          - "description": popis transakcie
          - "regularity": "regular" alebo "irregular"
          - "owner": "${viewMode}"
          - "date": dátum (YYYY-MM-DD). Predvolený: ${new Date().toISOString().slice(0, 10)}.

          Vráť IBA platné JSON pole, napríklad: [{"type": "expense", "amount": 15.5, ...}].
        `;

        const inlineData = { mimeType: mimeType, data: base64String };

        try {
          const aiResponse = await callGemini(prompt, inlineData);
          const parsedDataArr = extractJSON(aiResponse);
          
          if (Array.isArray(parsedDataArr)) {
            let addedCount = 0;
            for (const item of parsedDataArr) {
              if (item.amount && item.description) {
                await saveTransaction(item);
                addedCount++;
              }
            }
            setAiMessage(`Úspešne pridaných ${addedCount} transakcií!`);
          } else {
             await saveTransaction(parsedDataArr);
             setAiMessage("Úspešne pridaná 1 transakcia!");
          }
        } catch (apiError) {
           console.error("API error:", apiError);
           setAppError("Súbor sa nepodarilo analyzovať.");
           setAiMessage("");
        }
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error(error);
      setAiMessage("");
      setAppError("Nastala chyba pri čítaní súboru.");
    } finally {
      setIsProcessingAI(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // --- RENDERING ---
  if (loading || !user) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        {appError ? (
          <div className="bg-rose-50 text-rose-700 p-6 rounded-2xl max-w-md text-center border border-rose-200 shadow-sm">
            <h2 className="font-bold mb-3 text-lg">Nastala chyba</h2>
            <p className="text-sm">{appError}</p>
          </div>
        ) : (
          <>
            <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
            <span className="ml-3 mt-4 text-slate-600 font-medium">Načítavam rozpočet...</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-100 font-sans text-slate-800 pb-20 relative overflow-x-hidden">
      
      {/* HEADER */}
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 py-4 flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-100 rounded-xl text-indigo-600">
              <Wallet className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold text-slate-800">Rodinný Rozpočet</h1>
          </div>
          
          <div className="flex items-center gap-3 bg-slate-50 px-4 py-2 rounded-full border border-slate-200">
            <User className="w-4 h-4 text-slate-500" />
            <span className="text-sm text-slate-500">Zapisuje:</span>
            {isEditingName ? (
              <input 
                autoFocus
                type="text" 
                value={memberName}
                onChange={handleNameChange}
                onBlur={() => setIsEditingName(false)}
                onKeyDown={(e) => e.key === 'Enter' && setIsEditingName(false)}
                className="text-sm font-semibold bg-white border border-indigo-300 rounded px-2 py-0.5 w-24 outline-none focus:ring-2 focus:ring-indigo-500"
              />
            ) : (
              <button 
                onClick={() => setIsEditingName(true)}
                className="text-sm font-bold text-indigo-600 hover:text-indigo-800 cursor-pointer"
              >
                {memberName}
              </button>
            )}
          </div>
        </div>
        
        {/* DASHBOARD TABS */}
        <div className="max-w-4xl mx-auto px-4 pt-2 pb-0">
          <div className="flex gap-2 border-b border-slate-200">
             <button 
               onClick={() => handleTabSwitch('spolocne')}
               className={`pb-3 px-4 text-sm font-bold transition-colors border-b-2 flex items-center gap-2 ${viewMode === 'spolocne' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
             >
               <Users className="w-4 h-4" /> Spoločne
             </button>
             <button 
               onClick={() => handleTabSwitch('manzel')}
               className={`pb-3 px-4 text-sm font-bold transition-colors border-b-2 flex items-center gap-2 ${viewMode === 'manzel' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
             >
               <User className="w-4 h-4" /> Manžel
             </button>
             <button 
               onClick={() => handleTabSwitch('manzelka')}
               className={`pb-3 px-4 text-sm font-bold transition-colors border-b-2 flex items-center gap-2 ${viewMode === 'manzelka' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
             >
               <User className="w-4 h-4" /> Manželka
             </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        
        {/* FILTERS & MONTH SELECTION */}
        <div className="flex justify-between items-center bg-white p-3 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex items-center gap-3 px-2">
            <Calendar className="w-5 h-5 text-indigo-500" />
            <div>
              <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-0.5">Sledovaný mesiac</p>
              <input 
                type="month" 
                value={currentMonth}
                onChange={(e) => {
                  setCurrentMonth(e.target.value);
                  setAiSummary(null); 
                }}
                className="font-bold text-slate-800 bg-transparent focus:outline-none cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* ERROR BANNER */}
        {appError && (
          <div className="bg-rose-50 border border-rose-200 text-rose-700 px-4 py-3 rounded-xl flex justify-between items-center shadow-sm">
            <span className="font-medium text-sm">{appError}</span>
            <button onClick={() => setAppError("")} className="text-rose-500 hover:text-rose-800 font-bold px-2 text-lg leading-none">&times;</button>
          </div>
        )}

        {/* STATS WIDGETS */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
            <div className="flex items-center gap-3 text-emerald-600 mb-2">
              <ArrowDownCircle className="w-5 h-5" />
              <h3 className="font-semibold">Príjmy</h3>
            </div>
            <p className="text-2xl font-bold text-slate-800">{stats.income.toFixed(2)} €</p>
            <p className="text-xs text-slate-500 mt-1">Z toho pravidelné: {stats.regularIncome.toFixed(2)} €</p>
          </div>
          
          <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-100">
            <div className="flex items-center gap-3 text-rose-500 mb-2">
              <ArrowUpCircle className="w-5 h-5" />
              <h3 className="font-semibold">Výdavky</h3>
            </div>
            <p className="text-2xl font-bold text-slate-800">{stats.expense.toFixed(2)} €</p>
            <p className="text-xs text-slate-500 mt-1">Z toho pravidelné: {stats.regularExpense.toFixed(2)} €</p>
          </div>

          <div className={`p-5 rounded-2xl shadow-sm border ${balance >= 0 ? 'bg-indigo-50 border-indigo-100' : 'bg-orange-50 border-orange-100'}`}>
            <div className="flex items-center gap-3 text-slate-600 mb-2">
              <PieChart className="w-5 h-5" />
              <h3 className="font-semibold">Zostatok</h3>
            </div>
            <p className={`text-2xl font-bold ${balance >= 0 ? 'text-indigo-700' : 'text-orange-600'}`}>
              {balance > 0 ? '+' : ''}{balance.toFixed(2)} €
            </p>
            <p className="text-xs text-slate-500 mt-1">Za zvolený mesiac</p>
          </div>
        </div>

        {/* AI SUMMARY WIDGET */}
        <div className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h3 className="font-bold text-slate-800 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-500" />
                AI Analýza Mesiaca
              </h3>
              <p className="text-xs text-slate-500 mt-1">Zhodnotenie výdavkov a porovnanie s predchádzajúcim mesiacom.</p>
            </div>
            <button 
              onClick={generateAISummary} 
              disabled={isAnalyzing} 
              className="bg-amber-100 hover:bg-amber-200 text-amber-800 font-semibold py-2 px-4 rounded-xl text-sm transition-colors flex items-center gap-2 whitespace-nowrap"
            >
              {isAnalyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
              {isAnalyzing ? "Generujem..." : "Vygenerovať sumár"}
            </button>
          </div>
          
          {aiSummary && (
             <div className="mt-4 bg-amber-50 p-4 rounded-xl border border-amber-100 text-sm text-slate-700 whitespace-pre-wrap leading-relaxed shadow-inner">
               {aiSummary}
             </div>
          )}
        </div>

        {/* AI STATUS MESSAGES */}
        {(isListening || isProcessingAI || aiMessage) && (
          <div className="bg-indigo-600 text-white rounded-xl p-4 flex items-center justify-center gap-3 shadow-md animate-pulse">
            {(isListening || isProcessingAI) && <Loader2 className="w-5 h-5 animate-spin" />}
            {isListening && <Mic className="w-5 h-5 animate-bounce" />}
            <span className="font-medium">{aiMessage}</span>
          </div>
        )}

        {/* ACTION BUTTONS */}
        <div className="flex flex-wrap gap-3">
          <button 
            onClick={() => setShowForm(!showForm)}
            className="flex-1 min-w-[140px] flex items-center justify-center gap-2 bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-slate-700 py-3 px-4 rounded-xl font-medium transition-colors"
          >
            <Plus className="w-5 h-5 text-indigo-500" />
            Manuálne
          </button>
          
          <button 
            onClick={startVoiceInput}
            disabled={isListening || isProcessingAI}
            className={`flex-1 min-w-[140px] flex items-center justify-center gap-2 text-white py-3 px-4 rounded-xl font-medium transition-colors shadow-sm ${
              isListening ? 'bg-rose-500' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
          >
            <Mic className="w-5 h-5" />
            Hlasom
          </button>

          <label className="flex-1 min-w-[140px] flex items-center justify-center gap-2 bg-white border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50 text-slate-700 py-3 px-4 rounded-xl font-medium transition-colors cursor-pointer">
            <FileText className="w-5 h-5 text-indigo-500" />
            Výpis / Blok
            <input 
              type="file" 
              accept="image/*,application/pdf" 
              className="hidden" 
              onChange={handleFileUpload}
              ref={fileInputRef}
              disabled={isProcessingAI}
            />
          </label>
        </div>

        {/* MANUAL ENTRY FORM */}
        {showForm && (
          <div className="bg-white p-6 rounded-2xl shadow-lg border border-slate-200 transform transition-all">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Plus className="w-5 h-5 text-indigo-500" />
              Nová transakcia
            </h3>
            <form onSubmit={handleFormSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              
              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500 uppercase">Typ</label>
                <div className="flex rounded-lg overflow-hidden border border-slate-200 bg-slate-50 p-1">
                  <button type="button" onClick={() => setFormData({...formData, type: 'expense'})} className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${formData.type === 'expense' ? 'bg-white shadow-sm text-rose-600' : 'text-slate-500 hover:bg-slate-100'}`}>Výdavok</button>
                  <button type="button" onClick={() => setFormData({...formData, type: 'income'})} className={`flex-1 py-1.5 text-sm font-medium rounded-md transition-colors ${formData.type === 'income' ? 'bg-white shadow-sm text-emerald-600' : 'text-slate-500 hover:bg-slate-100'}`}>Príjem</button>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500 uppercase">Vlastník záznamu</label>
                <select value={formData.owner} onChange={(e) => setFormData({...formData, owner: e.target.value})} className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 outline-none bg-slate-50 font-medium">
                  <option value="spolocne">Spoločný fond / Všetci</option>
                  <option value="manzel">Manžel</option>
                  <option value="manzelka">Manželka</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500 uppercase">Suma (€)</label>
                <input required type="number" step="0.01" min="0" value={formData.amount} onChange={(e) => setFormData({...formData, amount: e.target.value})} className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="0.00" />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500 uppercase">Popis</label>
                <input required type="text" value={formData.description} onChange={(e) => setFormData({...formData, description: e.target.value})} className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="Napr. Nákup Tesco" />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500 uppercase">Kategória</label>
                <select value={formData.category} onChange={(e) => setFormData({...formData, category: e.target.value})} className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 outline-none">
                  {formData.type === 'expense' ? (
                    <>
                      <option>Potraviny</option>
                      <option>Bývanie a energie</option>
                      <option>Doprava</option>
                      <option>Zdravie a drogéria</option>
                      <option>Zábava a reštaurácie</option>
                      <option>Oblečenie</option>
                      <option>Iné výdavky</option>
                    </>
                  ) : (
                    <>
                      <option>Výplata</option>
                      <option>Prídavky / Bonusy</option>
                      <option>Dary</option>
                      <option>Iné príjmy</option>
                    </>
                  )}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500 uppercase">Dátum</label>
                <input required type="date" value={formData.date} onChange={(e) => setFormData({...formData, date: e.target.value})} className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-slate-500 uppercase">Pravidelnosť</label>
                <select value={formData.regularity} onChange={(e) => setFormData({...formData, regularity: e.target.value})} className="w-full border border-slate-300 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 outline-none">
                  <option value="irregular">Nepravidelné (bežný nákup)</option>
                  <option value="regular">Pravidelné (trvalý príkaz, nájom, mzda)</option>
                </select>
              </div>

              <div className="md:col-span-2 pt-2 flex gap-3">
                <button type="submit" className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 rounded-lg transition-colors">
                  Uložiť
                </button>
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-lg transition-colors">
                  Zrušiť
                </button>
              </div>
            </form>
          </div>
        )}

        {/* TRANSACTIONS LIST */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
            <h2 className="font-bold text-slate-800">
              Prehľad transakcií {viewMode !== 'spolocne' && `(${viewMode})`}
            </h2>
            <span className="text-xs font-medium text-slate-500 bg-white px-2 py-1 rounded-full border border-slate-200">
              {filteredTransactions.length} záznamov
            </span>
          </div>
          
          <div className="overflow-x-auto">
            {filteredTransactions.length === 0 ? (
              <div className="p-8 text-center text-slate-500 flex flex-col items-center justify-center">
                <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3">
                  <Wallet className="w-8 h-8 text-slate-300" />
                </div>
                <p>V tomto mesiaci nemáte pre tento dashboard žiadne záznamy.</p>
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-100 text-xs uppercase text-slate-500 font-semibold">
                    <th className="p-3 pl-5 whitespace-nowrap">Dátum</th>
                    <th className="p-3">Popis & Kategória</th>
                    <th className="p-3">Vlastník</th>
                    <th className="p-3 text-right">Suma</th>
                    <th className="p-3 pr-5 w-10"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50 text-sm">
                  {filteredTransactions.map((t) => (
                    <tr key={t.id} className="hover:bg-slate-50/50 transition-colors group">
                      <td className="p-3 pl-5 text-slate-500 whitespace-nowrap">
                        {new Date(t.date).toLocaleDateString('sk-SK')}
                      </td>
                      <td className="p-3">
                        <div className="font-medium text-slate-800">{t.description}</div>
                        <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                          {t.category} 
                          {t.regularity === 'regular' && (
                            <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-400 ml-1" title="Pravidelná platba"></span>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${t.owner === 'manzel' ? 'bg-blue-50 text-blue-600' : t.owner === 'manzelka' ? 'bg-pink-50 text-pink-600' : 'bg-slate-100 text-slate-600'}`}>
                          {t.owner === 'manzel' ? 'Manžel' : t.owner === 'manzelka' ? 'Manželka' : 'Spoločné'}
                        </span>
                      </td>
                      <td className={`p-3 text-right font-bold whitespace-nowrap ${t.type === 'income' ? 'text-emerald-600' : 'text-slate-800'}`}>
                        {t.type === 'income' ? '+' : '-'}{t.amount.toFixed(2)} €
                      </td>
                      <td className="p-3 pr-5 text-right w-28">
                        {confirmDeleteId === t.id ? (
                          <div className="flex flex-col items-end gap-1 bg-rose-50 px-2 py-1 rounded-lg border border-rose-100">
                            {t.regularity === 'regular' && <span className="text-[9px] text-rose-500 font-medium leading-none uppercase text-right w-full">Zmaže celú sériu</span>}
                            <div className="flex items-center justify-end gap-2 w-full">
                              <button onClick={() => handleDelete(t.id)} className="text-rose-600 hover:text-rose-800 font-bold text-xs px-1">Áno</button>
                              <span className="text-rose-300">|</span>
                              <button onClick={() => setConfirmDeleteId(null)} className="text-slate-500 hover:text-slate-700 font-medium text-xs px-1">Nie</button>
                            </div>
                          </div>
                        ) : (
                          <button 
                            onClick={() => setConfirmDeleteId(t.id)}
                            className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded-lg opacity-0 group-hover:opacity-100 transition-all focus:opacity-100 inline-flex"
                            title="Vymazať"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </main>

      {/* --- AI CHATBOT WIDGET --- */}
      <div className="fixed bottom-6 right-6 z-50">
        {isChatOpen ? (
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-80 sm:w-96 flex flex-col overflow-hidden animate-in slide-in-from-bottom-5 duration-200" style={{ height: '450px' }}>
            {/* Chat Header */}
            <div className="bg-indigo-600 text-white p-4 flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-amber-300" />
                <h3 className="font-bold">Finančný Poradca</h3>
              </div>
              <button onClick={() => setIsChatOpen(false)} className="text-indigo-200 hover:text-white transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {/* Chat Messages */}
            <div className="flex-1 p-4 overflow-y-auto bg-slate-50 flex flex-col gap-3">
              {chatMessages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
                    msg.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-br-sm' 
                      : 'bg-white border border-slate-200 text-slate-700 rounded-bl-sm shadow-sm'
                  }`}>
                    {msg.text}
                  </div>
                </div>
              ))}
              {isChatLoading && (
                <div className="flex justify-start">
                  <div className="bg-white border border-slate-200 text-slate-700 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm flex gap-1 items-center">
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce"></span>
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></span>
                    <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></span>
                  </div>
                </div>
              )}
              <div ref={chatMessagesEndRef} />
            </div>

            {/* Chat Input */}
            <form onSubmit={handleChatSubmit} className="p-3 bg-white border-t border-slate-100 flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Spýtajte sa na váš rozpočet..."
                className="flex-1 border border-slate-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                disabled={isChatLoading}
              />
              <button 
                type="submit" 
                disabled={!chatInput.trim() || isChatLoading}
                className="bg-indigo-600 hover:bg-indigo-700 text-white p-2 rounded-xl disabled:opacity-50 transition-colors flex items-center justify-center"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        ) : (
          <button 
            onClick={() => setIsChatOpen(true)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white p-4 rounded-full shadow-xl hover:shadow-2xl transition-all hover:-translate-y-1 flex items-center justify-center"
          >
            <MessageCircle className="w-6 h-6" />
          </button>
        )}
      </div>

    </div>
  );
}