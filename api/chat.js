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
        explanation = item.description.substring(0, 100);
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
    return "I'm **<strong>MaxMovies AI</strong>**! Your friendly movie buddy from MaxMovies website. 🎬";
  }
  
  if (lower.includes('who made you') || lower.includes('who created you') || 
      lower.includes('your creator') || lower.includes('who built you') ||
      lower.includes('who developed you') || lower.includes('who is max')) {
    return "I was created by **<strong>Max</strong>**, a 21-year-old developer from Kenya! He built me to be your ultimate movie buddy. 🎬";
  }
  
  return "I'm **<strong>MaxMovies AI</strong>**, your movie buddy from MaxMovies website! Created by **<strong>Max</strong>**, a 21-year-old dev from Kenya. 🎬";
}

// Check if user is asking for movie/series content
function isAskingForContent(prompt) {
  const lower = prompt.toLowerCase();
  
  if (isAskingAboutIdentity(prompt)) return false;
  
  const contentKeywords = [
    'watch', 'see', 'show me', 'find', 'search', 'look up', 'get me', 'give me',
    'recommend', 'suggest', 'tell me about', 'movie', 'series', 'film', 'show',
    'episode', 'season', 'stream', 'download', 'play', 'action', 'comedy', 
    'drama', 'horror', 'thriller', 'sci-fi', 'romance'
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

function getFallbackResponse(searchResults) {
  if (searchResults && searchResults.length > 0) {
    let response = "🎬 **Here's what I found:**\n\n";
    searchResults.slice(0, 5).forEach((result) => {
      response += `**${result.title}**`;
      if (result.year) response += ` (${result.year})`;
      if (result.rating) response += ` ⭐ ${result.rating}`;
      response += `\n`;
      if (result.explanation) {
        response += `${result.explanation}\n`;
      }
      response += `\n`;
    });
    response += `Tap any thumbnail below to watch! 🍿`;
    return response;
  }
  
  return "Hey! I'm **MaxMovies AI**. Ask me to find a movie or series for you! 🎬";
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
        reply: `⏰ Please wait ${rateCheck.waitTime} seconds.`
      });
    }

    // Add user message to conversation
    addToConversation(userId, "user", prompt);

    const isIdentityQuestion = isAskingAboutIdentity(prompt);
    const askingForContent = isAskingForContent(prompt);
    
    let searchResults = [];
    
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

    // Handle identity questions immediately
    if (isIdentityQuestion) {
      let identityReply = getIdentityResponse(prompt);
      // Ensure bolding works in the response
      identityReply = identityReply.replace(/\*\*<strong>(.*?)<\/strong>\*\*/g, '<strong>$1</strong>');
      identityReply = identityReply.replace(/<strong>/g, '<strong>');
      identityReply = identityReply.replace(/<\/strong>/g, '</strong>');
      
      addToConversation(userId, "assistant", identityReply);
      
      return res.status(200).json({ 
        reply: identityReply,
        recommendations: []
      });
    }

    // Get conversation history (last 4 messages for context)
    const history = getConversationHistory(userId);
    let conversationContext = "";
    if (history.length > 1) {
      const lastMessages = history.slice(-4);
      conversationContext = "\nPrevious conversation:\n";
      lastMessages.forEach(msg => {
        if (msg.role === "user") {
          conversationContext += `User: ${msg.content}\n`;
        } else {
          conversationContext += `AI: ${msg.content}\n`;
        }
      });
    }

    let searchContext = "";
    if (searchResults.length > 0 && askingForContent) {
      searchContext = "\nFound these movies/series with details - provide a brief explanation for each:\n";
      searchResults.forEach((result, index) => {
        searchContext += `${index + 1}. **${result.title}**`;
        if (result.year) searchContext += ` (${result.year})`;
        if (result.rating) searchContext += ` ⭐${result.rating}`;
        searchContext += `\n   Brief explanation: ${result.explanation}\n`;
      });
    }

    const promptText = `${conversationContext}
Current user question: "${prompt}"

${searchContext}

IMPORTANT RULES:
1. **Bold ALL movie/series titles** using **Title** format
2. **Bold your name** as **MaxMovies AI** whenever you mention yourself
3. **Bold the creator name** as **Max** whenever you mention the developer
4. Provide a VERY BRIEF explanation (5-10 words) for EACH movie/series you mention
5. Keep total response to 2-3 sentences maximum
6. Use this exact format:
   "🎬 Here's **Movie Title** (Year) - Brief explanation. **Another Movie** (Year) - Quick description."

Example: "🎬 Here's **Inception** (2010) - Dream heist thriller. **The Dark Knight** (2008) - Batman vs Joker epic."

Now respond following these rules exactly. Remember to bold titles, your name, and creator name:`;

    // Use a simple response if no API key
    if (!process.env.GEMINI_API_KEY) {
      let fallbackReply = getFallbackResponse(searchResults);
      // Bold the AI name in fallback
      fallbackReply = fallbackReply.replace(/MaxMovies AI/g, '<strong>MaxMovies AI</strong>');
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

      // Clean up and ensure proper bolding
      let cleanText = fullResponse;
      
      // Bold AI name if mentioned
      cleanText = cleanText.replace(/MaxMovies AI/gi, '<strong>MaxMovies AI</strong>');
      cleanText = cleanText.replace(/MaxMovies AI/g, '<strong>MaxMovies AI</strong>');
      
      // Bold creator name if mentioned
      cleanText = cleanText.replace(/\bMax\b(?![\w])/gi, '<strong>Max</strong>');
      
      // Bold movie titles from search results
      if (searchResults.length > 0 && askingForContent) {
        searchResults.forEach(movie => {
          if (movie.title && movie.title.length > 2) {
            const titleRegex = new RegExp(`\\*\\*${escapeRegex(movie.title)}\\*\\*`, 'gi');
            if (!cleanText.match(titleRegex)) {
              const plainRegex = new RegExp(`(${escapeRegex(movie.title)})`, 'gi');
              cleanText = cleanText.replace(plainRegex, '<strong>$1</strong>');
            }
          }
        });
      }
      
      // Convert markdown bold to HTML
      cleanText = cleanText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      
      // Remove any AI/language model mentions
      cleanText = cleanText.replace(/as an ai|as an AI|language model|gemini|google/gi, '');
      
      // Add clickable links to titles
      if (searchResults.length > 0 && askingForContent) {
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

      const recommendations = (askingForContent && searchResults.length > 0) ? 
        searchResults.slice(0, 5).map(item => ({
          subjectId: item.subjectId,
          title: item.title,
          cover: item.cover,
          rating: item.rating,
          type: item.type,
          typeDisplay: item.typeDisplay,
          year: item.year,
          explanation: item.explanation
        })) : [];

      return res.status(200).json({ 
        reply: cleanText,
        recommendations: recommendations
      });
      
    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error("API error:", fetchError.message);
      
      let fallbackReply = getFallbackResponse(searchResults);
      // Bold the AI name and creator in fallback
      fallbackReply = fallbackReply.replace(/MaxMovies AI/g, '<strong>MaxMovies AI</strong>');
      fallbackReply = fallbackReply.replace(/\bMax\b(?![\w])/g, '<strong>Max</strong>');
      fallbackReply = fallbackReply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      
      addToConversation(userId, "assistant", fallbackReply);
      
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
            year: item.year,
            explanation: item.explanation
          })) : []
      });
    }
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(200).json({ 
      reply: "Hey! I'm **<strong>MaxMovies AI</strong>**. What movie are you looking for? 🎬"
    });
  }
}
