// Sketch editor: a plain textarea with line numbers and gcc error markers. Tab indents,
// Ctrl/Cmd+Enter compiles and runs.
import { useRef, type KeyboardEvent } from 'react';
import type { CompileResult } from './compiler';

interface Props {
  code: string;
  onChange: (code: string) => void;
  onCompile: () => void;
  diagnostics: CompileResult['diagnostics'];
}

export default function CodeEditor({ code, onChange, onCompile, diagnostics }: Props) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lines = code.split('\n').length;
  const marks = new Map(diagnostics.map((d) => [d.line, d]));

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key === 's')) {
      e.preventDefault();
      onCompile();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: t } = el;
      const next = `${code.slice(0, s)}  ${code.slice(t)}`;
      onChange(next);
      requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
    }
  };

  const jump = (line: number) => {
    const el = ta.current;
    if (!el) return;
    const offset = code.split('\n').slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);
    el.focus();
    el.setSelectionRange(offset, offset);
    el.scrollTop = (line - 4) * 19;
  };

  return (
    <div className="editor">
      <div className="editor-head mono">
        <span>sketch.ino</span>
        <span className="muted">Ctrl+Enter — compile &amp; run</span>
      </div>
      <div className="editor-body">
        <div className="gutter mono" ref={gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => {
            const m = marks.get(i + 1);
            return (
              <div key={i} className={m ? `mark ${m.level}` : undefined} title={m?.msg}>
                {i + 1}
              </div>
            );
          })}
        </div>
        <textarea
          ref={ta}
          className="code mono"
          value={code}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKey}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
      {diagnostics.length > 0 && (
        <ul className="diagnostics mono">
          {diagnostics.map((d, i) => (
            <li key={i} className={d.level} onClick={() => jump(d.line)}>
              <b>
                {d.line}:{d.col}
              </b>{' '}
              {d.level}: {d.msg}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
