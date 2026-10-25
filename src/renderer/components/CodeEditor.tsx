import { useCallback, useEffect, useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { linter, lintGutter } from '@codemirror/lint'
import { EditorView, keymap } from '@codemirror/view'
import { Prec, type Extension } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import { cx } from '@/lib/cx'

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language: 'json' | 'markdown'
  readOnly?: boolean
  /** CSS height, e.g. 320 or '100%'. Default: grows with content up to `maxHeight`. */
  height?: number | string
  minHeight?: number | string
  maxHeight?: number | string
  /** Called on Mod-S. */
  onSave?: () => void
  lineNumbers?: boolean
  /** Moves the cursor to this character offset and scrolls it into view when it changes (e.g. from a palette result). */
  revealOffset?: number | null
  /** Extra CodeMirror extensions (completion, hover, lint). Memoize them: a new array reconfigures the editor. */
  extensions?: Extension[]
  'aria-label': string
  className?: string
}

/** Returns the JSON parse error message, or null if `text` is valid JSON. Use to disable Save. */
export function jsonError(text: string): string | null {
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

/** Editor theme and highlight style built ONLY from CSS variables, so one theme serves light and dark. */
const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--surface)', fontSize: '13px', height: '100%' },
  '&.cm-focused': { outline: '2px solid var(--focus)', outlineOffset: '-1px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--text)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-soft)'
  },
  '.cm-activeLine': { backgroundColor: 'var(--hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--text-2)' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-3)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: 'var(--selected)', outline: 'none' },
  // panels (search, Ctrl-Shift-M warning list): the editor has no dark flag, so CodeMirror's light base colours would stay
  '.cm-panels': { backgroundColor: 'var(--surface-sunken)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '0.5px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '0.5px solid var(--border)' },
  '.cm-panel.cm-panel-lint ul [aria-selected]': { backgroundColor: 'var(--selected)' },
  '.cm-panel.cm-panel-lint ul:focus [aria-selected]': { backgroundColor: 'var(--selected)', color: 'var(--text)' },
  '.cm-panel input, .cm-panel button': { color: 'var(--text)', backgroundColor: 'var(--surface)', border: '0.5px solid var(--border-strong)', borderRadius: '6px' },
  '.cm-tooltip': { backgroundColor: 'var(--surface)', border: '0.5px solid var(--border-strong)', borderRadius: '8px', color: 'var(--text)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger)' },
  '.cm-diagnostic-error': { borderLeft: 'none', color: 'var(--danger)' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warning)', textUnderlineOffset: '2px' },
  '.cm-diagnostic-warning': { borderLeft: 'none', color: 'var(--warning)' },
  '.cm-lint-marker-warning': { content: 'none', backgroundColor: 'var(--warning)', clipPath: 'polygon(50% 8%, 96% 92%, 4% 92%)' },
  // completion popup and docs cards (the assist extension in screens/Settings/assist.ts)
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px', maxHeight: '15em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 10px', display: 'flex', alignItems: 'baseline', gap: '14px', lineHeight: '1.6' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--selected)', color: 'var(--text)' },
  '.cm-completionLabel': { flex: '1 1 auto' },
  '.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'normal', margin: '0' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  '.cm-completionInfo': {
    fontFamily: 'var(--font-sans)',
    fontSize: '13px',
    lineHeight: '1.5',
    padding: '10px 12px',
    maxWidth: '320px',
    width: 'max-content',
    boxSizing: 'border-box',
    color: 'var(--text-2)'
  },
  '.cm-completionInfo.cm-completionInfo-right': { marginLeft: '6px' },
  '.cm-completionInfo.cm-completionInfo-left': { marginRight: '6px' },
  '.cm-tooltip-hover > .cm-doc': { maxWidth: '340px', padding: '10px 12px', fontFamily: 'var(--font-sans)', fontSize: '13px', lineHeight: '1.5', color: 'var(--text-2)' },
  '.cm-doc-key': { fontFamily: 'var(--font-mono)', fontSize: '12px', fontWeight: '600', color: 'var(--text)', overflowWrap: 'anywhere' },
  '.cm-doc-summary': { margin: '4px 0 0' },
  '.cm-doc-meta': { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 12px', margin: '8px 0 0', fontSize: '12px' },
  '.cm-doc-meta dt': { color: 'var(--text-3)' },
  '.cm-doc-meta dd': { margin: '0', color: 'var(--text)', overflowWrap: 'anywhere' },
  '.cm-doc-link': { display: 'inline-block', marginTop: '8px', fontSize: '12px', color: 'var(--focus)', textDecoration: 'none' },
  '.cm-doc-link:hover': { textDecoration: 'underline' },
  '.cm-doc-hint': { margin: '2px 0 0', fontSize: '11px', color: 'var(--text-3)' },
  '.cm-placeholder': { color: 'var(--text-3)' }
})

