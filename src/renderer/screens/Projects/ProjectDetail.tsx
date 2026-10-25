import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FolderOpen, Trash2, Eraser } from 'lucide-react'
import type { CleanupPreview, ProjectSummary, SessionSummary } from '@shared/api/projects'
import { formatBytes, formatCount, formatDateTime, formatRelative, tildify } from '@shared/format'
import {
  Badge,
  Button,
  ConfirmDialog,
  DetailPane,
  EmptyState,
  SearchField,
  Select,
  Spinner,
  useToast
} from '@/components'
import { api, useApi } from '@/lib/api'
import { SessionTable } from './SessionTable'
import { Transcript } from './Transcript'

const DAYS = [30, 60, 90, 180]
const TITLE_BATCH = 30

interface Props {
  project: ProjectSummary
  /** Full size when known (transcripts, sibling folders, memory). */
  bytes: number
  sessionId: string | undefined
  onOpenSession: (sessionId: string | undefined) => void
  /** Sessions were trashed: refresh the project list. */
  onChanged: () => void
  /** The whole project folder was trashed. */
  onGone: () => void
}

type Dialog = { kind: 'session'; session: SessionSummary } | { kind: 'cleanup' } | { kind: 'project' } | null

export function ProjectDetail({ project, bytes, sessionId, onOpenSession, onChanged, onGone }: Props): JSX.Element {
  const toast = useToast()
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState('')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [days, setDays] = useState(90)
  const [preview, setPreview] = useState<CleanupPreview | null>(null)
  const [version, setVersion] = useState(0)

  const cfg = useApi(() => api.system.configInfo(), [])
  const absOf = (rel: string): string => (cfg.data ? tildify(`${cfg.data.configDir}${cfg.data.sep}${rel}`, cfg.data.home) : rel)

  // Titles are read on demand: the table asks for the rows in (or near) its viewport, and for everything once a filter
  // is typed (so it can match titles). A queue with the visible rows first feeds `projects.titles` in small batches.
  const generation = useRef(0)
  const requested = useRef(new Set<string>())
  const queue = useRef<string[]>([])
  const pumping = useRef(false)
  const pump = useCallback(async (): Promise<void> => {
    if (pumping.current) return
    pumping.current = true
    const gen = generation.current
    while (queue.current.length > 0 && gen === generation.current) {
      const batch = queue.current.splice(0, TITLE_BATCH)
      let got: Record<string, string> = {}
      try {
        got = await api.projects.titles(project.id, batch)
      } catch {
        /* titles are optional */
      }
      if (gen !== generation.current) return
      const next: Record<string, string> = {}
      for (const id of batch) next[id] = got[id] ?? '' // an id with no answer stops showing "Reading title…"
      setTitles((prev) => ({ ...prev, ...next }))
    }
    if (gen === generation.current) pumping.current = false
  }, [project.id])
  const wantTitles = useCallback(
    (ids: string[], urgent: boolean): void => {
      const need = ids.filter((id) => !requested.current.has(id))
      if (need.length === 0) return
      for (const id of need) requested.current.add(id)
      queue.current = urgent ? [...need, ...queue.current] : [...queue.current, ...need]
      void pump()
    },
    [pump]
  )
  const onVisible = useCallback((ids: string[]) => wantTitles(ids, true), [wantTitles])

  // the session list; titles load lazily
  useEffect(() => {
    let live = true
    generation.current++
    requested.current = new Set()
    queue.current = []
    pumping.current = false
    setSessions(null)
    setError(null)
    setTitles({})
    setFilter('')
    api.projects.sessions(project.id).then(
      (list) => live && setSessions(list),
      (e: Error) => live && setError(e.message)
    )
    const gen = generation
    return () => {
      live = false
      gen.current++
    }
  }, [project.id, version])

  // a filter matches titles, so load them all in the background once the user starts typing
  useEffect(() => {
    if (filter.trim() && sessions) wantTitles(sessions.map((s) => s.id), false)
  }, [filter, sessions, wantTitles])

  // cleanup preview follows the chosen number of days
  useEffect(() => {
    if (dialog?.kind !== 'cleanup') return
    let live = true
    setPreview(null)
    api.projects.cleanupPreview(project.id, days).then(
      (p) => live && setPreview(p),
      (e: Error) => live && toast(e.message, { kind: 'error' })
    )
    return () => {
      live = false
    }
  }, [dialog?.kind, days, project.id, toast])

  const shown = useMemo(() => {
    if (!sessions) return []
    const q = filter.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => (titles[s.id] ?? '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q))
  }, [sessions, titles, filter])

  const session = sessionId ? sessions?.find((s) => s.id === sessionId) : undefined

  async function run(task: () => Promise<void>, done: string): Promise<void> {
    setBusy(true)
    try {
      await task()
      toast(done, { kind: 'success' })
    } catch (e) {
      toast((e as Error).message, { kind: 'error' })
    } finally {
      setBusy(false)
      setDialog(null)
    }
  }

  const reveal = (): void => {
    api.projects.revealFolder(project.id).catch((e: Error) => toast(e.message, { kind: 'error' }))
  }

  const dialogs = (
    <>
      <ConfirmDialog
        open={dialog?.kind === 'session'}
        tone="danger"
        busy={busy}
        title="Move this session to Trash?"
        description={
          dialog?.kind === 'session' ? (
            <p>
              The transcript ({formatBytes(dialog.session.bytes)}
              {dialog.session.hasSidecar ? ' and its sub-agent and tool-result folder' : ''}) goes to the Trash. You can put it back from there.
              Claude Code will no longer be able to resume it.
            </p>
          ) : null
        }
        confirmLabel="Move to Trash"
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (dialog?.kind !== 'session') return
          const s = dialog.session
          void run(async () => {
            await api.projects.trashSession(project.id, s.id)
            if (sessionId === s.id) onOpenSession(undefined)
            setVersion((v) => v + 1)
            onChanged()
          }, 'Moved to Trash.')
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'cleanup'}
        tone="danger"
        busy={busy}
        title="Clean up old sessions"
        description={
          <div className="prj-dialog-body">
            <Select
              label="Older than"
              value={String(days)}
              onChange={(v) => setDays(Number(v))}
              options={DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
            />
            {preview === null ? (
              <p>
                <Spinner size={14} label="Counting" />
              </p>
            ) : preview.count === 0 ? (
              <p>No sessions in this project are older than {days} days.</p>
            ) : (
              <p>
                {formatCount(preview.count)} {preview.count === 1 ? 'session' : 'sessions'}, {formatBytes(preview.bytes)}, will move to the Trash,
                together with their sub-agent and tool-result folders.
              </p>
            )}
          </div>
        }
        confirmLabel={preview && preview.count > 0 ? `Move ${formatCount(preview.count)} to Trash` : 'Close'}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          if (!preview || preview.count === 0) return setDialog(null)
          void run(async () => {
            // only the sessions the dialog listed: one resumed since the preview is not trashed
            const r = await api.projects.cleanup(project.id, days, preview.sessionIds)
            if (sessionId && r.sessionIds.includes(sessionId)) onOpenSession(undefined)
            setVersion((v) => v + 1)
            onChanged()
          }, 'Moved to Trash.')
        }}
      />
      <ConfirmDialog
        open={dialog?.kind === 'project'}
        tone="danger"
        busy={busy}
        title={`Move the project folder for “${project.name}” to Trash?`}
        description={
          <>
            <p>
              This moves <code>projects/{project.id}</code> out of your Claude folder: all {formatCount(project.sessions)} sessions
              {project.hasMemory ? ', the memory files inside it' : ''} and everything else in it ({formatBytes(bytes)}).
            </p>
            <p style={{ marginTop: 8 }}>
              Your real project folder{project.path ? ` (${project.path})` : ''} is not touched. Claude Code can no longer resume these sessions
              or load this project&rsquo;s memory. You can restore them from the Trash.
            </p>
          </>
        }
        confirmLabel="Move project to Trash"
        onCancel={() => setDialog(null)}
        onConfirm={() =>
          void run(async () => {
            await api.projects.trashProject(project.id)
            onGone()
          }, 'Moved to Trash.')
        }
      />
    </>
  )

  /* ---------------- transcript view */
  if (sessionId) {
    if (!sessions && !error) {
      return (
        <DetailPane title="Session">
          <Spinner />
        </DetailPane>
      )
    }
    if (!session) {
      return (
        <DetailPane
          title="Session not found"
          actions={
            <Button icon={<ArrowLeft size={15} />} onClick={() => onOpenSession(undefined)}>
              Back to sessions
            </Button>
          }
        >
          <p style={{ color: 'var(--text-2)' }}>This transcript is no longer in the project folder.</p>
        </DetailPane>
      )
    }
    return (
      <>
        <DetailPane
          title={titles[session.id] || 'Untitled session'}
          path={absOf(session.rel)}
          reveal={session.rel}
          badges={<Badge tone="oat">{project.name}</Badge>}
          actions={
            <>
              <Button icon={<ArrowLeft size={15} />} onClick={() => onOpenSession(undefined)}>
                Sessions
              </Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setDialog({ kind: 'session', session })}>
                Move to Trash
              </Button>
            </>
          }
        >
          <Transcript projectId={project.id} sessionId={session.id} totalBytes={session.bytes} />
        </DetailPane>
        {dialogs}
      </>
    )
  }

  /* ---------------- project view */
  return (
    <>
      <DetailPane
        title={project.name}
        path={project.path ?? absOf(`projects/${project.id}`)}
        reveal={false}
        badges={project.missing ? <Badge tone="danger">Folder missing</Badge> : undefined}
        actions={
          <>
            <Button icon={<FolderOpen size={15} />} onClick={reveal} disabled={!project.path || project.missing}>
              Reveal
            </Button>
            <Button icon={<Eraser size={15} />} onClick={() => setDialog({ kind: 'cleanup' })} disabled={project.sessions === 0}>
              Clean up older than…
            </Button>
            <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setDialog({ kind: 'project' })}>
              Move project to Trash
            </Button>
          </>
        }
      >
        <dl className="prj-stats">
          <div className="prj-stat">
            <dt>Sessions</dt>
            <dd>{formatCount(project.sessions)}</dd>
          </div>
          <div className="prj-stat">
            <dt>Size in Claude folder</dt>
            <dd>{formatBytes(bytes)}</dd>
          </div>
          <div className="prj-stat">
            <dt>Last active</dt>
            <dd title={formatDateTime(project.lastActiveMs)}>{formatRelative(project.lastActiveMs)}</dd>
          </div>
          <div className="prj-stat">
            <dt>Folder</dt>
            <dd style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-small)' }} className="selectable">
              projects/{project.id}
            </dd>
          </div>
        </dl>

        <h2 className="prj-sessions__heading">Sessions</h2>
        {error ? (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        ) : !sessions ? (
          <Spinner />
        ) : sessions.length === 0 ? (
          <EmptyState title="No sessions" description="This folder has no transcripts. It may only hold memory files." />
        ) : (
          <>
            <div className="prj-sessions__bar">
              <SearchField value={filter} onChange={setFilter} placeholder="Filter sessions by title" />
            </div>
            <SessionTable sessions={shown} titles={titles} onOpen={onOpenSession} onVisible={onVisible} />
          </>
        )}
      </DetailPane>
      {dialogs}
    </>
  )
}
