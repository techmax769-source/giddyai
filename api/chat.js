import fs from "fs";
import path from "path";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent";
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
      const memory = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      // Ensure conversation array exists
      if (!memory.conversation) memory.conversation = [];
      return memory;
    }
  } catch (err) {
    console.error(`Failed to load memory:`, err);
  }

  return {
    userId,
    conversation: []
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

// Check if user is asking about identity/creator
function isAskingAboutIdentity(prompt) {
  const lower = prompt.toLowerCase();
  
  // Name related questions
  const nameKeywords = [
    'what is your name', 'your name', 'who are you', 'call you', 
    'what are you', 'introduce yourself', 'tell me about yourself'
  ];
  
  // Creator related questions
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
  
  // Name questions
  if (lower.includes('what is your name') || lower.includes('your name') || 
      lower.includes('who are you') || lower.includes('call you')) {
    return "I'm MaxMovies AI! Your friendly movie buddy from MaxMovies website. 🎬";
  }
  
  // Creator questions
  if (lower.includes('who made you') || lower.includes('who created you') || 
      lower.includes('your creator') || lower.includes('who built you') ||
      lower.includes('who developed you') || lower.includes('who is max')) {
    return "I was created by Max, a 21-year-old developer from Kenya! He built me to be your ultimate movie buddy. 🎬";
  }
  
  // General intro
  return "I'm MaxMovies AI, your movie buddy from MaxMovies website! Created by Max, a 21-year-old dev from Kenya. What movie are we watching today? 🎬";
}

// Check if user is asking for movie/series content
function isAskingForContent(prompt) {
  const lower = prompt.toLowerCase();
  
  // Skip if asking about identity
  if (isAskingAboutIdentity(prompt)) return false;
  
  const contentKeywords = [
    'watch', 'see', 'show me', 'find', 'search', 'look up', 'get me', 'give me',
    'recommend', 'suggest', 'tell me about', 'movie', 'series', 'film', 'show',
    'episode', 'season', 'stream', 'download', 'play', 'action', 'comedy', 
    'drama', 'horror', 'thriller', 'sci-fi', 'romance', 'documentary'
  ];
  
  return contentKeywords.some(keyword => lower.includes(keyword));
}

function extractSearchTopic(prompt) {
  let topic = prompt.replace(/what is|tell me about|search for|find|look up|show me|recommend|suggest|watch|see|stream|download|play/gi, '');
  topic = topic.replace(/movie|series|film|show/gi, '');
  topic = topic.replace(/[?]/g, '');
  topic = topic.trim();
  
  if (topic.length < 2) return null;
  return topic;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getFallbackResponse(prompt, searchResults, isIdentityQuestion) {
  if (isIdentityQuestion) {
    return getIdentityResponse(prompt);
  }
  
  if (searchResults && searchResults.length > 0) {
    let response = "🎬 Here's what I found:\n\n";
    searchResults.slice(0, 3).forEach((result, index) => {
      response += `**${result.title}**`;
      if (result.year) response += ` (${result.year})`;
      if (result.rating) response += ` ⭐ ${result.rating}`;
      response += `\n`;
      response += `Type: ${result.typeDisplay}\n\n`;
    });
    response += `Tap any thumbnail below to watch! 🍿`;
    return response;
  }
  
  return "Hey! I'm MaxMovies AI. Ask me to find a movie or series for you! 🎬";
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
        error: `⏰ Chill for ${rateCheck.waitTime} seconds, bro!`,
        reply: `⏰ Please wait ${rateCheck.waitTime} seconds before sending another message.`
      });
    }

    // Load existing conversation memory
    let memory = loadMemory(userId);
    
    // Ensure conversation history exists
    if (!memory.conversation) {
      memory.conversation = [];
    }
    
    // Add user message to history
    memory.conversation.push({ role: "user", content: prompt });

    const isIdentityQuestion = isAskingAboutIdentity(prompt);
    const askingForContent = isAskingForContent(prompt);
    
    let searchResults = [];
    
    // ONLY search for content if not asking about identity
    if (askingForContent && !isIdentityQuestion) {
      const searchTopic = extractSearchTopic(prompt);
      console.log(`Searching for: "${searchTopic}"`);
      
      if (searchTopic && searchTopic.length > 2) {
        searchResults = await searchMaxMovies(searchTopic, 5);
      }
      
      if (searchResults.length === 0 && searchTopic) {
        searchResults = await searchMaxMovies('popular', 5);
      }
    }

    // Handle identity questions immediately without API call
    if (isIdentityQuestion) {
      const identityReply = getIdentityResponse(prompt);
      
      memory.conversation.push({ role: "assistant", content: identityReply });
      
      // Keep last 15 messages for context (prevents memory bloat)
      if (memory.conversation.length > 30) {
        memory.conversation = memory.conversation.slice(-30);
      }
      
      saveMemory(userId, memory);
      
      return res.status(200).json({ 
        reply: identityReply,
        recommendations: []
      });
    }

    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY is not set");
      const fallbackReply = getFallbackResponse(prompt, searchResults, false);
      
      memory.conversation.push({ role: "assistant", content: fallbackReply });
      
      if (memory.conversation.length > 30) {
        memory.conversation = memory.conversation.slice(-30);
      }
      saveMemory(userId, memory);
      
      return res.status(200).json({ 
        reply: fallbackReply,
        recommendations: searchResults.slice(0, 5).map(item => ({
          subjectId: item.subjectId,
          title: item.title,
          cover: item.cover,
          rating: item.rating,
          type: item.type,
          typeDisplay: item.typeDisplay,
          year: item.year
        }))
      });
    }

    // Build conversation context from history (last 10 messages for relevance)
    let conversationHistory = "";
    const recentMessages = memory.conversation.slice(-10);
    if (recentMessages.length > 1) {
      conversationHistory = "\n\nPrevious conversation:\n";
      recentMessages.slice(0, -1).forEach(msg => {
        const role = msg.role === "user" ? "User" : "MaxMovies AI";
        conversationHistory += `${role}: ${msg.content}\n`;
      });
      conversationHistory += `\nCurrent question: "${prompt}"\n`;
    }

    let searchContext = "";
    if (searchResults.length > 0 && askingForContent) {
      let contextText = "\n\nFound these from MaxMovies:\n";
      searchResults.forEach((result, index) => {
        contextText += `${index + 1}. **${result.title}**`;
        if (result.year) contextText += ` (${result.year})`;
        if (result.rating) contextText += ` - ⭐${result.rating}`;
        contextText += `\n   ${result.typeDisplay}\n`;
      });
      searchContext = contextText;
    }

    const promptText = `
${conversationHistory}

User asked: "${prompt}"

${searchContext}

${!searchResults.length && askingForContent ? "No results found." : ""}

STRICT RULES:
1. Keep response SHORT - max 2 sentences total
2. **Bold movie/series titles** using **title**
3. NO long descriptions, NO paragraphs
4. Just say: "Here's **Movie Title** (Year) - [1 short phrase about it]"
5. Use emojis sparingly
6. NEVER mention being an AI
7. Remember previous conversation context

Example response: "🎬 Here's **Inception** (2010) - Mind-bending thriller about dream thieves. Check the thumbnails below!"

Now respond briefly:
`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

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
              maxOutputTokens: 150,
            },
          }),
        }
      );

      clearTimeout(timeoutId);

      if (!geminiResponse.ok) {
        const fallbackReply = getFallbackResponse(prompt, searchResults, false);
        
        memory.conversation.push({ role: "assistant", content: fallbackReply });
        
        if (memory.conversation.length > 30) {
          memory.conversation = memory.conversation.slice(-30);
        }
        saveMemory(userId, memory);
        
        return res.status(200).json({ 
          reply: fallbackReply,
          recommendations: searchResults.slice(0, 5).map(item => ({
            subjectId: item.subjectId,
            title: item.title,
            cover: item.cover,
            rating: item.rating,
            type: item.type,
            typeDisplay: item.typeDisplay,
            year: item.year
          }))
        });
      }

      const result = await geminiResponse.json();
      let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      if (!fullResponse) {
        const fallbackReply = getFallbackResponse(prompt, searchResults, false);
        
        memory.conversation.push({ role: "assistant", content: fallbackReply });
        
        if (memory.conversation.length > 30) {
          memory.conversation = memory.conversation.slice(-30);
        }
        saveMemory(userId, memory);
        
        return res.status(200).json({ 
          reply: fallbackReply,
          recommendations: searchResults.slice(0, 5).map(item => ({
            subjectId: item.subjectId,
            title: item.title,
            cover: item.cover,
            rating: item.rating,
            type: item.type,
            typeDisplay: item.typeDisplay,
            year: item.year
          }))
        });
      }

      // Clean up
      let cleanText = fullResponse.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      cleanText = cleanText.replace(/as an ai|as an AI|language model|i am an ai|i'm an ai|gemini|google/gi, '');
      cleanText = cleanText.replace(/MaxMovies AI/gi, 'MaxMovies AI');
      
      // Add clickable links
      if (searchResults.length > 0 && askingForContent) {
        searchResults.forEach(movie => {
          if (movie.title && movie.title.length > 2) {
            const boldPattern = new RegExp(`<strong>${escapeRegex(movie.title)}</strong>`, 'gi');
            const link = `<a href="${SITE_URL}/#detail/${movie.subjectId}" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 600;">${movie.title}</a>`;
            cleanText = cleanText.replace(boldPattern, link);
          }
        });
      }
      
      // Add assistant response to conversation history
      memory.conversation.push({ role: "assistant", content: cleanText });
      
      // Keep only last 30 messages to prevent memory bloat
      if (memory.conversation.length > 30) {
        memory.conversation = memory.conversation.slice(-30);
      }
      
      saveMemory(userId, memory);

      // Return recommendations when content found
      const recommendations = (askingForContent && searchResults.length > 0) ? 
        searchResults.slice(0, 5).map(item => ({
          subjectId: item.subjectId,
          title: item.title,
          cover: item.cover,
          rating: item.rating,
          type: item.type,
          typeDisplay: item.typeDisplay,
          year: item.year
        })) : [];

      return res.status(200).json({ 
        reply: cleanText,
        recommendations: recommendations
      });
      
    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error("Fetch error:", fetchError);
      
      const fallbackReply = getFallbackResponse(prompt, searchResults, false);
      
      memory.conversation.push({ role: "assistant", content: fallbackReply });
      
      if (memory.conversation.length > 30) {
        memory.conversation = memory.conversation.slice(-30);
      }
      saveMemory(userId, memory);
      
      return res.status(200).json({ 
        reply: fallbackReply,
        recommendations: (askingForContent && searchResults.length > 0) ?
          searchResults.slice(0, 5).map(item => ({
            subjectId: item.subjectId,
            title: item.title,
            cover: item.cover,
            rating: item.rating,
            type: item.type,
            typeDisplay: item.typeDisplay,
            year: item.year
          })) : []
      });
    }
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(200).json({ 
      reply: "Hey! I'm MaxMovies AI. What movie are you looking for? 🎬",
      error: err.message
    });
  }
}
