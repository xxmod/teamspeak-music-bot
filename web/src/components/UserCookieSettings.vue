<template>
  <div class="user-cookie-settings">
    <h2 class="section-title">
      <Icon icon="mdi:account-key-outline" class="title-icon" />
      个人音乐凭据
    </h2>
    <p class="section-desc">
      配置各平台的个人音乐凭据。配置后，音乐库中的个人歌单收藏夹、发现页每日推荐以及酷狗/网易云私人电台将使用此Cookie。
    </p>

    <div v-if="loading" class="qr-loading">
      <Icon icon="mdi:loading" class="spin" />
      加载凭据信息中...
    </div>

    <div v-else-if="visiblePlatforms.length === 0" class="empty-platforms">
      <Icon icon="mdi:information-outline" class="empty-icon" />
      <span>当前服务端配置未启用任何支持个人凭据的音乐平台</span>
    </div>

    <div v-else class="account-cards-list">
      <div v-for="p in visiblePlatforms" :key="p.id" class="account-card">
        <div class="account-header">
          <Icon :icon="p.icon" class="account-icon" :class="p.iconClass" />
          <div class="account-info">
            <div class="account-name">{{ p.name }}</div>
            <div class="account-status" :class="{ logged: isConfigured(p.id) }">
              {{ isConfigured(p.id) ? '已配置' : '未配置' }}
            </div>
          </div>
        </div>

        <div class="login-methods">
          <button
            class="login-btn"
            :class="{ active: activeMode[p.id] === 'qr' }"
            @click="toggleQrMode(p.id)"
            :disabled="qrStates[p.id]?.loading"
          >
            <Icon icon="mdi:qrcode" />
            扫码登录
          </button>
          <button
            class="login-btn"
            :class="{ active: activeMode[p.id] === 'cookie' }"
            @click="toggleCookieMode(p.id)"
          >
            <Icon icon="mdi:cookie" />
            Cookie登录
          </button>
          <button
            v-if="isConfigured(p.id)"
            class="login-btn btn-clear"
            :disabled="deleting[p.id]"
            @click="deleteCookie(p.id)"
            title="清空此平台的个人配置"
          >
            <Icon icon="mdi:delete-outline" />
            {{ deleting[p.id] ? '清空中...' : '清空配置' }}
          </button>
        </div>

        <!-- Playback History Reporting Option -->
        <div v-if="isConfigured(p.id) && p.supportsHistory" class="history-option-wrap">
          <div class="history-option" :class="{ enabled: isHistoryEnabled(p.id) }">
            <div class="history-icon-box">
              <Icon icon="mdi:history" class="history-icon" />
            </div>
            <div class="history-text">
              <div class="history-header-line">
                <span class="history-label">记录播放历史到平台</span>
              </div>
            </div>
            <label class="switch-toggle" :title="isHistoryEnabled(p.id) ? '点击关闭历史记录上报' : '点击开启历史记录上报'">
              <input
                type="checkbox"
                :checked="isHistoryEnabled(p.id)"
                :disabled="togglingHistory[p.id]"
                @change="toggleHistory(p.id, $event)"
              />
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>

        <!-- QR Code Section -->
        <div v-if="activeMode[p.id] === 'qr'" class="qr-section">
          <div v-if="qrStates[p.id]?.loading" class="qr-loading">
            <Icon icon="mdi:loading" class="spin" />
            生成二维码中...
          </div>
          <div v-else-if="qrStates[p.id]?.dataUrl" class="qr-wrap">
            <img :src="qrStates[p.id].dataUrl" class="qr-image" alt="QR Code" />
            <div class="qr-status" :class="qrStates[p.id].status">
              <template v-if="qrStates[p.id].status === 'waiting'">
                <Icon icon="mdi:cellphone" /> 请使用{{ p.qrApp }}APP扫码
              </template>
              <template v-else-if="qrStates[p.id].status === 'scanned'">
                <Icon icon="mdi:check" /> 已扫码，请在手机上确认
              </template>
              <template v-else-if="qrStates[p.id].status === 'confirmed'">
                <Icon icon="mdi:check-circle" /> 配置成功!
              </template>
              <template v-else-if="qrStates[p.id].status === 'expired'">
                <Icon icon="mdi:refresh" /> 二维码已过期
                <button class="btn-link" @click="startQr(p.id)">重新生成</button>
              </template>
            </div>
          </div>
        </div>

        <!-- Cookie Section -->
        <div v-if="activeMode[p.id] === 'cookie'" class="cookie-section">
          <div v-if="p.cookieTip" class="cookie-tip">
            <Icon icon="mdi:information-outline" /> {{ p.cookieTip }}
          </div>
          <textarea
            v-model="cookieInputs[p.id]"
            class="textarea"
            :placeholder="p.cookiePlaceholder"
            rows="3"
          />
          <button
            class="btn-primary btn-save"
            :disabled="saving[p.id] || !cookieInputs[p.id]?.trim()"
            @click="saveCookie(p.id)"
          >
            {{ saving[p.id] ? '保存中...' : '保存Cookie' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import QRCode from 'qrcode';
import { usePlayerStore } from '../stores/player.js';

interface PlatformDef {
  id: string;
  name: string;
  icon: string;
  iconClass: string;
  qrApp: string;
  cookieTip?: string;
  cookiePlaceholder: string;
  supportsHistory?: boolean;
}

const PLATFORMS: PlatformDef[] = [
  {
    id: 'netease',
    name: '网易云音乐',
    icon: 'mdi:cloud-outline',
    iconClass: '',
    qrApp: '网易云音乐',
    cookiePlaceholder: '粘贴网易云音乐Cookie (MUSIC_U=...)',
    supportsHistory: true,
  },
  {
    id: 'qq',
    name: 'QQ音乐',
    icon: 'mdi:music-circle-outline',
    iconClass: '',
    qrApp: '手机QQ',
    cookiePlaceholder: '粘贴QQ音乐Cookie (uin=...; qm_keyst=...)',
    supportsHistory: false,
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    icon: 'mdi:video-outline',
    iconClass: 'bilibili-icon',
    qrApp: '哔哩哔哩',
    cookiePlaceholder: '粘贴哔哩哔哩Cookie (SESSDATA=...)',
    supportsHistory: true,
  },
  {
    id: 'kugou',
    name: '酷狗音乐',
    icon: 'mdi:music-circle-outline',
    iconClass: 'kugou-icon',
    qrApp: '酷狗音乐',
    cookieTip: '酷狗音乐推荐点击上方「扫码登录」以完整同步自建歌单与我喜欢（因官方限制，网页端复制的 Cookie 仅能试听，无法拉取个人私有歌单）',
    cookiePlaceholder: '推荐使用上方「扫码登录」自动获取全部歌单；或粘贴酷狗 Cookie',
    supportsHistory: false,
  },
];

interface QrState {
  loading: boolean;
  dataUrl: string;
  key: string;
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired';
  pollTimer: any;
}

const store = usePlayerStore();
const loading = ref(true);

const serverEnabledPlatforms = ref<string[]>([]);
const visiblePlatforms = computed(() => {
  return PLATFORMS.filter((p) => {
    if (store.enabledProviders.length > 0) {
      return store.enabledProviders.includes(p.id);
    }
    if (serverEnabledPlatforms.value.length > 0) {
      return serverEnabledPlatforms.value.includes(p.id);
    }
    return true;
  });
});

const cookiesData = reactive<Record<string, { configured: boolean; updatedAt?: number; recordHistory?: boolean }>>({});
const activeMode = reactive<Record<string, 'none' | 'qr' | 'cookie'>>({
  netease: 'none',
  qq: 'none',
  bilibili: 'none',
  kugou: 'none',
});
const cookieInputs = reactive<Record<string, string>>({
  netease: '',
  qq: '',
  bilibili: '',
  kugou: '',
});
const qrStates = reactive<Record<string, QrState>>({
  netease: { loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null },
  qq: { loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null },
  bilibili: { loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null },
  kugou: { loading: false, dataUrl: '', key: '', status: 'waiting', pollTimer: null },
});
const saving = reactive<Record<string, boolean>>({});
const deleting = reactive<Record<string, boolean>>({});
const togglingHistory = reactive<Record<string, boolean>>({});

function isConfigured(platform: string): boolean {
  return Boolean(cookiesData[platform]?.configured);
}

function isHistoryEnabled(platform: string): boolean {
  return Boolean(cookiesData[platform]?.recordHistory);
}

async function toggleHistory(platform: string, event: Event) {
  const target = event.target as HTMLInputElement;
  const enabled = target.checked;
  togglingHistory[platform] = true;
  try {
    const res = await axios.post(`/api/user/cookies/${platform}/history`, { enabled });
    if (res.data?.success) {
      if (!cookiesData[platform]) {
        cookiesData[platform] = { configured: true, updatedAt: Date.now(), recordHistory: enabled };
      } else {
        cookiesData[platform].recordHistory = enabled;
      }
      store.notify(
        `${PLATFORMS.find((p) => p.id === platform)?.name || platform} 播放历史上报已${enabled ? '开启' : '关闭'}`,
        'info'
      );
    }
  } catch (err: any) {
    target.checked = !enabled;
    store.notify(err?.response?.data?.error || err?.response?.data?.message || '更新历史记录设置失败', 'error');
  } finally {
    togglingHistory[platform] = false;
  }
}

async function fetchCookies() {
  try {
    const res = await axios.get('/api/user/cookies');
    const data = res.data?.cookies || res.data;
    if (data && typeof data === 'object') {
      Object.assign(cookiesData, data);
    }
    if (Array.isArray(res.data?.enabledPlatforms)) {
      serverEnabledPlatforms.value = res.data.enabledPlatforms;
    }
  } catch {
    // ignore
  }
}

function closeMode(platform: string) {
  activeMode[platform] = 'none';
  stopQrPoll(platform);
}

function toggleCookieMode(platform: string) {
  if (activeMode[platform] === 'cookie') {
    closeMode(platform);
  } else {
    stopQrPoll(platform);
    activeMode[platform] = 'cookie';
  }
}

function toggleQrMode(platform: string) {
  if (activeMode[platform] === 'qr') {
    closeMode(platform);
  } else {
    activeMode[platform] = 'qr';
    startQr(platform);
  }
}

function stopQrPoll(platform: string) {
  const qr = qrStates[platform];
  if (qr?.pollTimer) {
    clearInterval(qr.pollTimer);
    qr.pollTimer = null;
  }
}

async function startQr(platform: string) {
  stopQrPoll(platform);
  const qr = qrStates[platform];
  qr.loading = true;
  qr.dataUrl = '';
  qr.status = 'waiting';

  try {
    const res = await axios.post('/api/user/cookies/qrcode', { platform });
    const { qrUrl, qrImg, key } = res.data;
    qr.key = key;

    if (qrImg) {
      qr.dataUrl = qrImg;
    } else if (qrUrl) {
      qr.dataUrl = await QRCode.toDataURL(qrUrl, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      });
    }

    qr.loading = false;
    startQrPoll(platform);
  } catch (err: any) {
    qr.loading = false;
    store.notify(err?.response?.data?.error || err?.response?.data?.message || '获取二维码失败', 'error');
  }
}

function startQrPoll(platform: string) {
  const qr = qrStates[platform];
  stopQrPoll(platform);

  qr.pollTimer = setInterval(async () => {
    try {
      const res = await axios.get('/api/user/cookies/qrcode/status', {
        params: { platform, key: qr.key },
      });
      const { status } = res.data;
      qr.status = status;

      if (status === 'confirmed') {
        stopQrPoll(platform);
        store.notify(`${PLATFORMS.find((p) => p.id === platform)?.name || platform} 凭据配置成功！`, 'info');
        await fetchCookies();
        store.invalidateHomeCache();
        store.fetchHomeData();
        setTimeout(() => {
          if (activeMode[platform] === 'qr') {
            closeMode(platform);
          }
        }, 1500);
      } else if (status === 'expired') {
        stopQrPoll(platform);
      }
    } catch {
      // transient network error, keep polling
    }
  }, 3000);
}

async function saveCookie(platform: string) {
  const cookie = cookieInputs[platform]?.trim();
  if (!cookie) return;

  saving[platform] = true;
  try {
    await axios.post('/api/user/cookies', { platform, cookie });
    store.notify(`${PLATFORMS.find((p) => p.id === platform)?.name || platform} 凭据保存成功！`, 'info');
    cookieInputs[platform] = '';
    closeMode(platform);
    await fetchCookies();
    store.invalidateHomeCache();
    store.fetchHomeData();
  } catch (err: any) {
    store.notify(err?.response?.data?.error || err?.response?.data?.message || '保存失败', 'error');
  } finally {
    saving[platform] = false;
  }
}

async function deleteCookie(platform: string) {
  const name = PLATFORMS.find((p) => p.id === platform)?.name || platform;
  if (!window.confirm(`确定要清空 ${name} 的个人凭据吗？清空后将无法个性化展示您的歌单。`)) {
    return;
  }

  deleting[platform] = true;
  try {
    await axios.delete(`/api/user/cookies/${platform}`);
    store.notify(`${name} 凭据已清除`, 'info');
    closeMode(platform);
    await fetchCookies();
    store.invalidateHomeCache();
    store.fetchHomeData();
  } catch (err: any) {
    store.notify(err?.response?.data?.error || err?.response?.data?.message || '清空失败', 'error');
  } finally {
    deleting[platform] = false;
  }
}

onMounted(async () => {
  if (store.enabledProviders.length === 0) {
    await store.fetchProviders();
  }
  await fetchCookies();
  loading.value = false;
});

onUnmounted(() => {
  for (const p of PLATFORMS) {
    stopQrPoll(p.id);
  }
});
</script>

<style lang="scss" scoped>
.user-cookie-settings {
  margin-bottom: 24px;
}

.empty-platforms {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 20px;

  .empty-icon {
    font-size: 18px;
    color: var(--color-primary);
    flex-shrink: 0;
  }
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.title-icon {
  font-size: 22px;
  color: var(--color-primary);
}

.section-desc {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin-bottom: 20px;
}

.account-cards-list {
  display: flex;
  flex-direction: column;
}

.account-card {
  margin-bottom: 20px;
  padding: 20px;
  background: var(--hover-bg);
  border-radius: var(--radius-md);
}

.account-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.account-icon {
  font-size: 28px;
  color: var(--color-primary);

  &.bilibili-icon {
    color: var(--brand-bilibili);
  }

  &.kugou-icon {
    color: var(--brand-kugou);
  }
}

.account-name {
  font-size: 15px;
  font-weight: 600;
}

.account-status {
  font-size: 12px;
  color: var(--text-tertiary);
  &.logged {
    color: var(--color-online);
  }
}

.login-methods {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.login-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: 500;
  transition: all var(--transition-fast);
  cursor: pointer;

  &:hover {
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  &.active {
    background: var(--color-primary-10);
    border-color: var(--color-primary);
    color: var(--color-primary);
  }
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &.btn-clear {
    margin-left: auto;
  }
}

.qr-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 20px 0;
}

.qr-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 14px;
  padding: 12px 0;
}

.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.qr-image {
  width: 200px;
  height: 200px;
  border-radius: var(--radius-md);
  border: 2px solid var(--border-color);
}

.qr-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  background: var(--bg-card);

  &.scanned {
    color: #ff9800;
    background: rgba(255, 152, 0, 0.1);
  }
  &.confirmed {
    color: #4caf50;
    background: rgba(76, 175, 80, 0.1);
  }
  &.expired {
    color: #f44336;
    background: rgba(244, 67, 54, 0.1);
  }
}

