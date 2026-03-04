import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { api, setToken } from '@/api/client';

export interface User {
  id: string;
  username: string;
  email: string;
  role: 'admin' | 'user';
  storage_quota: number;
  storage_used: number;
}

interface AuthResponse {
  token: string;
  user: User;
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null);
  const loading = ref(false);

  const isLoggedIn = computed(() => !!user.value);
  const isAdmin = computed(() => user.value?.role === 'admin');
  const storagePercent = computed(() => {
    if (!user.value) return 0;
    return Math.round((user.value.storage_used / user.value.storage_quota) * 100);
  });

  async function login(username: string, password: string): Promise<void> {
    loading.value = true;
    try {
      const data = await api.post<AuthResponse>('/auth/login', { username, password }, { skipAuth: true });
      setToken(data.token);
      user.value = data.user;
    } finally {
      loading.value = false;
    }
  }

  async function register(
    username: string,
    email: string,
    password: string,
    invite_code: string
  ): Promise<void> {
    loading.value = true;
    try {
      const data = await api.post<AuthResponse>(
        '/auth/register',
        { username, email, password, invite_code },
        { skipAuth: true }
      );
      setToken(data.token);
      user.value = data.user;
    } finally {
      loading.value = false;
    }
  }

  async function fetchMe(): Promise<void> {
    const token = localStorage.getItem('token');
    if (!token) return;

    loading.value = true;
    try {
      const data = await api.get<{ user: User }>('/auth/me');
      user.value = data.user;
    } catch {
      setToken(null);
      user.value = null;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.post('/auth/logout');
    } finally {
      setToken(null);
      user.value = null;
    }
  }

  async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await api.put('/auth/password', { old_password: oldPassword, new_password: newPassword });
  }

  function updateStorageUsed(delta: number): void {
    if (user.value) {
      user.value.storage_used += delta;
    }
  }

  return {
    user,
    loading,
    isLoggedIn,
    isAdmin,
    storagePercent,
    login,
    register,
    fetchMe,
    logout,
    changePassword,
    updateStorageUsed,
  };
});
