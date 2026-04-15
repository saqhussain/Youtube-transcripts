const { getSubtitles, getVideoDetails } = require('youtube-caption-extractor');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const videoId = url.searchParams.get('videoId');
  const action = url.searchParams.get('action') || 'transcript';

  if (action === 'ping') {
    return res.status(200).json({ success: true, message: 'Transcript API v5 running' });
  }

  if (!videoId) return res.status(400).json({ error: 'Missing videoId parameter' });
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'Invalid videoId' });

  try {
    const subtitles = await getSubtitles({ videoID: videoId, lang: 'en' });
    
    if (!subtitles || subtitles.length === 0) {
      return res.status(200).json({ success: false, videoId, error: 'No captions available' });
    }

    const transcript = subtitles.map(s => s.text).join(' ');

    if (action === 'test') {
      return res.status(200).json({ success: true, videoId, available: transcript.length > 50, length: transcript.length });
    }

    return res.status(200).json({ success: true, videoId, transcript, type: 'caption' });
  } catch (err) {
    return res.status(200).json({ success: false, videoId, error: err.message });
  }
};
