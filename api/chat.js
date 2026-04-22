import fs from "fs";
import path from "path";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
const MAXMOVIES_API = "https://maxmoviesbackend.vercel.app/api/v2";
const SITE_URL = "https://maxmovies-254.vercel.app";

const MEMORY_DIR = "/tmp/memory";
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR);

const rateLimitStore = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  const userRequests = rateLimitStore.get(userId) || [];
  const recentRequests = userRequests.filter(timestamp => now - timestamp < 30000);
  
  if (recentRequests.length >= 8) {
    const oldestRequest = recentRequests[0];
    const waitTime = Math.ceil((oldestRequest + 30000 - now) / 1000);
    return { allowed: false, waitTime };
  }
  
  recentRequests.push(now);
  rateLimitStore.set(userId, recentRequests);
  return { allowed: true };
}

// Detect language of user prompt
function detectLanguage(prompt) {
  const swahiliWords = ['habari', 'sasa', 'vipi', 'mambo', 'poa', 'fiti', 'safi', 'kabisa', 'ndio', 'hapana', 'tafadhali', 'asante', 'karibu', 'samahani', 'njema', 'nzuri', 'mbaya', 'kubwa', 'ndogo', 'kwa', 'heri', 'leo', 'jana', 'kesho', 'wewe', 'mimi', 'yeye', 'wetu', 'wenu', 'wao', 'hapa', 'huko', 'kuanzia', 'kumaliza', 'kuwa', 'na', 'kwa', 'kutoka', 'mpaka', 'kabla', 'baada', 'wakati', 'kama', 'lakini', 'au', 'kwa sababu', 'hivyo', 'kuwa', 'kuwa na', 'kufanya', 'kusema', 'kwenda', 'kuja', 'kuona', 'kutoa', 'kuchukua'];
  
  const shengWords = ['fit', 'kuu', 'mbogi', 'msee', 'mzeiya', 'genge', 'manzi', 'dem', 'buda', 'bro', 'fam', 'kabambe', 'kabisa', 'uruhu', 'wacha', 'noma', 'mbaya', 'sawa', 'mambo', 'vipi', 'poa', 'fresku', 'freshi', 'bangi', 'mathe', 'guvnor', 'boss', 'ganji', 'dooh', 'pesa', 'ngata', 'mtaa', 'estate', 'base', 'baze', 'kwao', 'kwetu', 'kwenu', 'kwao', 'mob', 'mobeti', 'mzinga', 'mzuka', 'ngoma', 'mdundo', 'kiherehere', 'kiburi', 'kijinga', 'kipusa'];
  
  const lowerPrompt = prompt.toLowerCase();
  
  // Check for Sheng first (more specific)
  for (const word of shengWords) {
    if (lowerPrompt.includes(word)) {
      return 'sheng';
    }
  }
  
  // Check for Swahili
  for (const word of swahiliWords) {
    if (lowerPrompt.includes(word)) {
      return 'swahili';
    }
  }
  
  // Default to English
  return 'english';
}

