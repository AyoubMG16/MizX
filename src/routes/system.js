import { Router } from 'express';
import {
  ANNOUNCEMENTS,
  REGIONS,
  REGION_ID_MAPPING,
  getRecommendedRegions,
  serializeRegion,
} from '../game-data.js';
import { getBaseUrl, getHostAndPort, toWebSocketUrl } from '../urls.js';

export function createSystemRouter({ config, store }) {
  const router = Router();

  router.get('/', (req, res) => {
    const baseUrl = getBaseUrl(req, config);
    res.json({
      service: 'freefire-mock-backend',
      version: '1.0.0',
      status: 'ok',
      mock: true,
      analyzed_client: {
        package: 'com.dts.freefireth',
        version: config.game.version,
        version_code: config.game.versionCode,
      },
      description:
        'Mock handshake, guest authentication, lobby, room, and WebSocket backend based on static analysis of the Free Fire 1.38.2 APK.',
      limitations:
        'This is not the proprietary encrypted protobuf/RUDP game protocol and cannot host retail clients or matches.',
      endpoints: {
        health: `${baseUrl}/healthz`,
        version: `${baseUrl}/live/ver.php`,
        server_list: `${baseUrl}/live/serverList.json`,
        protocol: `${baseUrl}/api/protocol`,
        websocket: toWebSocketUrl(baseUrl, config.websocket.path),
      },
    });
  });

  router.get(['/health', '/healthz'], (_req, res) => {
    res.json({
      status: 'ok',
      service: 'freefire-mock-backend',
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      store: store.stats(),
    });
  });

  router.get('/live/ver.php', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    const version = config.game.version;
    res.json({
      appstore: {
        latest_version: version,
        minimum_version: version,
        version_code: config.game.versionCode,
        download_url: 'https://play.google.com/store/apps/details?id=com.dts.freefireth',
        force_update: false,
      },
      versioninfo: {
        version,
        version_code: config.game.versionCode,
        release_channel: 'live',
        status: 'online',
        maintenance: {
          enabled: false,
          message: '',
        },
        server_time: Math.floor(Date.now() / 1000),
      },
      fileinfo: {
        version: `${version}.0`,
        obb_version: 1,
        files: [],
      },
      gameassetbundles: [],
      _mock: true,
      _note:
        'Schema uses the top-level keys recovered from the launcher; values are placeholders. It is not a real hot-update manifest.',
    });
  });

  router.get('/live/serverList.json', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=30');
    const baseUrl = getBaseUrl(req, config);
    const { host, port } = getHostAndPort(baseUrl, config.port);

    res.json({
      version: config.game.version,
      default_region: config.game.defaultRegion,
      recommended_region: config.game.defaultRegion,
      recommended_regions: getRecommendedRegions(config.game.defaultRegion, REGIONS.length),
      region_id_mapping: REGION_ID_MAPPING,
      serverList: REGIONS.map((region) => ({
        ...serializeRegion(region),
        address: host,
        port,
        websocket_path: config.websocket.path,
        websocket_url: toWebSocketUrl(baseUrl, config.websocket.path),
      })),
      server_time: Math.floor(Date.now() / 1000),
      _mock: true,
    });
  });

  router.get('/live/announcements.json', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({
      announcements: ANNOUNCEMENTS.map((announcement) => ({ ...announcement })),
      server_time: Math.floor(Date.now() / 1000),
      _mock: true,
    });
  });

  return router;
}
