import { useEffect, useState } from 'react';
import UrlForm from './components/UrlForm.jsx';
import YouTubePlayer from './components/YouTubePlayer.jsx';
import PopupLayer from './components/PopupLayer.jsx';
import { fetchOEmbed, parseVideoId } from './lib/youtube.js';
import { postFacts } from './lib/api.js';
import { useFactSync } from './hooks/useFactSync.js';
import './styles/app.css';
import './styles/balloon.css';

const STATUS_MESSAGES = {
  'fetching-meta': 'Looking up the video…',
  'loading-player': 'Loading player…',
  'fetching-facts': 'Writing trivia for this one…',
};

// TEMPORARY (share-to-app debugging): captured at module scope, i.e. before
// React mounts and before the share-param effect strips the query string, so
// it stays a faithful record of the URL the WebView actually opened. Remove
// this and the banner that renders it once share-to-app is confirmed.
const INITIAL_SEARCH = window.location.search;

export default function App() {
  const [status, setStatus] = useState('idle');
  const [errorMessage, setErrorMessage] = useState(null);
  const [videoId, setVideoId] = useState(null);
  const [meta, setMeta] = useState(null);
  const [player, setPlayer] = useState(null);
  const [duration, setDuration] = useState(null);
  const [facts, setFacts] = useState([]);
  const [degraded, setDegraded] = useState(false);

  // `facts` is passed directly (not a fresh `[]` literal per render) so its
  // reference only changes when setFacts() actually runs — otherwise the
  // sync hook's reset effect would fire on every render and loop forever.
  const { activeBalloon, dismissBalloon } = useFactSync(
    status === 'ready' ? player : null,
    facts,
  );

  function reset() {
    setStatus('idle');
    setErrorMessage(null);
    setVideoId(null);
    setMeta(null);
    setPlayer(null);
    setDuration(null);
    setFacts([]);
    setDegraded(false);
  }

  async function handleSubmit(newVideoId) {
    setErrorMessage(null);
    setStatus('fetching-meta');
    try {
      const oembed = await fetchOEmbed(newVideoId);
      setMeta(oembed);
      setVideoId(newVideoId);
      setStatus('loading-player');
    } catch {
      setStatus('error');
      setErrorMessage("Couldn't find that video — it may be private, deleted, or the link is wrong.");
    }
  }

  function handlePlayerReady(playerInstance, playerDuration) {
    setPlayer(playerInstance);
    setDuration(playerDuration);
    setStatus('fetching-facts');
  }

  function handlePlayerFatalError(message) {
    setStatus('error');
    setErrorMessage(message);
  }

  // Populated by the Android share-intent handler in MainActivity.java,
  // which redirects here as `?url=<encoded YouTube link>` when the app is
  // opened via "Share" from the YouTube app. Web visits never carry this
  // param, so this is a no-op there.
  useEffect(() => {
    const sharedUrl = new URLSearchParams(window.location.search).get('url');
    if (!sharedUrl) return;
    window.history.replaceState({}, '', window.location.pathname);
    const sharedVideoId = parseVideoId(sharedUrl);
    if (sharedVideoId) handleSubmit(sharedVideoId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (status !== 'fetching-facts') return;
    let cancelled = false;

    postFacts({
      videoId,
      title: meta.title,
      author: meta.author,
      durationSeconds: Math.round(duration),
    })
      .then((data) => {
        if (cancelled) return;
        setFacts(data.facts);
        setDegraded(Boolean(data.degraded));
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('error');
        setErrorMessage("Couldn't generate trivia for this video right now. Please try again.");
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const isBusy = status === 'fetching-meta' || status === 'loading-player' || status === 'fetching-facts';

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">📺 Pop-up Video</h1>
        <p className="app__subtitle">Paste any YouTube video and watch the trivia balloons pop.</p>
      </header>

      {/* TEMPORARY share-to-app debug banner — remove with INITIAL_SEARCH. */}
      <p
        style={{
          fontSize: '0.7rem',
          fontFamily: 'monospace',
          opacity: 0.75,
          wordBreak: 'break-all',
          margin: '0 0 0.5rem',
        }}
      >
        dbg search={INITIAL_SEARCH || '(none)'} status={status}
        {errorMessage ? ` err=${errorMessage}` : ''}
      </p>

      <UrlForm onSubmit={handleSubmit} disabled={isBusy} />

      {isBusy && <p className="app__status">{STATUS_MESSAGES[status]}</p>}

      {status === 'error' && (
        <div className="app__error">
          <p>{errorMessage}</p>
          <button type="button" onClick={reset}>
            Try another video
          </button>
        </div>
      )}

      {degraded && status === 'ready' && (
        <p className="app__degraded">
          Couldn't find much specific info on this one — showing general music trivia instead.
        </p>
      )}

      {videoId && status !== 'error' && (
        <div className="video-stage" aria-label="YouTube video player with pop-up trivia facts">
          <YouTubePlayer
            videoId={videoId}
            onReady={handlePlayerReady}
            onFatalError={handlePlayerFatalError}
          />
          {status === 'ready' && <PopupLayer balloon={activeBalloon} onDismiss={dismissBalloon} />}
        </div>
      )}
    </div>
  );
}
