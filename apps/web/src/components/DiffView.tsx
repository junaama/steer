import type { FileDiff } from '../lib/diff.js'

export function DiffView({ file, diff }: { file: string; diff: FileDiff }): JSX.Element {
  return (
    <div className="diff" data-testid="diff">
      <div className="diff-file">
        <span>{file}</span>
        <span style={{ marginLeft: 'auto' }} className="add">
          +{diff.add}
        </span>
        <span className="del">−{diff.del}</span>
      </div>
      <div>
        {diff.lines.map((l, i) => (
          <div className="diff-line" data-t={l.t} key={i}>
            <span className="gut">{l.n}</span>
            <span className="sign">{l.t === 'add' ? '+' : l.t === 'del' ? '−' : ''}</span>
            <span className="code">{l.code}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
