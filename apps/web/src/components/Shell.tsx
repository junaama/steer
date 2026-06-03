import type { ReactNode } from 'react'
import { Icon } from './Icon.js'

export interface ShellProps {
  userEmail: string
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onLogout: () => void
  sidebar: ReactNode
  main: ReactNode
}

function initials(email: string): string {
  return email.slice(0, 2).toUpperCase()
}

export function Shell(props: ShellProps): JSX.Element {
  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">steer</div>
        <div className="spacer" />
        <button className="topbtn" aria-label="Toggle theme" onClick={props.onToggleTheme}>
          <Icon name={props.theme === 'dark' ? 'sun' : 'moon'} size={15} />
        </button>
        <div className="userchip">
          <span className="av">{initials(props.userEmail)}</span>
          <span>{props.userEmail}</span>
        </div>
        <button className="topbtn" onClick={props.onLogout}>
          Logout
        </button>
      </header>
      <div className="body">
        {props.sidebar}
        {props.main}
      </div>
    </div>
  )
}
