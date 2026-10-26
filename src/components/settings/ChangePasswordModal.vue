<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useUIStore } from '@/stores/ui';
import { ApiError } from '@/api/client';

const authStore = useAuthStore();
const uiStore = useUIStore();

const oldPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const showOld = ref(false);
const showNew = ref(false);
const submitting = ref(false);
const errorMessage = ref('');
const oldInput = ref<HTMLInputElement | null>(null);

const visible = computed(() => uiStore.activeModal === 'changePassword');

// 新密码长度：后端限制 6-128
const lengthOk = computed(() => newPassword.value.length >= 6 && newPassword.value.length <= 128);
const matchOk = computed(() => !!confirmPassword.value && newPassword.value === confirmPassword.value);
const differsFromOld = computed(() => !!newPassword.value && newPassword.value !== oldPassword.value);

const canSubmit = computed(
  () =>
    !!oldPassword.value &&
    lengthOk.value &&
    matchOk.value &&
    differsFromOld.value &&
    !submitting.value
);

function reset(): void {
  oldPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';
  showOld.value = false;
  showNew.value = false;
  submitting.value = false;
  errorMessage.value = '';
}

watch(visible, async (open) => {
  if (!open) return;
  reset();
  await nextTick();
  oldInput.value?.focus();
});

function close(): void {
  if (submitting.value) return;
  uiStore.closeModal();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && visible.value) {
    close();
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

async function submit(): Promise<void> {
  errorMessage.value = '';

  if (!oldPassword.value) {
    errorMessage.value = 'Please enter your current password.';
    return;
  }
  if (!lengthOk.value) {
    errorMessage.value = 'New password must be 6-128 characters.';
    return;
  }
  if (!differsFromOld.value) {
    errorMessage.value = 'New password must be different from the current one.';
    return;
  }
  if (!matchOk.value) {
    errorMessage.value = 'The two passwords do not match.';
    return;
  }

  submitting.value = true;
  try {
    await authStore.changePassword(oldPassword.value, newPassword.value);
    const username = authStore.user?.username ?? 'user';
    uiStore.closeModal();
    uiStore.showToast(`Password updated for ${username}. Other devices were signed out.`, 'success');
  } catch (e) {
    if (e instanceof ApiError) {
      errorMessage.value =
        e.code === 'RATE_LIMITED'
          ? 'Too many attempts. Please try again later.'
          : e.message;
    } else {
      errorMessage.value = 'Failed to update password. Please try again.';
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible" class="modal-overlay" @click.self="close">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cp-title">
          <header class="modal-header">
            <div>
              <h2 id="cp-title">Change password</h2>
              <p class="subtitle">Signing in as {{ authStore.user?.username }}</p>
            </div>
            <button class="icon-btn" type="button" aria-label="Close" @click="close">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </header>

          <form class="modal-body" @submit.prevent="submit">
            <label class="field">
              <span class="field-label">Current password</span>
              <div class="input-wrap">
                <input
                  ref="oldInput"
                  v-model="oldPassword"
                  :type="showOld ? 'text' : 'password'"
                  autocomplete="current-password"
                  placeholder="Enter current password"
                />
                <button
                  type="button"
                  class="eye"
                  :aria-label="showOld ? 'Hide password' : 'Show password'"
                  @click="showOld = !showOld"
                >
                  {{ showOld ? 'Hide' : 'Show' }}
                </button>
              </div>
            </label>

            <label class="field">
              <span class="field-label">New password</span>
              <div class="input-wrap">
                <input
                  v-model="newPassword"
                  :type="showNew ? 'text' : 'password'"
                  autocomplete="new-password"
                  placeholder="At least 6 characters"
                />
                <button
                  type="button"
                  class="eye"
                  :aria-label="showNew ? 'Hide password' : 'Show password'"
                  @click="showNew = !showNew"
                >
                  {{ showNew ? 'Hide' : 'Show' }}
                </button>
              </div>
              <span class="hint" :class="{ ok: lengthOk, bad: newPassword.length > 0 && !lengthOk }">
                {{ newPassword.length }} / 6-128 characters
              </span>
            </label>

            <label class="field">
              <span class="field-label">Confirm new password</span>
              <div class="input-wrap">
                <input
                  v-model="confirmPassword"
                  :type="showNew ? 'text' : 'password'"
                  autocomplete="new-password"
                  placeholder="Repeat new password"
                />
              </div>
              <span v-if="confirmPassword" class="hint" :class="matchOk ? 'ok' : 'bad'">
                {{ matchOk ? 'Passwords match' : 'Passwords do not match' }}
              </span>
            </label>

            <p v-if="errorMessage" class="error-box">{{ errorMessage }}</p>

            <p class="notice">
              Changing your password signs out all other devices. This browser stays signed in.
            </p>

            <div class="actions">
              <button type="button" class="btn ghost" :disabled="submitting" @click="close">
                Cancel
              </button>
              <button type="submit" class="btn primary" :disabled="!canSubmit">
                {{ submitting ? 'Updating...' : 'Update password' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 300;
}

.modal {
  width: 100%;
  max-width: 460px;
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
  overflow: hidden;
  max-height: 92vh;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.5rem 1.5rem 0.75rem;
}

.modal-header h2 {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
  color: #0f172a;
}

.subtitle {
  margin: 0.25rem 0 0;
  font-size: 0.8rem;
  color: #64748b;
}

.icon-btn {
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  padding: 0.35rem;
  border-radius: 6px;
  line-height: 0;
  transition: all 0.2s;
}

.icon-btn:hover {
  background: #f1f5f9;
  color: #0f172a;
}

.modal-body {
  padding: 0.5rem 1.5rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.field-label {
  font-size: 0.8rem;
  font-weight: 500;
  color: #334155;
}

.input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.input-wrap input {
  width: 100%;
  padding: 0.7rem 3.5rem 0.7rem 0.85rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  font-size: 0.9rem;
  color: #0f172a;
  background: #fff;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.input-wrap input:focus {
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
}

.eye {
  position: absolute;
  right: 0.5rem;
  background: none;
  border: none;
  color: #64748b;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0.25rem 0.4rem;
  border-radius: 4px;
}

.eye:hover {
  color: #1e40af;
  background: #f1f5f9;
}

.hint {
  font-size: 0.72rem;
  color: #94a3b8;
}

.hint.ok {
  color: #16a34a;
}

.hint.bad {
  color: #dc2626;
}

.error-box {
  margin: 0;
  padding: 0.65rem 0.85rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  color: #b91c1c;
  font-size: 0.8rem;
}

.notice {
  margin: 0;
  font-size: 0.72rem;
  line-height: 1.5;
  color: #94a3b8;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 0.25rem;
}

.btn {
  padding: 0.65rem 1.1rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: 1px solid transparent;
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn.primary {
  background: #1e40af;
  color: #fff;
}

.btn.primary:hover:not(:disabled) {
  background: #1e3a8a;
}

.btn.ghost {
  background: #fff;
  border-color: #e2e8f0;
  color: #475569;
}

.btn.ghost:hover:not(:disabled) {
  background: #f8fafc;
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-active .modal,
.modal-leave-active .modal {
  transition: transform 0.18s ease;
}

.modal-enter-from .modal,
.modal-leave-to .modal {
  transform: translateY(8px) scale(0.98);
}
</style>
