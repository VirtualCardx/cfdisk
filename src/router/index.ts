import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/init',
      name: 'init',
      component: () => import('@/views/InitView.vue'),
      meta: { public: true },
    },
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { guest: true },
    },
    {
      path: '/register',
      name: 'register',
      component: () => import('@/views/RegisterView.vue'),
      meta: { guest: true },
    },
    {
      path: '/s/:token',
      name: 'shared',
      component: () => import('@/views/SharedFileView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      redirect: '/drive',
    },
    {
      path: '/drive',
      name: 'drive',
      component: () => import('@/views/DriveView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/drive/folder/:id',
      name: 'folder',
      component: () => import('@/views/DriveView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/drive/trash',
      name: 'trash',
      component: () => import('@/views/TrashView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/drive/shares',
      name: 'shares',
      component: () => import('@/views/SharesView.vue'),
      meta: { requiresAuth: true },
    },
    {
      path: '/admin',
      name: 'admin',
      component: () => import('@/views/AdminView.vue'),
      meta: { requiresAuth: true, requiresAdmin: true },
    },
  ],
});

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore();

  if (!authStore.user && localStorage.getItem('token')) {
    await authStore.fetchMe();
  }

  if (to.meta.public) {
    next();
    return;
  }

  if (to.meta.guest && authStore.isLoggedIn) {
    next('/drive');
    return;
  }

  if (to.meta.requiresAuth && !authStore.isLoggedIn) {
    next({ name: 'login', query: { redirect: to.fullPath } });
    return;
  }

  if (to.meta.requiresAdmin && !authStore.isAdmin) {
    next('/drive');
    return;
  }

  next();
});

export default router;
