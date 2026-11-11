import type { TeamMembers } from '@shared/api/team'
import { Badge } from '@/components'
import { api, useApi } from '@/lib/api'

/** The ids on one screen that are in the team (Team mode, decision 1 A): their rows show a "team" badge. */
export function useTeamMembers(screen: keyof Omit<TeamMembers, 'plugin'>): Set<string> {
  const { data } = useApi(() => api.team.members(), [])
  return new Set(data?.[screen] ?? [])
}

export const TeamBadge = (): JSX.Element => <Badge tone="oat">team</Badge>