const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--text)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--success)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--focus)' },
  { tag: [t.punctuation, t.separator, t.bracket, t.brace, t.squareBracket], color: 'var(--text-3)' },
  { tag: t.comment, color: 'var(--text-3)', fontStyle: 'italic' },
  { tag: t.heading, color: 'var(--text)', fontWeight: '500' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, color: 'var(--focus)' },
  { tag: t.url, color: 'var(--focus)', textDecoration: 'underline' },
  { tag: t.quote, color: 'var(--text-2)' },
  { tag: [t.monospace, t.processingInstruction, t.contentSeparator], color: 'var(--text-2)' },
  { tag: t.meta, color: 'var(--text-3)' },
  { tag: t.invalid, color: 'var(--danger)' }
])

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly,
  height,
  minHeight = 120,
  maxHeight,
  onSave,
  lineNumbers = true,
  revealOffset,
  extensions: extra,
  className,
  ...rest
}: CodeEditorProps): JSX.Element {
  // keep the latest onSave in a ref so a new callback each render does not reconfigure the editor
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  const hasSave = !!onSave
  const viewRef = useRef<EditorView | null>(null)
  const reveal = useCallback((view: EditorView, offset: number | null | undefined): void => {
    if (offset === null || offset === undefined) return
    const at = Math.max(0, Math.min(offset, view.state.doc.length))
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
  }, [])
  useEffect(() => {
    if (viewRef.current) reveal(viewRef.current, revealOffset)
  }, [revealOffset, reveal])

  const extensions = useMemo<Extension[]>(() => {
    const ext: Extension[] = [theme, syntaxHighlighting(highlight)]
    if (language === 'json') ext.push(json(), linter(jsonParseLinter()), lintGutter())
    else ext.push(markdown({ base: markdownLanguage }), EditorView.lineWrapping)
    ext.push(EditorView.contentAttributes.of({ 'aria-label': rest['aria-label'] }))
    if (hasSave) {
      ext.push(
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                onSaveRef.current?.()
                return true
              }
            }
          ])
        )
      )
    }
    if (extra) ext.push(...extra)
    return ext
  }, [language, hasSave, extra, rest['aria-label']]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cx('code-editor selectable', className)}>
      <CodeMirror
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        editable={!readOnly}
        theme="none"
        height={typeof height === 'number' ? `${height}px` : height}
        minHeight={typeof minHeight === 'number' ? `${minHeight}px` : minHeight}
        maxHeight={typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight}
        extensions={extensions}
        onCreateEditor={(view) => {
          viewRef.current = view
          reveal(view, revealOffset)
        }}
        basicSetup={{
          lineNumbers,
          foldGutter: false,
          highlightActiveLine: !readOnly,
          highlightActiveLineGutter: !readOnly,
          autocompletion: false,
          searchKeymap: true,
          dropCursor: false,
          allowMultipleSelections: false
        }}
      />
    </div>
  )
}
