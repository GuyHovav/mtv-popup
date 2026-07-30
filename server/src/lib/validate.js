const VIDEO_ID_RE = /^[\w-]{11}$/;
const MAX_TEXT_LEN = 300;
const MAX_DURATION = 21600; // 6 hours

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function validateFactsRequest(body) {
  const { videoId, title, author, durationSeconds } = body ?? {};

  if (typeof videoId !== 'string' || !VIDEO_ID_RE.test(videoId)) {
    throw new ValidationError('invalid_video_id');
  }

  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new ValidationError('missing_fields');
  }

  if (typeof author !== 'string' || author.trim().length === 0) {
    throw new ValidationError('missing_fields');
  }

  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ValidationError('invalid_duration');
  }

  return {
    videoId,
    title: title.trim().slice(0, MAX_TEXT_LEN),
    author: author.trim().slice(0, MAX_TEXT_LEN),
    durationSeconds: Math.min(durationSeconds, MAX_DURATION),
  };
}

export { ValidationError };
