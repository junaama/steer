interface IconProps {
  name: string
  size?: number
}

const PATHS: Record<string, JSX.Element> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-3.6-3.6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M4 12.5l5 5L20 6.5" />,
  trash: <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />,
  swap: (
    <>
      <path d="M7 10l-3 3 3 3" />
      <path d="M4 13h12a4 4 0 0 0 4-4" />
      <path d="M17 14l3-3-3-3" />
    </>
  ),
  edit: (
    <>
      <path d="M14 5l5 5" />
      <path d="M4 20l1-4L17 4l3 3L8 19l-4 1z" />
    </>
  ),
  wrench: <path d="M21 7a4 4 0 0 1-5.3 3.8L7 19.5 4.5 17l8.7-8.7A4 4 0 0 1 18 3.6l-2.6 2.6 1.4 1.4L19.4 5A4 4 0 0 1 21 7z" />,
  file: (
    <>
      <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  read: (
    <>
      <path d="M4 5h7v15H4z" />
      <path d="M13 5h7v15h-7z" />
    </>
  ),
  grep: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="M19 19l-4.5-4.5" />
    </>
  ),
  folder: <path d="M3 7a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </>
  ),
  terminal: (
    <>
      <path d="M5 7l4 4-4 4" />
      <path d="M12 16h7" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />,
  dot: <circle cx="12" cy="12" r="3" />,
}

export function Icon({ name, size = 16 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? PATHS.dot}
    </svg>
  )
}
