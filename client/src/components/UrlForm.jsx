import { useState } from 'react';
import { parseVideoId } from '../lib/youtube.js';

export default function UrlForm({ onSubmit, onSearch, disabled }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);

  const looksLikeUrl = Boolean(parseVideoId(value));

  function handleSubmit(e) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Type a YouTube link or search for a video.');
      return;
    }
    const videoId = parseVideoId(trimmed);
    setError(null);
    if (videoId) {
      onSubmit(videoId);
    } else {
      onSearch(trimmed);
    }
  }

  return (
    <form className="url-form" onSubmit={handleSubmit}>
      <label htmlFor="youtube-url" className="url-form__label">
        Paste a YouTube link, or search for a video
      </label>
      <div className="url-form__row">
        <input
          id="youtube-url"
          type="text"
          className="url-form__input"
          placeholder="https://www.youtube.com/watch?v=... or search for a song"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? 'youtube-url-error' : undefined}
        />
        <button type="submit" className="url-form__button" disabled={disabled}>
          {disabled ? 'Loading…' : looksLikeUrl ? 'Pop it off' : 'Search'}
        </button>
      </div>
      {error && (
        <p id="youtube-url-error" className="url-form__error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
