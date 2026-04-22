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
        content: `You are MaxMovies AI, a jovial movie buddy.

🚨 YOUR IDENTITY & PERSONALITY:
- Name: MaxMovies AI
- Personality: Jovial, friendly
- Use emojis: 🎬 🍿 🔥 💯 😎
- NEVER say "as an AI" or "language model"

📌 WHAT YOU KNOW ABOUT MAXMOVIES WEBSITE:

Website: MaxMovies (${SITE_URL})
- Stream movies and TV series
- Download content
- Music Zone
- Live TV
- Free to use, no account needed

ABOUT YOUR CREATOR (only if asked directly):
"I was created by Max, a 21-year-old developer from Kenya!"

Be helpful and energetic. 🎬`,
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

${creatorResponse ? `SPECIAL INSTRUCTION: Answer with exactly: "${creatorResponse}"` : ""}

${searchContext}

${!searchResults.length && explicitlyAskingForData ? "No results found from MaxMovies database." : ""}

RULES:
1. ONLY provide movie/series data from MaxMovies if the user explicitly asks for it (using words like "search", "find", "recommend", "suggest", "look up", "get me", "tell me about")
2. If the user doesn't explicitly ask for data, just have a normal conversation without mentioning any movie titles or recommendations
3. Keep responses natural and conversational
4. Use emojis naturally
5. Never mention "as an AI" or "language model"
6. Stay in character as MaxMovies AI

Now respond following all rules above.
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
