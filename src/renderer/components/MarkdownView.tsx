import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitFrontmatter } from '@shared/frontmatter'
import { cx } from '@/lib/cx'

export interface MarkdownViewProps {
  source: string
  /** Hide a leading `---` YAML block (default true). Show it yourself with parseFrontmatter if needed. */
  stripFrontmatter?: boolean
  className?: string
}

// Links open in the system browser (main process handles window.open); images are never loaded.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  img: ({ alt }) => <span className="md__img">{alt ? `[image: ${alt}]` : '[image]'}</span>
}

/** Rendered Markdown (GFM). Uses react-markdown; file content is never injected as HTML. */
export function MarkdownView({ source, stripFrontmatter = true, className }: MarkdownViewProps): JSX.Element {
  const text = useMemo(() => (stripFrontmatter ? splitFrontmatter(source).body : source), [source, stripFrontmatter])
  return (
    <div className={cx('md selectable', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
