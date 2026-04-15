const https = require('https');
const http = require('http');

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const videoId = url.searchParams.get('videoId') || (req.body && req.body.videoId);
  const action = url.searchParams.get('action') || 'transcript';

  if (action === 'ping') {
    return res.status(200).json({ success: true, message: 'YouTube Transcript API running' });
  }

  if (!videoId) {
    return res.status(400).json({ error: 'Missing videoId parameter' });
  }

  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId format' });
  }

  try {
    const transcript = await fetchTranscript(videoId);
    
    if (action === 'test') {
      return res.status(200).json({ 
        success: true, 
        videoId, 
        available: transcript.text.length > 50, 
        length: transcript.text.length,
        type: transcript.type 
      });
    }
    
    return res.status(200).json({ 
      success: true, 
      videoId, 
      transcript: transcript.text, 
      type: transcript.type 
    });
  } catch (err) {
    return res.status(200).json({ 
      success: false, 
      videoId, 
      error: err.message 
    });
  }
};

async function fetchTranscript(videoId) {
  // Step 1: Fetch the YouTube video page
  const pageHtml = await httpGet(`https://www.youtube.com/watch?v=${videoId}`, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept-Language': 'en',
    'Accept': 'text/html,application/xhtml+xml',
    'Cookie': 'CONSENT=PENDING+987; SOCS=CAESEwgDEgk2NDcwMTQxMjQaAmVuIAEaBgiA_LyaBg'
  });

  // Step 2: Extract caption tracks from ytInitialPlayerResponse
  const playerMatch = pageHtml.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script)/s);
  if (!playerMatch) {
    throw new Error('Could not find player response in page');
  }

  let playerData;
  try {
    playerData = JSON.parse(playerMatch[1]);
  } catch(e) {
    throw new Error('Failed to parse player response');
  }

  // Check if video is playable
  const status = playerData?.playabilityStatus?.status;
  if (status === 'LOGIN_REQUIRED') throw new Error('Video is age-restricted or private');
  if (status === 'UNPLAYABLE') throw new Error('Video is unavailable');
  if (status === 'ERROR') throw new Error('Video not found');

  const captions = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captions || captions.length === 0) {
    throw new Error('No captions available for this video');
  }

  // Step 3: Pick the best caption track
  // Priority: manual English > auto English > manual en-GB > auto en-GB > any
  const track = pickTrack(captions);
  if (!track?.baseUrl) {
    throw new Error('No usable caption track found');
  }

  // Step 4: Fetch the caption content
  const captionUrl = track.baseUrl.replace(/\\u0026/g, '&');
  const captionContent = await httpGet(captionUrl);
  
  // Step 5: Parse the caption XML
  const text = parseCaptionXml(captionContent);
  if (!text || text.length < 10) {
    throw new Error('Caption track was empty');
  }

  const type = track.kind === 'asr' ? 'auto-generated' : 'manual';
  return { text, type: `${type} (${track.languageCode})` };
}

function pickTrack(tracks) {
  const priorities = [
    t => t.languageCode === 'en' && t.kind !== 'asr',
    t => t.languageCode === 'en' && t.kind === 'asr',
    t => t.languageCode === 'en',
    t => t.languageCode === 'en-GB',
    t => t.languageCode?.startsWith('en'),
    t => t.kind !== 'asr',
    t => true
  ];

  for (const fn of priorities) {
    const match = tracks.find(fn);
    if (match) return match;
  }
  return tracks[0];
}

function parseCaptionXml(xml) {
  const parts = [];
  const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    let text = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/\n/g, ' ')
      .trim();
    if (text) parts.push(text);
  }
  return parts.join(' ');
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'Accept': '*/*',
        ...headers
      }
    };
    
    const makeRequest = (requestUrl, redirectCount = 0) => {
      if (redirectCount > 5) return reject(new Error('Too many redirects'));
      
      lib.get(requestUrl, options, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return makeRequest(response.headers.location, redirectCount + 1);
        }
        
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve(data));
        response.on('error', reject);
      }).on('error', reject);
    };
    
    makeRequest(url);
  });
}
