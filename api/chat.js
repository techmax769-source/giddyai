import fs from "fs";
import path from "path";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent";
const MAXMOVIES_API = "https://maxmoviesbackend.vercel.app/api/v2";
const SITE_URL = "https://maxmovies-254.vercel.app";

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

// 🔍 Search MaxMovies API with strict validation
async function searchMaxMovies(query, limit = 5) {
  try {
    const searchUrl = `${MAXMOVIES_API}/search/${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl);
    
    if (!response.ok) return [];
    
    const data = await response.json();
    let items = data?.results?.items || [];
    
    if (items.length === 0) return [];
    
    const validResults = [];
    
    for (const item of items) {
      const coverUrl = item.cover?.url || item.thumbnail || null;
      
      // Skip items without valid cover
      if (!coverUrl || coverUrl === '' || !coverUrl.startsWith('http')) {
        continue;
      }
      
      let type = 'movie';
      let typeDisplay = 'MOVIE';
      
      if (item.subjectType === 2) {
        type = 'series';
        typeDisplay = 'SERIES';
      } else if (item.subjectType === 3) {
        type = 'music';
        typeDisplay = 'MUSIC';
      }
      
      // Generate short explanation
      let explanation = '';
      if (item.description) {
        explanation = item.description.substring(0, 60);
      } else if (item.genre) {
        explanation = `${item.genre} ${typeDisplay.toLowerCase()}`;
      } else if (type === 'movie') {
        explanation = 'Exciting movie to watch';
      } else if (type === 'series') {
        explanation = 'Amazing series to binge';
      } else {
        explanation = 'Great content';
      }
      
      validResults.push({
        subjectId: item.subjectId,
        title: item.title || 'Untitled',
        cover: coverUrl,
        type: type,
        typeDisplay: typeDisplay,
        rating: item.imdbRatingValue || null,
        year: item.releaseDate ? new Date(item.releaseDate).getFullYear() : null,
        explanation: explanation
      });
      
      if (validResults.length >= limit) break;
    }
    
    return validResults;
    
  } catch (err) {
    console.error("Search error:", err);
    return [];
  }
}

function isAskingAboutIdentity(prompt) {
  const lower = prompt.toLowerCase();
  const nameKeywords = ['what is your name', 'your name', 'who are you', 'call you', 'what are you'];
  const creatorKeywords = ['who made you', 'who built you', 'who created you', 'your creator', 'who developed you', 'who is max'];
  return nameKeywords.some(k => lower.includes(k)) || creatorKeywords.some(k => lower.includes(k));
}

function isAskingForMovies(prompt) {
  const lower = prompt.toLowerCase();
  if (isAskingAboutIdentity(prompt)) return false;
  
  const greetings = ['hi', 'hello', 'hey', 'sup', 'yo', 'how are you', 'what\'s up'];
  if (greetings.some(g => lower === g || lower.startsWith(g + ' '))) {
    return false;
  }
  
  const movieKeywords = ['recommend', 'suggest', 'search', 'find', 'show me', 'movie', 'series', 'film', 'watch', 'action', 'comedy', 'drama', 'horror', 'thriller', 'kenyan'];
  return movieKeywords.some(k => lower.includes(k));
}

function extractSearchTopic(prompt) {
  let topic = prompt.replace(/recommend|suggest|search|find|show me|watch/gi, '');
  topic = topic.replace(/movie|series|film|show/gi, '');
  topic = topic.replace(/[?]/g, '');
  topic = topic.trim();
  return topic.length >= 2 ? topic : null;
}

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getCoolGreeting() {
  const greetings = [
    "Yo! Ready to binge? 🎬😎",
    "Hey movie lover! What's good? 🍿🔥",
    "Sup! Got your popcorn ready? 🎬😎",
    "Hey hey! Movie time? 🎬🍿",
    "Yo yo! What we watching today? 😎🎬"
  ];
  return greetings[Math.floor(Math.random() * greetings.length)];
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
        reply: `⏰ Chill for ${rateCheck.waitTime} seconds bro! 😎`
      });
    }

    const isIdentityQuestion = isAskingAboutIdentity(prompt);
    const askingForMovies = isAskingForMovies(prompt);
    
    let searchResults = [];
    let replyText = "";
    
    // Handle identity questions
    if (isIdentityQuestion) {
      if (prompt.toLowerCase().includes('name') || prompt.toLowerCase().includes('who are you')) {
        replyText = "I'm **MaxMovies AI**! 🎬😎";
      } else {
        replyText = "Created by **Max**, a 21-year-old dev from Kenya! 🎬🔥";
      }
      
      return res.status(200).json({ 
        reply: replyText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'),
        recommendations: []
      });
    }
    
    // Handle greetings
    if (!askingForMovies) {
      replyText = getCoolGreeting();
      return res.status(200).json({ 
        reply: replyText,
        recommendations: []
      });
    }
    
    // Search for movies
    if (askingForMovies) {
      const searchTopic = extractSearchTopic(prompt);
      console.log(`Searching: "${searchTopic}"`);
      
      if (searchTopic) {
        searchResults = await searchMaxMovies(searchTopic, 5);
      }
      
      if (searchResults.length === 0) {
        replyText = "Hmm... couldn't find that one. Try something else? 🎬😅";
        return res.status(200).json({ 
          reply: replyText,
          recommendations: []
        });
      }
      
      // Build response using Gemini but with strict instructions
      if (process.env.GEMINI_API_KEY) {
        try {
          const promptText = `You are MaxMovies AI. User asked: "${prompt}"

Found these movies/series (ONLY use these, DO NOT invent others):
${searchResults.map((r, i) => `${i+1}. ${r.title} (${r.year || 'N/A'}) - ${r.explanation}`).join('\n')}

STRICT RULES:
- ONLY mention the movies/series from the list above
- Format: "🎬 Here's **Title** (Year) - Brief explanation. **Title2** (Year) - Brief explanation."
- MAX 2 sentences
- NO extra text, NO greetings, NO introductions
- DO NOT mention being an AI
- DO NOT add any movie not in the list

Response:`;

          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          
          const geminiResponse = await fetch(
            `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              signal: controller.signal,
              body: JSON.stringify({
                contents: [{ role: "user", parts: [{ text: promptText }] }],
                generationConfig: {
                  temperature: 0.3,
                  maxOutputTokens: 120,
                },
              }),
            }
          );
          
          clearTimeout(timeoutId);
          
          if (geminiResponse.ok) {
            const result = await geminiResponse.json();
            let aiReply = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            
            if (aiReply && !aiReply.includes('**') && searchResults.length > 0) {
              // Manually add bold formatting if AI didn't
              searchResults.forEach(movie => {
                const regex = new RegExp(`(${escapeRegex(movie.title)})`, 'gi');
                aiReply = aiReply.replace(regex, '**$1**');
              });
            }
            
            replyText = aiReply || `🎬 Here's ${searchResults.map(r => `**${r.title}** (${r.year || ''})`).join(', ')}. Tap below to watch! 🍿😎`;
          } else {
            throw new Error('API failed');
          }
        } catch (error) {
          console.error("Gemini error:", error);
          // Fallback to manual response
          replyText = `🎬 Here's ${searchResults.map(r => `**${r.title}**${r.year ? ` (${r.year})` : ''}`).join(', ')}. Tap any thumbnail below to watch! 🍿😎`;
        }
      } else {
        // Manual response without Gemini
        replyText = `🎬 Here's ${searchResults.map(r => `**${r.title}**${r.year ? ` (${r.year})` : ''}`).join(', ')}. Tap any thumbnail below to watch! 🍿😎`;
      }
      
      // Bold formatting
      replyText = replyText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
      
      // Add clickable links
      searchResults.forEach(movie => {
        if (movie.title) {
          const escapedTitle = escapeRegex(movie.title);
          const boldPattern = new RegExp(`<strong>${escapedTitle}</strong>`, 'gi');
          const link = `<a href="${SITE_URL}/#detail/${movie.subjectId}" target="_blank" style="color: #3b82f6; text-decoration: none; font-weight: 600;">${movie.title}</a>`;
          replyText = replyText.replace(boldPattern, link);
        }
      });
      
      const recommendations = searchResults.map(item => ({
        subjectId: item.subjectId,
        title: item.title,
        cover: item.cover,
        rating: item.rating,
        type: item.type,
        typeDisplay: item.typeDisplay,
        year: item.year
      }));
      
      return res.status(200).json({ 
        reply: replyText,
        recommendations: recommendations
      });
    }
    
  } catch (err) {
    console.error("Server error:", err);
    return res.status(200).json({ 
      reply: "Yo! Ready to find some movies? 🎬😎"
    });
  }
}
