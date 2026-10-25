import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';

import { t } from '@/i18n';
import { type MenuTemplate } from '@/menu';
import { createPlugin, LoggerPrefix } from '@/utils';
import { waitForElement } from '@/utils/wait-for-element';

import { getPlaylistTracks, likeSong } from './api';
import style from './style.css?inline';
import { LikeAllButton } from './templates/like-all-button';

export type LikeAllSongsPluginConfig = {
  enabled: boolean;
  delay: number;
};

type Job =
  | { state: 'idle' }
  | { state: 'loading'; count: number }
  | { state: 'liking'; liked: number; total: number }
  | { state: 'done'; liked: number; skipped: number; unavailable: number }
  | { state: 'nothing'; count: number; unavailable: number }
  | { state: 'stopped'; liked: number; total: number }
  | { state: 'error'; liked: number; total: number };

const DELAYS = [500, 1000, 2000, 5000];
const MAX_ATTEMPTS = 3;

const [job, setJob] = createSignal<Job>({ state: 'idle' });

const unavailableText = (count: number) =>
  count > 0 ? t('plugins.like-all-songs.templates.unavailable', { count }) : '';

const buttonText = () => {
  const current = job();
  const key = `plugins.like-all-songs.templates.button.${current.state}`;
  switch (current.state) {
    case 'done':
      return t(key, current) + unavailableText(current.unavailable);
    case 'nothing':
      return t(key, current) + unavailableText(current.unavailable);
    case 'idle':
      return t(key);
    default:
      return t(key, current);
  }
};

const isBusy = () => ['loading', 'liking'].includes(job().state);

// Resolves early when the run is stopped, so stopping never waits out a delay
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });

const getPlaylistId = () => {
  if (window.location.pathname !== '/playlist') return null;
  const id = new URLSearchParams(window.location.search).get('list');
  // Liking everything in Liked music would do nothing
  return id && id !== 'LM' ? id : null;
};

export default createPlugin<
  unknown,
  unknown,
  {
    delay: number;
    container?: HTMLElement;
    dispose?: () => void;
    observer?: MutationObserver;
    controller?: AbortController;
    pending: boolean;
    playlistId: string | null;
    onPageChange(): void;
    onClick(): void;
    likeAll(playlistId: string): Promise<void>;
    likeWithRetry(videoId: string, signal: AbortSignal): Promise<void>;
  },
  LikeAllSongsPluginConfig
>({
  name: () => t('plugins.like-all-songs.name'),
  description: () => t('plugins.like-all-songs.description'),
  restartNeeded: false,
  stylesheets: [style],
  config: {
    enabled: false,
    delay: 1000,
  },
  menu: async ({ getConfig, setConfig }): Promise<MenuTemplate> => {
    const config = await getConfig();

    return [
      {
        label: t('plugins.like-all-songs.menu.delay.label'),
        submenu: DELAYS.map((delay) => ({
          label: t('plugins.like-all-songs.menu.delay.submenu.seconds', {
            seconds: delay / 1000,
          }),
          type: 'radio',
          checked: config.delay === delay,
          click() {
            setConfig({ delay });
          },
        })),
      },
    ];
  },

  renderer: {
    delay: 1000,
    pending: false,
    playlistId: null,

    async start({ getConfig }) {
      this.delay = (await getConfig()).delay;

      this.container = document.createElement('div');
      this.container.id = 'like-all-songs';
      this.dispose = render(
        () => (
          <LikeAllButton
            busy={isBusy()}
            onClick={() => this.onClick()}
            text={buttonText()}
          />
        ),
        this.container,
      );

      const browsePage = await waitForElement<HTMLElement>('#browse-page');
      this.observer = new MutationObserver(() => this.onPageChange());
      this.observer.observe(browsePage, { childList: true, subtree: true });
      this.onPageChange();
    },

    onConfigChange(newConfig) {
      this.delay = newConfig.delay;
    },

    onPageChange() {
      // Batch the mutations of one page render into a single check
      if (this.pending) return;
      this.pending = true;
      requestAnimationFrame(() => {
        this.pending = false;
        if (!this.container) return;

        const playlistId = getPlaylistId();
        if (!playlistId) {
          this.container.remove();
          return;
        }

        if (playlistId !== this.playlistId && !isBusy())
          setJob({ state: 'idle' });
        this.playlistId = playlistId;

        const actions = document.querySelector(
          '#browse-page ytmusic-responsive-header-renderer .action-buttons',
        );
        // Own row under the header buttons, as the progress text gets long
        if (actions && actions.nextElementSibling !== this.container) {
          actions.after(this.container);
        }
      });
    },

    onClick() {
      if (this.controller) {
        this.controller.abort();
        return;
      }
      if (this.playlistId) this.likeAll(this.playlistId);
    },

    async likeWithRetry(videoId, signal) {
      for (let attempt = 1; ; attempt++) {
        try {
          await likeSong(videoId);
          return;
        } catch (error) {
          if (attempt >= MAX_ATTEMPTS || signal.aborted) throw error;
          console.warn(LoggerPrefix, 'Like failed, backing off', error);
          await sleep(this.delay * 10 * attempt, signal);
        }
      }
    },

    async likeAll(playlistId) {
      const controller = new AbortController();
      const { signal } = controller;
      this.controller = controller;

      let liked = 0;
      let total = 0;
      try {
        setJob({ state: 'loading', count: 0 });
        const tracks = await getPlaylistTracks(playlistId, signal, (count) =>
          setJob({ state: 'loading', count }),
        );
        if (signal.aborted) {
          setJob({ state: 'stopped', liked, total });
          return;
        }

        const seen = new Set<string>();
        const toLike: string[] = [];
        let skipped = 0;
        let unavailable = 0;
        for (const track of tracks) {
          // No like button means the song is unavailable; disliked songs are
          // a deliberate choice, so neither gets liked
          if (
            !track.videoId ||
            !track.likeStatus ||
            track.likeStatus === 'DISLIKE'
          ) {
            unavailable++;
          } else if (!seen.has(track.videoId)) {
            seen.add(track.videoId);
            if (track.likeStatus === 'LIKE') skipped++;
            else toLike.push(track.videoId);
          }
        }

        if (toLike.length === 0) {
          setJob({ state: 'nothing', count: skipped, unavailable });
          return;
        }

        // Each like lands at the top of Liked music, so like from the bottom
        // up to keep the playlist's order there
        toLike.reverse();
        total = toLike.length;
        for (const videoId of toLike) {
          if (signal.aborted) break;
          setJob({ state: 'liking', liked, total });
          await this.likeWithRetry(videoId, signal);
          liked++;
          setJob({ state: 'liking', liked, total });
          if (liked < total) await sleep(this.delay, signal);
        }

        setJob(
          signal.aborted
            ? { state: 'stopped', liked, total }
            : { state: 'done', liked, skipped, unavailable },
        );
      } catch (error) {
        console.error(LoggerPrefix, 'Like all songs failed', error);
        setJob({ state: 'error', liked, total });
      } finally {
        this.controller = undefined;
      }
    },

    stop() {
      this.controller?.abort();
      this.observer?.disconnect();
      this.dispose?.();
      this.container?.remove();
      this.container = undefined;
    },
  },
});
