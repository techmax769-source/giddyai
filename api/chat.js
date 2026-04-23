import fs from "fs";
import path from "path";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent";
const MAXMOVIES_API = "https://maxmoviesbackend.vercel.app/api/v2";
const SITE_URL = "https://maxmovies-254.vercel.app";

// Use in-memory store instead of filesystem for serverless
const memoryStore = new Map();

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

// 🔍 Search MaxMovies API with more details for explanations
async function searchMaxMovies(query, limit = 5) {
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
      
      // Generate a brief explanation based on available data
      let explanation = '';
      if (item.description) {
        explanation = item.description.substring(0, 80);
      } else if (item.genre) {
        explanation = `${item.genre} ${typeDisplay.toLowerCase()}`;
      } else if (item.director) {
        explanation = `Directed by ${item.director}`;
      } else if (type === 'movie') {
        explanation = `Exciting movie to watch`;
      } else if (type === 'series') {
        explanation = `Amazing series to binge`;
      } else {
        explanation = `Great ${typeDisplay.toLowerCase()} content`;
      }
      
      return {
        subjectId: item.subjectId,
        title: item.title || 'Untitled',
        cover: item.cover?.url || item.thumbnail || null,
        type: type,
        typeDisplay: typeDisplay,
        rating: item.imdbRatingValue || null,
        year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
        explanation: explanation
      };
    });
    
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

// Simple in-memory conversation storage (last 5 messages max)
function getConversationHistory(userId) {
  if (!memoryStore.has(userId)) {
    memoryStore.set(userId, []);
  }
  return memoryStore.get(userId);
}

function addToConversation(userId, role, content) {
  const history = getConversationHistory(userId);
  history.push({ role, content });
  
  // Keep only last 6 messages (3 exchanges) to prevent token overflow
  if (history.length > 6) {
    history.shift();
  }
}

function clearOldMemory() {
  // Clear memories older than 30 minutes
  const now = Date.now();
  for (const [userId, data] of memoryStore.entries()) {
    if (data.timestamp && now - data.timestamp > 1800000) {
      memoryStore.delete(userId);
    }
  }
}

// Run cleanup every hour
setInterval(clearOldMemory, 3600000);

// Check if user is asking about identity/creator
function isAskingAboutIdentity(prompt) {
  const lower = prompt.toLowerCase();
  
  const nameKeywords = [
    'what is your name', 'your name', 'who are you', 'call you', 
    'what are you', 'introduce yourself', 'tell me about yourself'
  ];
  
  const creatorKeywords = [
    'who made you', 'who built you', 'who created you', 'your creator',
    'who developed you', 'who programmed you', 'who is your maker',
    'who wrote you', 'who designed you', 'who made maxmovies ai',
    'your developer', 'who is max'
  ];
  
  return nameKeywords.some(keyword => lower.includes(keyword)) || 
         creatorKeywords.some(keyword => lower.includes(keyword));
}

function getIdentityResponse(prompt) {
  const lower = prompt.toLowerCase();
  
  if (lower.includes('what is your name') || lower.includes('your name') || 
      lower.includes('who are you') || lower.includes('call you')) {
    return "I'm **MaxMovies AI**! 🎬😎";
  }
  
  if (lower.includes('who made you') || lower.includes('who created you') || 
      lower.includes('your creator') || lower.includes('who built you') ||
      lower.includes('who developed you') || lower.includes('who is max')) {
    return "Created by **Max**, a 21-year-old dev from Kenya! 🎬🔥";
  }
  
  return "I'm **MaxMovies AI**, created by **Max**! 🎬💯";
}

// Check if user is explicitly asking for movie/series recommendations
function isAskingForMovies(prompt) {
  const lower = prompt.toLowerCase();
  
  // Skip if asking about identity
  if (isAskingAboutIdentity(prompt)) return false;
  
  // Skip greetings and casual talk
  const greetings = ['hi', 'hello', 'hey', 'sup', 'yo', 'how are you', 'what\'s up'];
  if (greetings.some(g => lower === g || lower.startsWith(g + ' ') || lower.endsWith(' ' + g))) {
    return false;
  }
  
  // Keywords that explicitly ask for movie/series content
  const movieKeywords = [
    'recommend', 'suggest', 'search', 'find', 'look up', 'show me', 
    'get me', 'give me', 'movie', 'series', 'film', 'show', 'watch',
    'stream', 'download', 'action', 'comedy', 'drama', 'horror', 
    'thriller', 'sci-fi', 'romance', 'documentary', 'anime'
  ];
  
  return movieKeywords.some(keyword => lower.includes(keyword));
}

