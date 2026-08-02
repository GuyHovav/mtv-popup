export default function SuggestedVideos({ videos, onSelect }) {
  if (!videos || videos.length === 0) return null;

  return (
    <div className="suggested-videos" aria-label="Suggested videos">
      <h2 className="suggested-videos__title">More like this</h2>
      <div className="suggested-videos__row">
        {videos.map((video) => (
          <button
            key={video.videoId}
            type="button"
            className="suggested-videos__card"
            onClick={() => onSelect(video.videoId)}
          >
            <img className="suggested-videos__thumb" src={video.thumbnailUrl} alt="" loading="lazy" />
            <span className="suggested-videos__card-title">{video.title}</span>
            <span className="suggested-videos__card-channel">{video.channelTitle}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
