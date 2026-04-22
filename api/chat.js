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

// 🔍 Search MaxMovies API with more details
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
        description: item.description || item.intro || null,
        genre: item.genre || null,
        director: item.director || null,
        cast: item.cast ? item.cast.slice(0, 3) : null
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

function isAskingAboutCreator(prompt) {
  const lower = prompt.toLowerCase();
  const creatorKeywords = [
    'who made you', 'who built you', 'who created you', 'your creator',
    'who developed you', 'who programmed you', 'who is your maker',
    'who wrote you', 'who designed you', 'who made maxmovies ai'
  ];
  return creatorKeywords.some(keyword => lower.includes(keyword));
}

// Check if user is asking for any movie/series content
function isAskingForContent(prompt) {
  const lower = prompt.toLowerCase();
  
  // Keywords that indicate user wants to watch/find content
  const contentKeywords = [
    'watch', 'see', 'show me', 'find', 'search', 'look up', 'get me', 'give me',
    'recommend', 'suggest', 'tell me about', 'what is', 'info on', 'movie', 'series',
    'film', 'show', 'episode', 'season', 'stream', 'download', 'play'
  ];
  
  // Check if asking about specific titles (capitalized words often indicate titles)
  const hasCapitalizedWords = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(prompt);
  
  return contentKeywords.some(keyword => lower.includes(keyword)) || hasCapitalizedWords;
}

