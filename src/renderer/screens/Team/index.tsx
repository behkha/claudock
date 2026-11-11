import { EmptyState, PageLayout } from '@/components'
import type { ScreenProps } from '@/lib/nav'

export default function TeamScreen(_props: ScreenProps): JSX.Element {
  return (
    <PageLayout title="Team">
      <EmptyState title="No team setup yet" />
    </PageLayout>
  )
}
