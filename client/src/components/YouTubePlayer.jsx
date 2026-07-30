import { useEffect } from 'react';
import { useYouTubePlayer } from '../hooks/useYouTubePlayer.js';

// YouTube IFrame API error codes: 2 (invalid param), 5 (HTML5 error),
// 100 (not found/removed), 101/150 (embedding disabled by the owner).
const EMBED_DISABLED_CODES = new Set([101, 150]);

export default function YouTubePlayer({ videoId, onReady, onFatalError }) {
  const { containerRef, player, isReady, duration, playerError } = useYouTubePlayer(videoId);

  useEffect(() => {
    if (isReady && player) {
      onReady(player, duration);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady, player, duration]);

  useEffect(() => {
    if (playerError == null) return;
    const message = EMBED_DISABLED_CODES.has(playerError)
      ? "This video's owner has disabled embedding — it can't be played here."
      : 'This video could not be played (it may have been removed).';
    onFatalError(message);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerError]);

  return (
    <div className="youtube-player">
      <div ref={containerRef} className="youtube-player__iframe" />
    </div>
  );
}
