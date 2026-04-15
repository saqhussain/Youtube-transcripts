module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const videoId = url.searchParams.get('videoId');
  const action = url.searchParams.get('action') || 'transcript';

  if (action === 'ping') {
    return res.status(200).json({ success: true, message: 'Transcript API v4 running' });
  }

  if (!videoId) return res.status(400).json({ error: 'Missing videoId parameter' });
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid videoId' });

  try {
    const result = await fetchTranscript(videoId);
    if (action === 'test') {
      return res.status(200).json({ success: true, videoId, available: result.text.length > 50, length: result.text.length, type: result.type });
    }
    return res.status(200).json({ success: true, videoId, transcript: result.text, type: result.type });
  } catch (err) {
    return res.status(200).json({ success: false, videoId, error: err.message });
  }
};

async function fetchTranscript(videoId) {
  // Fetch YouTube video page with consent cookie
  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept-Language': 'en',
      'Cookie': 'CONSENT=PENDING+987; SOCS=CAESEwgDEgk2NDcwMTQxMjQaAmVuIAEaBgiA_LyaBg'
    },
    redirect: 'follow'
  });

  if (!pageResp.ok) throw new Error('Failed to fetch YouTube page: HTTP ' + pageResp.status);
  const html = await pageResp.text();

  // Extract ytInitialPlayerResponse
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|<\/script)/s);
  if (!match) throw new Error('Could not find player data in page');

  let player;
  try { player = JSON.parse(match[1]); }
  catch(e) { throw new Error('Failed to parse player data'); }

  // Check playability
  const status = player?.playabilityStatus?.status;
  if (status === 'LOGIN_REQUIRED') throw new Error('Video is age-restricted or private');
  if (status === 'UNPLAYABLE') throw new Error('Video is unavailable');
  if (status === 'ERROR') throw new Error('Video not found');

  // Get caption tracks
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) throw new Error('No captions available');

  // Pick best English track
  const track = pickTrack(tracks);
  if (!track?.baseUrl) throw new Error('No usable caption track');

  // Decode the caption URL (YouTube uses \u0026 for &)
  let captionUrl = track.baseUrl;
  // Replace all forms of encoded ampersands
  captionUrl = captionUrl.replace(/\\u0026/g, '&');
  captionUrl = captionUrl.replace(/\u0026/g, '&');
  
  // Fetch caption XML using global fetch (handles redirects properly)
  const captionResp = await fetch(captionUrl, { redirect: 'follow' });
  if (!captionResp.ok) throw new Error('Caption fetch failed: HTTP ' + captionResp.status);
  const captionContent = await captionResp.text();

  if (!captionContent || captionContent.length < 20) {
    throw new Error('Caption response was empty (URL: ' + captionUrl.substring(0, 100) + '...)');
  }

  // Parse XML captions
  const text = parseCaptions(captionContent);
  if (!text || text.length < 10) throw new Error('Caption track was empty after parsing');

  const type = track.kind === 'asr' ? 'auto-generated' : 'manual';
  return { text, type: `${type} (${track.languageCode})` };
}

function pickTrack(tracks) {
  const tests = [
    t => t.languageCode === 'en' && t.kind !== 'asr',
    t => t.languageCode === 'en' && t.kind === 'asr',
    t => t.languageCode === 'en',
    t => t.languageCode === 'en-GB',
    t => (t.languageCode || '').startsWith('en'),
    t => t.kind !== 'asr',
    t => true
  ];
  for (const test of tests) {
    const found = tracks.find(test);
    if (found) return found;
  }
  return tracks[0];
}

function parseCaptions(content) {
  // Try XML format first
  if (content.includes('<text')) {
    const parts = [];
    const regex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = regex.exec(content)) !== null) {
      let t = m[1]
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/\n/g, ' ').trim();
      if (t) parts.push(t);
    }
    if (parts.length > 0) return parts.join(' ');
  }

  // Try JSON3 format
  try {
    const json = JSON.parse(content);
    if (json.events) {
      const parts = [];
      for (const evt of json.events) {
        if (evt.segs) {
          for (const seg of evt.segs) {
            if (seg.utf8 && seg.utf8.trim() && seg.utf8 !== '\n') parts.push(seg.utf8.trim());
          }
        }
      }
      if (parts.length > 0) return parts.join(' ');
    }
  } catch(e) {}

  return '';
}