function extractSearchTopic(prompt) {
  // Remove common question words and keep the main topic
  let topic = prompt.replace(/what is|tell me about|info on|search for|find|look up|show me|recommend|suggest|best|good|top|movie|series|film|show|watch|see|stream|download|play/gi, '');
  topic = topic.replace(/about/gi, '');
  topic = topic.replace(/[?]/g, '');
  topic = topic.trim();
  
  // If topic is too short, check if there's a quoted phrase or capitalized words
  if (topic.length < 2) {
    const quotedMatch = prompt.match(/["']([^"']+)["']/);
    if (quotedMatch) return quotedMatch[1];
    
    const capitalizedMatch = prompt.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/);
    if (capitalizedMatch) return capitalizedMatch[1];
  }
  
  return topic.length >= 2 ? topic : null;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getFallbackResponse(prompt, searchResults, isCreatorQuestion) {
  if (isCreatorQuestion) {
    return "I was created by Max, a 21-year-old developer from Kenya! He built me to be your movie buddy. 🎬";
  }
  
  if (searchResults && searchResults.length > 0) {
    let response = "🎬 Here's what I found for you:\n\n";
    searchResults.slice(0, 3).forEach((result, index) => {
      response += `**${result.title}**`;
      if (result.year) response += ` (${result.year})`;
      if (result.rating) response += ` ⭐ ${result.rating}`;
      response += `\n`;
      if (result.description) {
        response += `${result.description.substring(0, 150)}${result.description.length > 150 ? '...' : ''}\n`;
      }
      response += `Type: ${result.typeDisplay}\n\n`;
    });
    response += `Check them out on MaxMovies! 🍿`;
    return response;
  }
  
  return "Hey! I'm MaxMovies AI. You can ask me to search for movies, series, or music, or just chat with me! What can I help you with today? 🎬";
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

    let memory = loadMemory(userId);
    memory.conversation.push({ role: "user", content: prompt });

    const isCreatorQuestion = isAskingAboutCreator(prompt);
    const askingForContent = isAskingForContent(prompt);
    
    let searchResults = [];
    
    // ALWAYS search if user is asking for content (any format)
    if (askingForContent && !isCreatorQuestion) {
      const searchTopic = extractSearchTopic(prompt);
      console.log(`Searching for: "${searchTopic}" from prompt: "${prompt}"`);
      
      if (searchTopic && searchTopic.length > 2) {
        searchResults = await searchMaxMovies(searchTopic, 6);
      }
      
      // If no results found with specific search, try popular content
      if (searchResults.length === 0 && searchTopic) {
        searchResults = await searchMaxMovies('popular', 6);
      }
    }

    if (!process.env.GEMINI_API_KEY) {
      console.error("GEMINI_API_KEY is not set");
      const fallbackReply = getFallbackResponse(prompt, searchResults, isCreatorQuestion);
      
      return res.status(200).json({ 
        reply: fallbackReply,
        recommendations: searchResults.slice(0, 6).map(item => ({
          subjectId: item.subjectId,
          title: item.title,
          cover: item.cover,
          rating: item.rating,
          type: item.type,
          typeDisplay: item.typeDisplay,
          year: item.year,
          description: item.description
        })),
        warning: "AI service unavailable, using fallback responses"
      });
    }

    let searchContext = "";
    if (searchResults.length > 0 && askingForContent) {
      // Build detailed context for Gemini
      let contextText = "\n\nFound these from MaxMovies database:\n";
      searchResults.forEach((result, index) => {
        contextText += `${index + 1}. **${result.title}**`;
        if (result.year) contextText += ` (${result.year})`;
        if (result.rating) contextText += ` - Rating: ${result.rating}/10`;
        contextText += `\n   Type: ${result.typeDisplay}`;
        if (result.description) {
          contextText += `\n   Description: ${result.description.substring(0, 200)}`;
        }
        if (result.genre) contextText += `\n   Genre: ${result.genre}`;
        if (result.director) contextText += `\n   Director: ${result.director}`;
        if (result.cast) contextText += `\n   Cast: ${result.cast.join(', ')}`;
        contextText += `\n   Link: ${SITE_URL}/#detail/${result.subjectId}\n\n`;
      });
      searchContext = contextText;
    }

    let creatorResponse = "";
    if (isCreatorQuestion) {
      creatorResponse = "I was created by Max, a 21-year-old developer from Kenya! He built me to be your movie buddy. 🎬";
    }

    const promptText = `
User asked: "${prompt}"

${creatorResponse ? `SPECIAL INSTRUCTION: Answer with exactly: "${creatorResponse}"` : ""}

${searchContext}

${!searchResults.length && askingForContent ? "No results found from MaxMovies database." : ""}

IMPORTANT FORMATTING RULES:
1. **ALWAYS bold every movie/series title** using **bold text** or HTML <strong> tags
2. For each result, provide a brief 1-2 sentence explanation about what it is
3. Format your response like this example:
   
   **Movie Title** (Year) ⭐ Rating
   Here's a quick description of what this movie is about...
   
   **Another Movie** (Year)
   Brief explanation of this one...

4. Keep explanations concise but informative
5. Use emojis naturally
6. Never mention "as an AI" or "language model"

Now respond in a friendly, helpful way following all rules above. Make sure EVERY title is bolded.
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
              temperature: 0.85,
              maxOutputTokens: 800,
            },
          }),
        }
      );

      clearTimeout(timeoutId);

      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text();
        console.error(`Gemini API error ${geminiResponse.status}:`, errorText);
        
        const fallbackReply = getFallbackResponse(prompt, searchResults, isCreatorQuestion);
        
        return res.status(200).json({ 
          reply: fallbackReply,
          recommendations: searchResults.slice(0, 6).map(item => ({
            subjectId: item.subjectId,
            title: item.title,
            cover: item.cover,
            rating: item.rating,
            type: item.type,
            typeDisplay: item.typeDisplay,
            year: item.year,
            description: item.description
          })),
          warning: "AI service busy, using fallback response"
        });
      }

      const result = await geminiResponse.json();
      let fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

      if (!fullResponse) {
        console.error("Empty response from Gemini");
        const fallbackReply = getFallbackResponse(prompt, searchResults, isCreatorQuestion);
        
        return res.status(200).json({ 
          reply: fallbackReply,
          recommendations: searchResults.slice(0, 6).map(item => ({
            subjectId: item.subjectId,
            title: item.title,
            cover: item.cover,
            rating: item.rating,
            type: item.type,
            typeDisplay: item.typeDisplay,
            year: item.year,
            description: item.description
          })),
          warning: "AI response empty, using fallback"
        });
      }

      // Clean up and ensure titles are bolded
      let cleanText = fullResponse.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      
      // If no bold tags exist but we have search results, manually bold titles
      if (searchResults.length > 0 && askingForContent && !cleanText.includes('<strong>')) {
        searchResults.forEach(movie => {
          if (movie.title && movie.title.length > 2) {
            const regex = new RegExp(`(${escapeRegex(movie.title)})`, 'gi');
            cleanText = cleanText.replace(regex, '<strong>$1</strong>');
          }
        });
      }
      
      cleanText = cleanText.replace(/as an ai|as an AI|language model|i am an ai|i'm an ai/gi, '');
      cleanText = cleanText.replace(/Google/gi, '');
      cleanText = cleanText.replace(/Gemini/gi, 'MaxMovies AI');
      
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
      
      memory.conversation.push({ role: "assistant", content: cleanText });
      
      if (memory.conversation.length > 20) {
        memory.conversation = memory.conversation.slice(-18);
      }
      
      saveMemory(userId, memory);

      // ALWAYS return recommendations when content was found, regardless of how user asked
      const recommendations = (askingForContent && !isCreatorQuestion && searchResults.length > 0) ? 
        searchResults.slice(0, 6).map(item => ({
          subjectId: item.subjectId,
          title: item.title,
          cover: item.cover,
          rating: item.rating,
          type: item.type,
          typeDisplay: item.typeDisplay,
          year: item.year,
          description: item.description
        })) : [];

      return res.status(200).json({ 
        reply: cleanText,
        recommendations: recommendations
      });
      
    } catch (fetchError) {
      clearTimeout(timeoutId);
      console.error("Fetch error:", fetchError);
      
      const fallbackReply = getFallbackResponse(prompt, searchResults, isCreatorQuestion);
      
      return res.status(200).json({ 
        reply: fallbackReply,
        recommendations: (askingForContent && !isCreatorQuestion && searchResults.length > 0) ?
          searchResults.slice(0, 6).map(item => ({
            subjectId: item.subjectId,
            title: item.title,
            cover: item.cover,
            rating: item.rating,
            type: item.type,
            typeDisplay: item.typeDisplay,
            year: item.year,
            description: item.description
          })) : [],
        warning: "Connection issue, using fallback response"
      });
    }
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(200).json({ 
      reply: "Hey! Something went wrong, but I'm still here! What movie are you looking for? ",
      error: err.message
    });
  }
}
