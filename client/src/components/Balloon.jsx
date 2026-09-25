// The exit animation is a fixed-speed pop-out scheduled via a CSS variable
// delay, so the balloon's total on-screen time can vary per fact (word-count
// based, see useFactSync's displayDurationMs) without stretching the
// entrance/exit motion itself.
const EXIT_ANIMATION_MS = 550;

export default function Balloon({ text, slot, color, durationMs, onDismiss }) {
  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onDismiss();
    }
  }

  return (
    <div
      className={`balloon balloon--${slot} balloon--${color}`}
      style={{ '--balloon-exit-delay': `${Math.max(0, (durationMs || 9000) - EXIT_ANIMATION_MS)}ms` }}
      onClick={onDismiss}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label={text}
    >
      <p className="balloon__text">{text}</p>
      <span className="balloon__tail" aria-hidden="true" />
    </div>
  );
}
