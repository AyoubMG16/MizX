export const REGIONS = Object.freeze(
  [
    {
      id: 'sg',
      name: 'Singapore',
      locale: 'en',
      timezone: 'Asia/Singapore',
      status: 'online',
      recommended: true,
      zoneId: 1,
    },
    {
      id: 'id',
      name: 'Indonesia',
      locale: 'id',
      timezone: 'Asia/Jakarta',
      status: 'online',
      recommended: true,
      zoneId: 2,
    },
    {
      id: 'br',
      name: 'Brazil',
      locale: 'pt-BR',
      timezone: 'America/Sao_Paulo',
      status: 'online',
      recommended: false,
      zoneId: 3,
    },
    {
      id: 'in',
      name: 'India',
      locale: 'en',
      timezone: 'Asia/Kolkata',
      status: 'online',
      recommended: true,
      zoneId: 4,
    },
    {
      id: 'me',
      name: 'Middle East',
      locale: 'en',
      timezone: 'Asia/Dubai',
      status: 'online',
      recommended: false,
      zoneId: 5,
    },
    {
      id: 'pk',
      name: 'Pakistan',
      locale: 'en',
      timezone: 'Asia/Karachi',
      status: 'online',
      recommended: false,
      zoneId: 6,
    },
  ].map((region) => Object.freeze(region)),
);

export const REGION_BY_ID = new Map(REGIONS.map((region) => [region.id, region]));

export const REGION_ID_MAPPING = Object.freeze(
  Object.fromEntries(REGIONS.map((region) => [region.id, region.zoneId])),
);

export const GAME_MODES = Object.freeze(
  [
    { id: 'br_solo', name: 'Battle Royale - Solo', teamSize: 1, maxPlayers: 50 },
    { id: 'br_duo', name: 'Battle Royale - Duo', teamSize: 2, maxPlayers: 50 },
    { id: 'br_squad', name: 'Battle Royale - Squad', teamSize: 4, maxPlayers: 52 },
    { id: 'clash_squad', name: 'Clash Squad', teamSize: 4, maxPlayers: 8 },
  ].map((mode) => Object.freeze(mode)),
);

export const GAME_MODE_BY_ID = new Map(GAME_MODES.map((mode) => [mode.id, mode]));

export const MAPS = Object.freeze(
  [
    { id: 'bermuda', name: 'Bermuda' },
    { id: 'purgatory', name: 'Purgatory' },
    { id: 'kalahari', name: 'Kalahari' },
    { id: 'alpine', name: 'Alpine' },
  ].map((map) => Object.freeze(map)),
);

export const MAP_BY_ID = new Map(MAPS.map((map) => [map.id, map]));

export const RANKS = Object.freeze(
  [
    { name: 'Bronze I', minPoints: 0 },
    { name: 'Bronze II', minPoints: 100 },
    { name: 'Bronze III', minPoints: 200 },
    { name: 'Silver I', minPoints: 350 },
    { name: 'Silver II', minPoints: 500 },
    { name: 'Silver III', minPoints: 700 },
    { name: 'Gold I', minPoints: 900 },
    { name: 'Gold II', minPoints: 1200 },
    { name: 'Gold III', minPoints: 1500 },
    { name: 'Platinum I', minPoints: 1900 },
    { name: 'Platinum II', minPoints: 2300 },
    { name: 'Platinum III', minPoints: 2700 },
    { name: 'Diamond I', minPoints: 3200 },
    { name: 'Diamond II', minPoints: 3700 },
    { name: 'Diamond III', minPoints: 4200 },
    { name: 'Heroic', minPoints: 5000 },
    { name: 'Grandmaster', minPoints: 6000 },
  ].map((rank) => Object.freeze(rank)),
);

export const ANNOUNCEMENTS = Object.freeze([
  Object.freeze({
    id: 'welcome-mock',
    severity: 'info',
    title: 'Mock lobby online',
    message:
      'This service emulates handshake, auth, and lobby data for analysis and testing. Battle and chat services are not implemented.',
    startsAt: null,
    endsAt: null,
  }),
]);

export function getRegion(regionId) {
  return REGION_BY_ID.get(String(regionId ?? '').toLowerCase()) ?? null;
}

export function resolveRegion(regionId, fallback = 'sg') {
  return getRegion(regionId) ?? getRegion(fallback) ?? REGIONS[0];
}

export function getRecommendedRegions(regionId, limit = 3) {
  const current = getRegion(regionId);
  const others = REGIONS.filter((region) => region.id !== current?.id && region.status === 'online');
  return [...(current ? [current] : []), ...others].slice(0, limit).map((region) => region.id);
}

export function getRankForPoints(points) {
  const normalized = Number.isFinite(points) ? Math.max(0, points) : 0;
  let rank = RANKS[0];
  for (const candidate of RANKS) {
    if (normalized >= candidate.minPoints) rank = candidate;
    else break;
  }
  return rank;
}

export function serializeRegion(region) {
  return {
    region: region.id,
    region_id: region.zoneId,
    name: region.name,
    locale: region.locale,
    timezone: region.timezone,
    status: region.status,
    recommended: region.recommended,
  };
}
