import Balloon from './Balloon.jsx';

export default function PopupLayer({ balloon, onDismiss }) {
  return (
    // A persistent live region (rather than one on the balloon itself, which
    // mounts/unmounts) so screen readers reliably announce each new fact.
    <div className="popup-layer" aria-live="polite" aria-atomic="true">
      {balloon && (
        <Balloon key={balloon.id} text={balloon.text} slot={balloon.slot} color={balloon.color} onDismiss={onDismiss} />
      )}
    </div>
  );
}
