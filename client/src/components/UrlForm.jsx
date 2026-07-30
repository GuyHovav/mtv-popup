import { useState } from 'react';
import { parseVideoId } from '../lib/youtube.js';

export default function UrlForm({ onSubmit, disabled }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);

  function handleSubmit(e) {
    e.preventDefault();
    const videoId = parseVideoId(value);
    if (!videoId) {
      setError("That doesn't look like a valid YouTube URL or video ID.");
      return;
    }
    setError(null);
    onSubmit(videoId);
  }

  return (
    <form className="url-form" onSubmit={handleSubmit}>
      <label htmlFor="youtube-url" className="url-form__label">
        Paste a YouTube link
      </label>
      <div className="url-form__row">
        <input
          id="youtube-url"
          type="text"
          className="url-form__input"
          placeholder="https://www.youtube.com/watch?v=..."
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? 'youtube-url-error' : undefined}
        />
        <button type="submit" className="url-form__button" disabled={disabled}>
          {disabled ? 'Loading…' : 'Pop it off'}
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
