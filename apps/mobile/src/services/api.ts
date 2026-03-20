// ============================================================
// Mobile API Client
// Handles auth tokens, refresh, and typed requests
// ============================================================

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.jobhunter.ai';

let accessToken: string | null = null;

export function setToken(token: string | null) { accessToken = token; }
export function getToken() { return accessToken; }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? `HTTP ${res.status}`);
  return data.data as T;
}

export const api = {
  auth: {
    login:    (email: string, password: string) =>
      request<{ accessToken: string; refreshToken: string }>('/auth/login', {
        method: 'POST', body: JSON.stringify({ email, password }),
      }),
    register: (name: string, email: string, password: string) =>
      request<{ accessToken: string }>('/auth/register', {
        method: 'POST', body: JSON.stringify({ name, email, password }),
      }),
    logout:   () => request('/auth/logout', { method: 'POST' }),
  },
  jobs: {
    list:    (params?: { page?: number; limit?: number }) =>
      request<{ items: unknown[]; total: number }>(`/api/v1/jobs?${new URLSearchParams(params as Record<string,string>)}`),
    trigger: () => request('/api/v1/discovery/trigger', { method: 'POST' }),
  },
  applications: {
    list:   () => request<unknown[]>('/api/v1/applications'),
    get:    (id: string) => request<unknown>(`/api/v1/applications/${id}`),
  },
  profile: {
    get:    () => request<unknown>('/api/v1/user/profile'),
    update: (data: unknown) => request('/api/v1/user/profile', { method: 'PUT', body: JSON.stringify(data) }),
  },
};
