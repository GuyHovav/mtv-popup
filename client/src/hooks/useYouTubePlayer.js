import { useEffect, useRef, useState } from 'react';

const DURATION_POLL_INTERVAL_MS = 200;
const DURATION_POLL_TIMEOUT_MS = 5000;
const FALLBACK_DURATION_SECONDS = 180;

let apiPromise = null;

function loadYouTubeIframeAPI() {
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve(window.YT);
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });

  return apiPromise;
}

/**
 * Loads and mounts a YouTube IFrame player for the given videoId, and
 * resolves a usable duration (polling getDuration() since it isn't
 * guaranteed to be populated the instant onReady fires).
 */
export function useYouTubePlayer(videoId) {
  const containerRef = useRef(null);
  const playerInstanceRef = useRef(null);
  const [player, setPlayer] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [playerError, setPlayerError] = useState(null);

  useEffect(() => {
    if (!videoId) return undefined;

    let cancelled = false;
    let pollTimer = null;

    setIsReady(false);
    setPlayer(null);
    setDuration(0);
    setPlayerError(null);

    loadYouTubeIframeAPI().then((YT) => {
      if (cancelled || !containerRef.current) return;

      const instance = new YT.Player(containerRef.current, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { rel: 0, modestbranding: 1 },
        events: {
          onReady: (event) => {
            if (cancelled) return;
            playerInstanceRef.current = event.target;
            setPlayer(event.target);

            const startedAt = Date.now();
            pollTimer = setInterval(() => {
              const currentDuration = event.target.getDuration();
              if (currentDuration && currentDuration > 0) {
                clearInterval(pollTimer);
                setDuration(currentDuration);
                setIsReady(true);
              } else if (Date.now() - startedAt > DURATION_POLL_TIMEOUT_MS) {
                clearInterval(pollTimer);
                setDuration(FALLBACK_DURATION_SECONDS);
                setIsReady(true);
              }
            }, DURATION_POLL_INTERVAL_MS);
          },
          onError: (event) => {
            if (cancelled) return;
            setPlayerError(event.data);
          },
        },
      });
      playerInstanceRef.current = instance;
    });

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
      playerInstanceRef.current?.destroy?.();
      playerInstanceRef.current = null;
    };
  }, [videoId]);

  return { containerRef, player, isReady, duration, playerError };
}
