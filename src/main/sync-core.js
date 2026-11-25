'use strict';

// Pure helpers for the shared-setup sync (no Electron dependencies, so they can
// be unit-tested with plain Node).
//
// Cloud shape (keyed by id, not arrays, so concurrent edits to different groups
// or services merge instead of overwriting each other):
//   { pinHash?, groups: { <gid>: { name, icon?, order,
//                                  services: { <sid>: { name, url, shared, order } } } } }
//
// Local config shape (what the app renders):
//   { pinHash, groups: [{ id, name, icon, services: [{ id, name, url, shared }] }] }

// Normalize whatever came back from Firebase. Firebase drops nulls and empty
// objects, so absent fields get defaults. Groups without a name (left behind when
// someone adds a service to a group another user just deleted) are dropped.
function canonMap(raw) {
  const out = { pinHash: (raw && raw.pinHash) || null, groups: {} };
  const groups = (raw && raw.groups && typeof raw.groups === 'object') ? raw.groups : {};
  for (const gid of Object.keys(groups)) {
    const g = groups[gid];
    if (!g || typeof g !== 'object' || !g.name) continue;
    const services = {};
    const ss = (g.services && typeof g.services === 'object') ? g.services : {};
    for (const sid of Object.keys(ss)) {
      const s = ss[sid];
      if (!s || typeof s !== 'object' || !s.url) continue;
      services[sid] = { name: s.name || '', url: s.url, shared: !!s.shared, order: Number(s.order) || 0 };
    }
    out.groups[gid] = { name: g.name, icon: g.icon || null, order: Number(g.order) || 0, services };
  }
  return out;
}

// Ids of nameless leftover groups in raw cloud data (to clean up).
function ghostGroupIds(raw) {
  const groups = (raw && raw.groups && typeof raw.groups === 'object') ? raw.groups : {};
  return Object.keys(groups).filter((gid) => !groups[gid] || typeof groups[gid] !== 'object' || !groups[gid].name);
}

// Local config (arrays) -> keyed map. Order comes from array position.
function toMap(config) {
  const out = { pinHash: (config && config.pinHash) || null, groups: {} };
  ((config && config.groups) || []).forEach((g, gi) => {
    const services = {};
    (g.services || []).forEach((s, si) => {
      if (!s || !s.id || !s.url) return;
      services[s.id] = { name: s.name || '', url: s.url, shared: !!s.shared, order: si };
    });
    if (!g || !g.id || !g.name) return;
    out.groups[g.id] = { name: g.name, icon: g.icon || null, order: gi, services };
  });
  return out;
}

// Keyed map -> local shape (arrays), sorted by order then id (deterministic, so
// every device shows the same order even after concurrent inserts).
function fromMap(map) {
  const byOrder = (a, b) => (a[1].order - b[1].order) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return {
    pinHash: (map && map.pinHash) || null,
    groups: Object.entries((map && map.groups) || {}).sort(byOrder).map(([gid, g]) => ({
      id: gid,
      name: g.name,
      icon: g.icon || null,
      services: Object.entries(g.services || {}).sort(byOrder)
        .map(([sid, s]) => ({ id: sid, name: s.name, url: s.url, shared: !!s.shared }))
    }))
  };
}

const GROUP_FIELDS = ['name', 'icon', 'order'];
const SERVICE_FIELDS = ['name', 'url', 'shared', 'order'];
const same = (a, b) => (a === undefined ? null : a) === (b === undefined ? null : b);

// Minimal set of path updates that turns `base` into `local`, in Firebase
// multi-location PATCH form: { "groups/g1/name": "Work", "groups/g2": null, ... }.
// Never emits both a path and one of its children.
function diffMaps(base, local) {
  const up = {};
  if (!same(base.pinHash, local.pinHash)) up.pinHash = local.pinHash || null;
  const bg = base.groups || {};
  const lg = local.groups || {};
  for (const gid of new Set([...Object.keys(bg), ...Object.keys(lg)])) {
    const b = bg[gid];
    const l = lg[gid];
    if (!l) { up['groups/' + gid] = null; continue; }
    if (!b) { up['groups/' + gid] = l; continue; }
    for (const f of GROUP_FIELDS) if (!same(b[f], l[f])) up['groups/' + gid + '/' + f] = l[f] === undefined ? null : l[f];
    const bs = b.services || {};
    const ls = l.services || {};
    for (const sid of new Set([...Object.keys(bs), ...Object.keys(ls)])) {
      const p = 'groups/' + gid + '/services/' + sid;
      if (!ls[sid]) { up[p] = null; continue; }
      if (!bs[sid]) { up[p] = ls[sid]; continue; }
      for (const f of SERVICE_FIELDS) if (!same(bs[sid][f], ls[sid][f])) up[p + '/' + f] = ls[sid][f];
    }
  }
  return up;
}

// Apply path updates to a map (null deletes), then normalize.
function applyUpdates(map, updates) {
  const out = JSON.parse(JSON.stringify(map || {}));
  for (const [p, v] of Object.entries(updates || {})) {
    const parts = p.split('/');
    let node = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (node[parts[i]] == null || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (v === null) delete node[last];
    else node[last] = JSON.parse(JSON.stringify(v));
  }
  return canonMap(out);
}

// Key-order-independent JSON, for equality checks.
function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
}

// Combine a shared structure (local shape) with this device's own state: the
// active group, each group's open tab, per-tab mute, Do Not Disturb, unlock.
function withLocalState(structure, local) {
  const src = local || {};
  const prevGroups = new Map((src.groups || []).map((g) => [g.id, g]));
  const muted = new Set();
  (src.groups || []).forEach((g) => (g.services || []).forEach((s) => { if (s.muted) muted.add(s.id); }));

  const groups = (structure.groups || []).map((g) => {
    const services = (g.services || []).map((s) => ({ ...s, muted: muted.has(s.id) }));
    const out = { id: g.id, name: g.name, icon: g.icon || null, services };
    const prev = prevGroups.get(g.id);
    if (prev && prev.activeServiceId && services.some((s) => s.id === prev.activeServiceId)) {
      out.activeServiceId = prev.activeServiceId;
    }
    return out;
  });
  if (!groups.length) groups.push({ id: 'g_default', name: 'Default', services: [] });

  return {
    version: 2,
    activeGroupId: src.activeGroupId || groups[0].id,
    dnd: !!src.dnd,
    _unlocked: !!src._unlocked,
    pinHash: structure.pinHash || null,
    groups
  };
}

module.exports = { canonMap, ghostGroupIds, toMap, fromMap, diffMaps, applyUpdates, stableJson, withLocalState };
