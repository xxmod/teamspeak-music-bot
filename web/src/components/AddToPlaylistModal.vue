<template>
  <div v-if="modelValue" class="modal-overlay" @click="close">
    <div class="modal-card" @click.stop>
      <div class="modal-header">
        <div class="modal-title">
          <Icon icon="mdi:playlist-plus" class="modal-icon" />
          添加到歌单
        </div>
        <button class="modal-close" @click="close">
          <Icon icon="mdi:close" />
        </button>
      </div>

      <!-- 当前歌曲信息简报 -->
      <div v-if="song" class="song-summary">
        <CoverArt :url="song.coverUrl" :size="48" :radius="6" />
        <div class="song-text">
          <div class="song-title" :title="song.name">{{ song.name }}</div>
          <div class="song-sub">{{ song.artist }} · {{ platformLabel(song.platform) }}</div>
        </div>
      </div>

      <!-- 歌单列表 -->
      <div class="playlists-container">
        <div v-if="loading" class="state-tip">
          <Icon icon="mdi:loading" class="spin" />
          正在加载您的歌单...
        </div>
        <div v-else-if="errorMsg" class="state-tip error">
          <Icon icon="mdi:alert-circle-outline" />
          {{ errorMsg }}
        </div>
        <div v-else-if="playlists.length === 0" class="state-tip">
          暂无可用自建歌单
        </div>
        <div v-else class="playlist-items">
          <button
            v-for="pl in playlists"
            :key="pl.id"
            class="playlist-item"
            :disabled="submitting === pl.id"
            @click="addTo(pl)"
          >
            <CoverArt :url="pl.coverUrl" :size="44" :radius="6" />
            <div class="playlist-meta">
              <div class="playlist-name" :title="pl.name">{{ pl.name }}</div>
              <div class="playlist-count">{{ pl.songCount }} 首歌曲</div>
            </div>
            <div class="playlist-action">
              <Icon v-if="submitting === pl.id" icon="mdi:loading" class="spin" />
              <Icon v-else icon="mdi:plus" />
            </div>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import axios from 'axios';
import { usePlayerStore, type Song, type PlaylistItem } from '../stores/player.js';
import CoverArt from './CoverArt.vue';

const props = defineProps<{
  modelValue: boolean;
  song?: Song | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'added', playlist: PlaylistItem): void;
}>();

const store = usePlayerStore();
const playlists = ref<PlaylistItem[]>([]);
const loading = ref(false);
const errorMsg = ref('');
const submitting = ref<string | null>(null);

function platformLabel(platform?: string): string {
  switch (platform) {
    case 'netease': return '网易云音乐';
    case 'qq': return 'QQ音乐';
    case 'kugou': return '酷狗音乐';
    default: return platform || '';
  }
}

function close() {
  emit('update:modelValue', false);
}

async function loadPlaylists() {
  if (!props.song?.platform) return;
  loading.value = true;
  errorMsg.value = '';
  try {
    const res = await axios.get('/api/music/user/playlists', {
      params: { platform: props.song.platform },
    });
    const rawList: PlaylistItem[] = res.data?.playlists ?? [];
    playlists.value = rawList.filter((p) => p.editable !== false);
    if (playlists.value.length === 0 && rawList.length > 0) {
      errorMsg.value = '暂无可编辑的自建歌单（收藏的他方歌单不支持添加歌曲）';
    }
  } catch (err: any) {
    errorMsg.value = err?.response?.data?.error || '加载歌单失败，请检查登录凭据';
  } finally {
    loading.value = false;
  }
}

async function addTo(pl: PlaylistItem) {
  if (!props.song || submitting.value) return;
  submitting.value = pl.id;
  try {
    await axios.post('/api/music/playlist/add-song', {
      platform: props.song.platform,
      playlistId: pl.id,
      songId: props.song.id,
    });
    store.notify(`已将《${props.song.name}》添加到歌单「${pl.name}」`, 'info');
    emit('added', pl);
    close();
  } catch (err: any) {
    store.notify(err?.response?.data?.error || '添加失败，可能该歌单不允许修改', 'error');
  } finally {
    submitting.value = null;
  }
}

watch(
  () => props.modelValue,
  (val) => {
    if (val) {
      loadPlaylists();
    }
  }
);
</script>

<style lang="scss" scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  animation: fadeIn 0.15s ease-out;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.modal-card {
  width: 100%;
  max-width: 440px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg, 12px);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  max-height: 80vh;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);

  .modal-title {
    font-size: 16px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-primary);

    .modal-icon {
      font-size: 20px;
      color: var(--color-primary);
    }
  }

  .modal-close {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px;
    border-radius: var(--radius-sm, 4px);
    transition: all var(--transition-fast);

    &:hover {
      background: var(--hover-bg);
      color: var(--text-primary);
    }
  }
}

.song-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 20px;
  background: var(--hover-bg);
  border-bottom: 1px solid var(--border-color);

  .song-text {
    flex: 1;
    min-width: 0;

    .song-title {
      font-size: 14px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-primary);
    }

    .song-sub {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }
}

.playlists-container {
  flex: 1;
  overflow-y: auto;
  padding: 8px 12px;
  max-height: 360px;
}

.state-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 0;
  color: var(--text-secondary);
  font-size: 13px;

  &.error {
    color: var(--color-danger, #e74c3c);
  }
}

.playlist-items {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.playlist-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-md, 8px);
  cursor: pointer;
  text-align: left;
  transition: all var(--transition-fast);
  color: inherit;
  width: 100%;

  &:hover:not(:disabled) {
    background: var(--hover-bg);
    border-color: var(--border-color);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .playlist-meta {
    flex: 1;
    min-width: 0;

    .playlist-name {
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .playlist-count {
      font-size: 12px;
      color: var(--text-secondary);
      margin-top: 2px;
    }
  }

  .playlist-action {
    font-size: 18px;
    color: var(--text-tertiary);
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--radius-sm, 4px);
  }

  &:hover .playlist-action {
    color: var(--color-primary);
  }
}
</style>
