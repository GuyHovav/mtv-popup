export default function Balloon({ text, slot, color, onDismiss }) {
  function handleKeyDown(e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onDismiss();
    }
  }

  return (
    <div
      className={`balloon balloon--${slot} balloon--${color}`}
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