.btn-link {
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 600;
  text-decoration: underline;
  margin-left: 8px;
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 0;
}

.cookie-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.cookie-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--color-primary-10, rgba(51, 94, 234, 0.1));
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  line-height: 1.4;
}

.textarea {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 13px;
  font-family: inherit;
  resize: vertical;
  box-sizing: border-box;

  &:focus {
    outline: none;
    border-color: var(--color-primary);
  }
}

.btn-save {
  align-self: flex-end;
}

.history-option-wrap {
  margin-top: 14px;
  margin-bottom: 4px;
}

.history-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  transition: all var(--transition-fast);

  &:hover {
    border-color: var(--color-primary-30, rgba(51, 94, 234, 0.3));
  }

  &.enabled {
    border-color: var(--color-primary);
    background: rgba(51, 94, 234, 0.05);

    .history-icon-box {
      color: var(--color-primary);
      background: var(--color-primary-10, rgba(51, 94, 234, 0.12));
    }
  }
}

.history-icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-sm);
  background: var(--hover-bg);
  color: var(--text-secondary);
  flex-shrink: 0;
  transition: all var(--transition-fast);

  .history-icon {
    font-size: 18px;
  }
}

.history-text {
  flex: 1;
  min-width: 0;
}

.history-header-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.history-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

/* Modern Switch Toggle */
.switch-toggle {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 22px;
  flex-shrink: 0;
  cursor: pointer;

  input {
    opacity: 0;
    width: 0;
    height: 0;

    &:checked + .switch-slider {
      background-color: var(--color-primary);

      &:before {
        transform: translateX(18px);
      }
    }

    &:disabled + .switch-slider {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .switch-slider {
    position: absolute;
    inset: 0;
    background-color: var(--border-color);
    border-radius: 22px;
    transition: all var(--transition-fast);

    &:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 3px;
      bottom: 3px;
      background-color: #ffffff;
      border-radius: 50%;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      transition: all var(--transition-fast);
    }
  }
}
</style>
