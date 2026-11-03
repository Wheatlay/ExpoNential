import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import { useProjectKey } from './project.ts';
import type { ProjectDetail } from './Settings.tsx';

export const useProjectDetail = () => {
  const key = useProjectKey();
  return useQuery({ queryKey: ['project', key], queryFn: () => api<ProjectDetail>(`/api/projects/${key}`) });
};