function extractSearchTopic(prompt) {
  let topic = prompt.replace(/recommend|suggest|search|find|look up|show me|get me|give me|watch|stream|download/gi, '');
  topic = topic.replace(/movie|series|film|show/gi, '');
  topic = topic.replace(/[?]/g, '');
  topic = topic.trim();
  
  if (topic.length < 2) return null;
  return topic;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getCoolGreeting() {
  const greetings = [
    "Yo! Ready to binge? 🎬😎",
    "Hey movie lover! What's good? 🍿🔥",
    "Sup! Got your popcorn ready? 🎬😎",
    "Hello! Looking for something lit? 🔥💯",
    "Hey hey! Movie time? 🎬🍿",
    "Yo yo! What we watching today? 😎🎬",
    "Sup fam! Need some recommendations? 🔥💪"
  ];
  return greetings[Math.floor(Math.random() * greetings.length)];
}

function getFallbackResponse(searchResults) {
  if (searchResults && searchResults.length > 0) {
    let response = "🎬 **Here's what I found:**\n\n";
    searchResults.slice(0, 5).forEach((result) => {
      response += `**${result.title}**`;
      if (result.year) response += ` (${result.year})`;
      if (result.rating) response += ` ⭐ ${result.rating}`;
      response += ` - ${result.explanation}\n`;
    });
    response += `\nTap any thumbnail below to watch! 🍿😎`;
    return response;
  }
  
  return getCoolGreeting();
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
        error: `⏰ Chill for ${rateCheck.waitTime} seconds, bro! 😎`,
        reply: `⏰ Please wait ${rateCheck.waitTime} seconds.`
      });
    }

    // Add user message to conversation
    addToConversation(userId, "user", prompt);

    const isIdentityQuestion = isAskingAboutIdentity(prompt);
    const askingForMovies = isAskingForMovies(prompt);
    
    let searchResults = [];
    
    // ONLY search if user explicitly asks for movies/series
    if (askingForMovies && !isIdentityQuestion) {
      const searchTopic = extractSearchTopic(prompt);
      console.log(`Searching for movies: "${searchTopic}"`);
      
      if (searchTopic && searchTopic.length > 2) {
        searchResults = await searchMaxMovies(searchTopic, 5);
      }
      
      if (searchResults.length === 0 && searchTopic) {
        searchResults = await searchMaxMovies('popular', 5);
      }
    }

    // Handle identity questions
    if (isIdentityQuestion) {
      let identityReply = getIdentityResponse(prompt);
      // Bold the names
      identityReply = identityReply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      addToConversation(userId, "assistant", identityReply);
      
      return res.status(200).json({ 
        reply: identityReply,
        recommendations: []
      });
    }

    // Handle simple greetings - no movies, just cool responses
    if (!askingForMovies && !isIdentityQuestion) {
      const greeting = getCoolGreeting();
      addToConversation(userId, "assistant", greeting);
      
      return res.status(200).json({ 
        reply: greeting,
        recommendations: []
      });
    }

    // If asking for movies but no results found
    if (askingForMovies && searchResults.length === 0) {
      const noResultsReply = "Hmm... couldn't find that one. Try something else? 🎬😅";
      addToConversation(userId, "assistant", noResultsReply);
      
      return res.status(200).json({ 
        reply: noResultsReply,
        recommendations: []
      });
    }

    // Get conversation history
    const history = getConversationHistory(userId);
    let conversationContext = "";
    if (history.length > 1) {
      const lastMessages = history.slice(-4);
      conversationContext = "\nPrevious:\n";
      lastMessages.forEach(msg => {
        if (msg.role === "user") {
          conversationContext += `User: ${msg.content}\n`;
        } else {
          conversationContext += `AI: ${msg.content}\n`;
        }
      });
    }

    let searchContext = "";
    if (searchResults.length > 0) {
      searchContext = "\nMovies/Series found (MUST bold every title using **Title**):\n";
      searchResults.forEach((result, index) => {
        searchContext += `${index + 1}. **${result.title}**`;
        if (result.year) searchContext += ` (${result.year})`;
        if (result.rating) searchContext += ` ⭐${result.rating}`;
        searchContext += ` - ${result.explanation}\n`;
      });
    }

    const promptText = `${conversationContext}
User: "${prompt}"

${searchContext}

CRITICAL FORMATTING RULES:
- **MUST bold EVERY movie/series title** using **Title** format
- Format: "🎬 Here's **Movie Title** (Year) - Brief explanation. **Another Movie** (Year) - Brief explanation."
- Keep to 2 sentences max
- NO greetings, NO introductions, JUST the movies with bold titles
- Example: "🎬 Here's **Inception** (2010) - Mind-bending dream thriller. **The Dark Knight** (2008) - Epic Batman story."

Response:`;

    // Use a simple response if no API key
    if (!process.env.GEMINI_API_KEY) {
      let fallbackReply = getFallbackResponse(searchResults);
      // Ensure bold formatting
      fallbackReply = fallbackReply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      addToConversation(userId, "assistant", fallbackReply);
      
      return res.status(200).json({ 
        reply: fallbackReply,
        recommendations: searchResults.slice(0, 5).map(item => ({
          subjectId: item.subjectId,
          title: item.title,
          cover: item.cover,
          rating: item.rating,
          type: item.type,
          typeDisplay: item.typeDisplay,
          year: item.year,
          explanation: item.explanation
        }))
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    try {
      const geminiResponse = await fetch(
        `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ 
              role: "user", 
              parts: [{ text: promptText }] 
            }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 180,
            },
          }),
        }
      );

      clearTimeout(timeoutId);

      if (!geminiResponse.ok) {
        throw new Error(`API returned ${geminiResponse.status}`);
      }

      const result = await geminiResponse.json();
      let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      if (!fullResponse) {
        throw new Error("Empty response");
      }

      // Clean up and ensure bold formatting
      let cleanText = fullResponse;
      
      // Convert markdown bold to HTML
      cleanText = cleanText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      
      // Remove any unnecessary text
      cleanText = cleanText.replace(/as an ai|as an AI|language model|gemini|google/gi, '');
      cleanText = cleanText.replace(/^Hey.*?\.\s*/i, '');
      cleanText = cleanText.replace(/^Hello.*?\.\s*/i, '');
      cleanText = cleanText.replace(/^Yo.*?\.\s*/i, '');
      
      // If no bold tags exist, manually bold titles from search results
      if (searchResults.length > 0 && !cleanText.includes('<strong>')) {
        searchResults.forEach(movie => {
          if (movie.title && movie.title.length > 2) {
            const regex = new RegExp(`(${escapeRegex(movie.title)})`, 'gi');
            cleanText = cleanText.replace(regex, '<strong>$1</strong>');
          }
        });
      }
      
      // Add clickable links
      if (searchResults.length > 0) {
        searchResults.forEach(movie => {
          if (movie.title && movie.title.length > 2) {
            const boldPattern = new RegExp(`<strong>${escapeRegex(movie.title)}</strong>`, 'gi');
            const link = `<a href="${SITE_URL}/#detail/${movie.subjectId}" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 600;">${movie.title}</a>`;
            cleanText = cleanText.replace(boldPattern, link);
          }
        });
      }
      
      // Add to conversation history
      addToConversation(userId, "assistant", cleanText);

      const recommendations = searchResults.slice(0, 5).map(item => ({
        subjectId: item.subjectId,
        title: item.title,
        cover: item.cover,
        rating: item.rating,
        type: item.type,
        typeDisplay: item.typeDisplay,
        year: item.year,
        explanation: item.explanation
      }));

      return res.status(200).json({ 
        reply: cleanText,
        recommendations: recommendations
      });
      
    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error("API error:", fetchError.message);
      
      let fallbackReply = getFallbackResponse(searchResults);
      fallbackReply = fallbackReply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      addToConversation(userId, "assistant", fallbackReply);
      
      return res.status(200).json({ 
        reply: fallbackReply,
        recommendations: searchResults.length > 0 ? searchResults.slice(0, 5).map(item => ({
          subjectId: item.subjectId,
          title: item.title,
          cover: item.cover,
          rating: item.rating,
          type: item.type,
          typeDisplay: item.typeDisplay,
          year: item.year,
          explanation: item.explanation
        })) : []
      });
    }
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(200).json({ 
      reply: "Yo! Ready to find some movies? 🎬😎"
    });
  }
}
