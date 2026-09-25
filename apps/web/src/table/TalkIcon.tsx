/**
 * Icon set for table talk. Drawn inline rather than pulled from an icon font
 * or emoji so the controls stay crisp, monochrome, and identical on every
 * platform — emoji rendered as full-colour pictures next to the quiet line
 * work of the rest of the table.
 */

export type TalkIconName = 'mic' | 'micOff' | 'cam' | 'camOff' | 'leave';

export function TalkIcon({ name, size = 15 }: { name: TalkIconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  switch (name) {
    case 'mic':
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
          <path d="M12 18v3M9 21h6" />
        </svg>
      );
    case 'micOff':
      return (
        <svg {...common}>
          <path d="M9 6a3 3 0 0 1 6 0v5" />
          <path d="M15 13.5a3 3 0 0 1-6-1.5" />
          <path d="M5.5 11.5a6.5 6.5 0 0 0 9.9 5.6M18.5 11.5a6.4 6.4 0 0 1-.5 2.5" />
          <path d="M12 18v3M9 21h6" />
          <path d="m4 4 16 16" />
        </svg>
      );
    case 'cam':
      return (
        <svg {...common}>
          <rect x="3" y="6.5" width="12" height="11" rx="3" />
          <path d="M15 11.2l5-2.7v7l-5-2.7z" />
        </svg>
      );
    case 'camOff':
      return (
        <svg {...common}>
          <path d="M15 12.7V14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3h1.5" />
          <path d="M11 6.5h1a3 3 0 0 1 3 3v.8l5-2.8v7l-2.6-1.4" />
          <path d="m4 4 16 16" />
        </svg>
      );
    case 'leave':
      return (
        <svg {...common}>
          <path d="M15 5.5H6.5A2.5 2.5 0 0 0 4 8v8a2.5 2.5 0 0 0 2.5 2.5H15" />
          <path d="M12 12h9M18 8.5 21.5 12 18 15.5" />
        </svg>
      );
  }
}
