import type { MusicPlayerAppElement } from '@/types/music-player-app-element';

type LikeStatus = 'LIKE' | 'DISLIKE' | 'INDIFFERENT';

export interface PlaylistTrack {
  videoId?: string;
  likeStatus?: LikeStatus;
}

interface ListItemRenderer {
  playlistItemData?: { videoId?: string };
  menu?: {
    menuRenderer?: {
      topLevelButtons?: {
        likeButtonRenderer?: {
          likeStatus?: LikeStatus;
          target?: { videoId?: string };
        };
      }[];
    };
  };
}

interface ShelfItem {
  musicResponsiveListItemRenderer?: ListItemRenderer;
  continuationItemRenderer?: {
    continuationEndpoint?: { continuationCommand?: { token?: string } };
  };
}

interface Shelf {
  contents?: ShelfItem[];
  continuations?: { nextContinuationData?: { continuation?: string } }[];
}

interface BrowseResponse {
  contents?: {
    twoColumnBrowseResultsRenderer?: {
      secondaryContents?: {
        sectionListRenderer?: {
          contents?: { musicPlaylistShelfRenderer?: Shelf }[];
        };
      };
    };
    singleColumnBrowseResultsRenderer?: {
      tabs?: {
        tabRenderer?: {
          content?: {
            sectionListRenderer?: {
              contents?: { musicPlaylistShelfRenderer?: Shelf }[];
            };
          };
        };
      }[];
    };
  };
  continuationContents?: { musicPlaylistShelfContinuation?: Shelf };
  onResponseReceivedActions?: {
    appendContinuationItemsAction?: { continuationItems?: ShelfItem[] };
  }[];
}

const getApp = () => {
  const app = document.querySelector<MusicPlayerAppElement>('ytmusic-app');
  if (!app) throw new Error('ytmusic-app not found');
  return app;
};

// Only the playlist shelf holds the playlist's own songs; the "Suggestions"
// shelf on your own playlists lives in a different renderer.
const findShelf = (response: BrowseResponse): Shelf | undefined => {
  const sections =
    response.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
      ?.sectionListRenderer?.contents ??
    response.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
      ?.content?.sectionListRenderer?.contents;
  return sections?.find((it) => it.musicPlaylistShelfRenderer)
    ?.musicPlaylistShelfRenderer;
};

const parseItems = (items: ShelfItem[] = []) => {
  const tracks: PlaylistTrack[] = [];
  let continuation: string | undefined;
  for (const item of items) {
    const renderer = item.musicResponsiveListItemRenderer;
    if (renderer) {
      const likeButton = renderer.menu?.menuRenderer?.topLevelButtons?.find(
        (it) => it.likeButtonRenderer,
      )?.likeButtonRenderer;
      tracks.push({
        videoId: likeButton?.target?.videoId,
        likeStatus: likeButton?.likeStatus,
      });
    }
    continuation ??=
      item.continuationItemRenderer?.continuationEndpoint?.continuationCommand
        ?.token;
  }
  return { tracks, continuation };
};

export const getPlaylistTracks = async (
  playlistId: string,
  signal: AbortSignal,
  onPage: (count: number) => void,
) => {
  const app = getApp();
  const tracks: PlaylistTrack[] = [];

  const first = await app.networkManager.fetch<
    BrowseResponse,
    { browseId: string }
  >('/browse', { browseId: `VL${playlistId}` });
  const shelf = findShelf(first);
  if (!shelf) throw new Error('Playlist shelf not found in browse response');

  let page = parseItems(shelf.contents);
  let continuation =
    page.continuation ??
    shelf.continuations?.[0]?.nextContinuationData?.continuation;
  tracks.push(...page.tracks);
  onPage(tracks.length);

  while (continuation && !signal.aborted) {
    const next = await app.networkManager.fetch<
      BrowseResponse,
      { continuation: string }
    >('/browse', { continuation });
    const legacy = next.continuationContents?.musicPlaylistShelfContinuation;
    page = parseItems(
      legacy?.contents ??
        next.onResponseReceivedActions?.[0]?.appendContinuationItemsAction
          ?.continuationItems,
    );
    continuation =
      page.continuation ??
      legacy?.continuations?.[0]?.nextContinuationData?.continuation;
    tracks.push(...page.tracks);
    onPage(tracks.length);
  }

  return tracks;
};

export const likeSong = (videoId: string) =>
  getApp().networkManager.fetch<unknown, { target: { videoId: string } }>(
    '/like/like',
    { target: { videoId } },
  );
