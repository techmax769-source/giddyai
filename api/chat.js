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

// ✅ FIXED MOVIE DETECTION
function isExplicitlyAskingForMovies(prompt) {
  const lower = prompt.toLowerCase();

  if (isAskingAboutIdentity(prompt)) return false;

  const movieSearchKeywords = [
    'recommend',
    'suggest',
    'search for',
    'find me',
    'show me',
    'looking for',
    'movie about',
    'series about',
    'films like',
    'what can you say about',
    'tell me about',
    'who stars in',
    'how many seasons',
    'episodes of',
    'about this movie',
    'about this series'
  ];

  return movieSearchKeywords.some(k => lower.includes(k));
}

// ✅ FIXED SEARCH TOPIC EXTRACTION
function extractSearchTopic(prompt) {
  let topic = prompt;

  topic = topic.replace(
    /recommend|suggest|search for|find me|show me|looking for|movie about|series about|films like|what can you say about|tell me about|who stars in|how many seasons|episodes of|about this movie|about this series/gi,
    ''
  );

  topic = topic.replace(/\b(movie|series|film|show|bro)\b/gi, '');
  topic = topic.replace(/[?]/g, '');
  topic = topic.trim();

  return topic.length >= 2 ? topic : null;
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
        reply: `⏰ Chill for ${rateCheck.waitTime} seconds bro! 😎`,
        recommendations: []
      });
    }

    const isIdentityQuestion = isAskingAboutIdentity(prompt);
    const explicitlyAskingForMovies = isExplicitlyAskingForMovies(prompt);

    let searchResults = [];

    if (explicitlyAskingForMovies && !isIdentityQuestion) {
      const searchTopic = extractSearchTopic(prompt);
      console.log(`Searching for movies: "${searchTopic}"`);

      if (searchTopic && searchTopic.length > 2) {
        searchResults = await searchMaxMovies(searchTopic, 5);
      }

      if (searchResults.length === 0 && searchTopic) {
        searchResults = await searchMaxMovies('popular', 5);
      }
    }

    if (explicitlyAskingForMovies && searchResults.length > 0) {
      let replyText = `🎬 Here's ${searchResults.map(r => `**${r.title}**${r.year ? ` (${r.year})` : ''}`).join(', ')}. Tap any thumbnail below to watch! 🍿😎`;

      replyText = replyText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

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

    if (process.env.GEMINI_API_KEY) {
      try {
        let systemPrompt = `You are MaxMovies AI, a friendly and helpful assistant. 

Your identity:
- Name: MaxMovies AI
- Creator: Max, a 21-year-old developer from Kenya

Guidelines:
- Be friendly, use emojis occasionally 😎 🎬 🍿
- Keep responses short and natural (1-3 sentences max)
- If someone asks for movie recommendations, tell them to ask explicitly (e.g., "recommend action movies")
- DO NOT make up movie titles or recommendations
- DO NOT mention being an AI or language model
- Just be a cool helpful friend

User asked: "${prompt}"

Respond naturally:`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const geminiResponse = await fetch(
          `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 150,
              },
            }),
          }
        );

        clearTimeout(timeoutId);

        if (geminiResponse.ok) {
          const result = await geminiResponse.json();
          let replyText = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";

          if (replyText) {
            replyText = replyText.replace(/as an ai|as an AI|language model|gemini|google/gi, '');
            replyText = replyText.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

            return res.status(200).json({
              reply: replyText,
              recommendations: []
            });
          }
        }
      } catch (error) {
        console.error("Gemini error:", error);
      }
    }

    let fallbackReply = "";
    const lowerPrompt = prompt.toLowerCase();

    if (lowerPrompt.includes('hello') || lowerPrompt.includes('hi') || lowerPrompt.includes('hey')) {
      fallbackReply = "Hey there! Ready to find some awesome movies? 🎬😎 Just ask me to recommend something!";
    } else if (isIdentityQuestion) {
      if (lowerPrompt.includes('name') || lowerPrompt.includes('who are you')) {
        fallbackReply = "I'm **MaxMovies AI**! Your friendly movie buddy 🎬😎";
      } else {
        fallbackReply = "Created by **Max**, a 21-year-old developer from Kenya! 🎬🔥";
      }
    } else if (explicitlyAskingForMovies && searchResults.length === 0) {
      fallbackReply = "Hmm, couldn't find any movies matching that. Try something else? 🎬😅";
    } else {
      fallbackReply = "Hey! I'm MaxMovies AI. Ask me to recommend movies or series, or just chat with me! 🎬😎";
    }

    fallbackReply = fallbackReply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    return res.status(200).json({
      reply: fallbackReply,
      recommendations: []
    });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(200).json({
      reply: "Hey! I'm MaxMovies AI. What's up? 🎬😎",
      recommendations: []
    });
  }
}