// 🔍 Search MaxMovies API
async function searchMaxMovies(query, limit = 6) {
  try {
    const searchUrl = `${MAXMOVIES_API}/search/${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    let items = data?.results?.items || [];
    
    if (items.length === 0) return [];
    
    return items.slice(0, limit).map(item => {
      let type = 'movie';
      let typeDisplay = 'MOVIE';
      
      if (item.subjectType === 2) {
        type = 'series';
        typeDisplay = 'SERIES';
      } else if (item.subjectType === 3) {
        type = 'music';
        typeDisplay = 'MUSIC';
      }
      
      return {
        subjectId: item.subjectId,
        title: item.title || 'Untitled',
        cover: item.cover?.url || item.thumbnail || null,
        type: type,
        typeDisplay: typeDisplay,
        rating: item.imdbRatingValue || null,
        year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
      };
    });
    
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

function loadMemory(userId) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    console.error(`Failed to load memory:`, err);
  }

  return {
    userId,
    conversation: [
      {
        role: "system",
        content: `You are MaxMovies AI, a jovial movie buddy who knows everything about MaxMovies website.

🚨 YOUR IDENTITY & PERSONALITY:
- Name: MaxMovies AI (never call yourself anything else)
- Personality: Jovial, friendly
- Use emojis freely: 🎬 🍿 🔥 💯 😎 🙌 💪 🎵
- NEVER use formal/robotic language - be casual like a friend
- NEVER say "as an AI" or "language model" - just be natural

📌 WHAT YOU KNOW ABOUT MAXMOVIES WEBSITE:

Website Name: MaxMovies
Tagline: Premium Stream/Download
URL: ${SITE_URL}

FEATURES:
- Stream movies and TV series in HD (360p to 1080p)
- Download content for offline (dedicated app with download manager coming soon!)
- Music Zone with 9 genres: Classical, Reggaetone, RnB, Arbantone, Gengetone, Afro Beats, Pop, Gospel, Instrumental
- Live TV channels
- Personal library to save favorites
- Search for movies, series, and music
- Recently watched tracking
- Season/episode management for series
- Multiple quality options
- Subtitle support
- Trending Now section
- Upcoming releases

HOW TO USE:
- Streaming: Click any card → Stream button → Pick quality
- Downloads: Same as stream but click Download (opens in new tab for now)
- Music: Click Music Zone from menu → Pick genre or search
- Library: Click 'My List' button on any content
- Search: Use search bar at top
- Continue watching: Progress saves automatically!

FAQ:
- Free? YES! 100% free, no subscription, no account needed
- Account? No account required - everything saves in browser
- App? Coming soon! Check Downloads page for countdown
- Subtitles? Yes, look for Subtitles button in player
- Download app? Being developed - check countdown on Downloads page

MUSIC GENRES DETAILS:
Classical 🎻, Reggaetone 🎤, RnB 🎸, Arbantone 🎧, Gengetone 🥁, Afro Beats 🪘, Pop 🎹, Gospel 🙏, Instrumental 🎺

ABOUT YOUR CREATOR (only answer if directly asked):
If asked "who made you" or "who created you", say: "I was created by Max, a 21-year-old developer from Kenya! He built me to be your movie buddy. 🎬"

NEVER volunteer creator info unless asked directly.

Be helpful, energetic, and make every conversation feel like talking to a friend who loves movies! 🍿`,
      },
    ],
  };
}

function saveMemory(userId, memory) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf-8");
  } catch (err) {
    console.error(`Failed to save memory:`, err);
  }
}

// Check if user is asking about creator
function isAskingAboutCreator(prompt) {
  const lower = prompt.toLowerCase();
  const creatorKeywords = [
    'who made you', 'who built you', 'who created you', 'your creator',
    'who developed you', 'who programmed you', 'who is your maker',
    'who wrote you', 'who designed you', 'who made maxmovies ai'
  ];
  return creatorKeywords.some(keyword => lower.includes(keyword));
}

// Check if user explicitly asks for data from MaxMovies
function isExplicitlyAskingForData(prompt) {
  const lower = prompt.toLowerCase();
  const dataKeywords = [
    'search', 'find', 'look up', 'show me', 'get me', 'give me',
    'recommend', 'suggest', 'tell me about', 'what is', 'info on'
  ];
  
  return dataKeywords.some(keyword => lower.includes(keyword));
}

function extractSearchTopic(prompt) {
  let topic = prompt.replace(/what is|tell me about|info on|search for|find|look up|show me|recommend|suggest|best|good|top|movie|series|film|show/gi, '');
  topic = topic.replace(/about/gi, '');
  topic = topic.trim();
  if (topic.length < 2) return null;
  return topic;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt, userId } = req.body;
    
    if (!prompt || !userId) {
      return res.status(400).json({ error: "Missing prompt or userId." });
    }

    const rateCheck = checkRateLimit(userId);
    if (!rateCheck.allowed) {
      return res.status(429).json({ 
        error: `⏰ Chill for ${rateCheck.waitTime} seconds, bro!` 
      });
    }

    let memory = loadMemory(userId);
    memory.conversation.push({ role: "user", content: prompt });

    const isCreatorQuestion = isAskingAboutCreator(prompt);
    const explicitlyAskingForData = isExplicitlyAskingForData(prompt);
    const detectedLanguage = detectLanguage(prompt);
    
    let searchResults = [];
    
    // ONLY search if user explicitly asks for movie/series data
    if (explicitlyAskingForData && !isCreatorQuestion) {
      const searchTopic = extractSearchTopic(prompt);
      if (searchTopic && searchTopic.length > 2) {
        searchResults = await searchMaxMovies(searchTopic, 6);
      }
      
      if (searchResults.length === 0) {
        searchResults = await searchMaxMovies('popular', 6);
      }
    }

    let searchContext = "";
    if (searchResults.length > 0 && explicitlyAskingForData) {
      searchContext = `\n\nFound these from MaxMovies: ${JSON.stringify(searchResults)}\n\nONLY mention these if the user explicitly asked for movie/series information. Otherwise, ignore this data completely.`;
    }

    // Special response for creator questions
    let creatorResponse = "";
    if (isCreatorQuestion) {
      creatorResponse = "I was created by Max, a 21-year-old developer from Kenya! He built me to be your movie buddy. 🎬";
    }

    const promptText = `
User asked: "${prompt}"

LANGUAGE REQUIREMENT (STRICT - DO NOT IGNORE):
The user is speaking in ${detectedLanguage.toUpperCase()}. You MUST respond in ${detectedLanguage.toUpperCase()} ONLY. 
- If ${detectedLanguage} is 'english': Respond in English
- If ${detectedLanguage} is 'swahili': Respond in Swahili ONLY (no English or Sheng mixed in)
- If ${detectedLanguage} is 'sheng': Respond in Sheng ONLY (Kenyan urban slang)

DO NOT mix languages. Stick to ONE language strictly as detected above.

${creatorResponse ? `SPECIAL INSTRUCTION: Answer with exactly: "${creatorResponse}" in ${detectedLanguage}` : ""}

${searchContext}

${!searchResults.length && explicitlyAskingForData ? "No results found from MaxMovies database." : ""}

RULES:
1. ONLY provide movie/series data from MaxMovies if the user explicitly asks for it (using words like "search", "find", "recommend", "suggest", "look up", "get me", "tell me about")
2. If the user doesn't explicitly ask for data, just have a normal conversation without mentioning any movie titles or recommendations
3. Keep responses natural and conversational
4. Use emojis naturally
5. Never mention "as an AI" or "language model"
6. Stay in character as MaxMovies AI

Now respond in ${detectedLanguage.toUpperCase()} ONLY, following all rules above.
`;

    const geminiResponse = await fetch(
      `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.85,
            maxOutputTokens: 500,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      return res.status(503).json({ 
        reply: "Whoops! Server busy. Try again later!",
        error: "Whoops! Server busy. Try again later!" 
      });
    }

    const result = await geminiResponse.json();
    let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    if (!fullResponse) {
      return res.status(503).json({ 
        reply: "Whoops! Server busy. Try again later!",
        error: "Whoops! Server busy. Try again later!" 
      });
    }

    // Clean up
    let cleanText = fullResponse.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    cleanText = cleanText.replace(/as an ai|as an AI|language model|i am an ai|i'm an ai/gi, '');
    cleanText = cleanText.replace(/Google/gi, '');
    cleanText = cleanText.replace(/Gemini/gi, 'MaxMovies AI');
    
    // Add clickable links ONLY if user explicitly asked for data
    if (searchResults.length > 0 && explicitlyAskingForData) {
      searchResults.forEach(movie => {
        if (movie.title && movie.title.length > 2) {
          const boldPattern = new RegExp(`<strong>${escapeRegex(movie.title)}</strong>`, 'gi');
          const link = `<a href="${SITE_URL}/#detail/${movie.subjectId}" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 600;">${movie.title}</a>`;
          cleanText = cleanText.replace(boldPattern, link);
        }
      });
    }
    
    memory.conversation.push({ role: "assistant", content: cleanText });
    
    if (memory.conversation.length > 20) {
      memory.conversation = memory.conversation.slice(-18);
    }
    
    saveMemory(userId, memory);

    // Only return recommendations if user explicitly asked for data
    const recommendations = (explicitlyAskingForData && !isCreatorQuestion) ? searchResults.slice(0, 6).map(item => ({
      subjectId: item.subjectId,
      title: item.title,
      cover: item.cover,
      rating: item.rating,
      type: item.type,
      typeDisplay: item.typeDisplay
    })) : [];

    return res.status(200).json({ 
      reply: cleanText,
      recommendations: recommendations
    });
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(503).json({ 
      reply: "Whoops! Server busy. Try again later!",
      error: "Whoops! Server busy. Try again later!" 
    });
  }
}
