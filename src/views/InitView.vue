<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api/client'

const router = useRouter()

const form = ref({
  username: '',
  email: '',
  password: '',
  confirmPassword: ''
})

const loading = ref(false)
const checking = ref(true)
const error = ref('')
const success = ref(false)
const inviteCodes = ref<string[]>([])

onMounted(async () => {
  try {
    const res = await api.get<{ initialized: boolean }>('/init', { skipAuth: true })
    if (res.initialized) {
      router.replace('/login')
    }
  } catch {
    router.replace('/login')
  } finally {
    checking.value = false
  }
})

async function handleSubmit() {
  error.value = ''
  
  if (!form.value.username || !form.value.email || !form.value.password) {
    error.value = '请填写所有必填字段'
    return
  }
  
  if (form.value.password !== form.value.confirmPassword) {
    error.value = '两次输入的密码不一致'
    return
  }
  
  if (form.value.password.length < 6) {
    error.value = '密码至少需要 6 个字符'
    return
  }

  loading.value = true
  try {
    const res = await api.post<{
      admin: { username: string }
      invite_codes: string[]
    }>('/init', {
      username: form.value.username,
      email: form.value.email,
      password: form.value.password
    }, { skipAuth: true })
    
    inviteCodes.value = res.invite_codes
    success.value = true
  } catch (e) {
    error.value = e instanceof Error ? e.message : '初始化失败'
  } finally {
    loading.value = false
  }
}

function copyCode(code: string) {
  navigator.clipboard.writeText(code)
}

function goToLogin() {
  router.push('/login')
}
</script>

<template>
  <div class="init-container">
    <div v-if="checking" class="loading">
      <p>检查系统状态...</p>
    </div>
    
    <div v-else-if="success" class="success-panel">
      <div class="success-icon">✓</div>
      <h1>系统初始化成功</h1>
      <p>管理员账户已创建，请保存以下邀请码：</p>
      
      <div class="codes-list">
        <div v-for="code in inviteCodes" :key="code" class="code-item">
          <span class="code">{{ code }}</span>
          <button @click="copyCode(code)" class="copy-btn">复制</button>
        </div>
      </div>
      
      <p class="hint">这些邀请码可用于邀请新用户注册</p>
      
      <button @click="goToLogin" class="primary-btn">前往登录</button>
    </div>
    
    <div v-else class="init-form">
      <h1>系统初始化</h1>
      <p class="subtitle">创建管理员账户以开始使用</p>
      
      <form @submit.prevent="handleSubmit">
        <div class="form-group">
          <label>用户名</label>
          <input 
            v-model="form.username" 
            type="text" 
            placeholder="3-32位字母数字下划线"
            :disabled="loading"
          />
        </div>
        
        <div class="form-group">
          <label>邮箱</label>
          <input 
            v-model="form.email" 
            type="email" 
            placeholder="admin@example.com"
            :disabled="loading"
          />
        </div>
        
        <div class="form-group">
          <label>密码</label>
          <input 
            v-model="form.password" 
            type="password" 
            placeholder="至少 6 个字符"
            :disabled="loading"
          />
        </div>
        
        <div class="form-group">
          <label>确认密码</label>
          <input 
            v-model="form.confirmPassword" 
            type="password" 
            placeholder="再次输入密码"
            :disabled="loading"
          />
        </div>
        
        <div v-if="error" class="error">{{ error }}</div>
        
        <button type="submit" class="submit-btn" :disabled="loading">
          {{ loading ? '初始化中...' : '创建管理员' }}
        </button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.init-container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0f172a;
  padding: 20px;
}

.loading {
  color: #e5e5e5;
  font-size: 18px;
}

.init-form, .success-panel {
  background: #fff;
  padding: 40px;
  border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
  width: 100%;
  max-width: 420px;
}

h1 {
  margin: 0 0 8px;
  font-size: 24px;
  color: #1e40af;
}

.subtitle {
  color: #666;
  margin: 0 0 24px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  color: #333;
}

.form-group input {
  width: 100%;
  padding: 12px;
  border: 1px solid #ddd;
  border-radius: 8px;
  font-size: 14px;
  transition: border-color 0.2s;
  box-sizing: border-box;
}

.form-group input:focus {
  outline: none;
  border-color: #3b82f6;
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.form-group input:disabled {
  background: #f5f5f5;
}

.error {
  background: #fef2f2;
  color: #991b1b;
  padding: 12px;
  border-radius: 8px;
  margin-bottom: 20px;
  font-size: 14px;
}

.submit-btn, .primary-btn {
  width: 100%;
  padding: 14px;
  background: #1e40af;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s, transform 0.2s;
}

.submit-btn:hover:not(:disabled), .primary-btn:hover {
  background: #1e3a8a;
  transform: translateY(-1px);
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.success-panel {
  text-align: center;
}

.success-icon {
  width: 64px;
  height: 64px;
  background: #22c55e;
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  margin: 0 auto 20px;
}

.codes-list {
  margin: 20px 0;
  text-align: left;
}

.code-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: #f5f5f5;
  border-radius: 6px;
  margin-bottom: 8px;
}

.code {
  flex: 1;
  font-family: monospace;
  font-size: 16px;
  font-weight: 600;
  color: #333;
}

.copy-btn {
  padding: 6px 12px;
  background: #1e40af;
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.copy-btn:hover {
  background: #1e3a8a;
}

.hint {
  color: #666;
  font-size: 14px;
  margin: 20px 0;
}
</style>
