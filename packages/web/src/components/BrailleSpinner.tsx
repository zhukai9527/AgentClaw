import { useState, useEffect } from "react";
import spinners from "unicode-animations";

type SpinnerName = keyof typeof spinners;

interface BrailleSpinnerProps {
  name?: SpinnerName;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Unicode braille animation spinner.
 * Zero-dependency animated text character — works everywhere.
 */
export function BrailleSpinner({
  name = "braille",
  className,
  style,
}: BrailleSpinnerProps) {
  const [frame, setFrame] = useState(0);
  const s = spinners[name];

  useEffect(() => {
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % s.frames.length),
      s.interval,
    );
    return () => clearInterval(timer);
  }, [name, s.frames.length, s.interval]);

  return (
    <span className={className} style={{ fontFamily: "monospace", ...style }}>
      {s.frames[frame]}
    </span>
  );
}
