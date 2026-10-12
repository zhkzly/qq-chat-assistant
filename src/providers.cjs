'use strict';
const { randomUUID } = require('node:crypto');

function ensureProfiles(settings) {
  if (!Array.isArray(settings.modelProfiles) || !settings.modelProfiles.length) {
    settings.modelProfiles = [{ id: 'default', name: '原有 API', baseUrl: settings.baseUrl || '',
      model: settings.model || '', apiKey: settings.apiKey || '', visionEnabled: !!settings.visionEnabled,
      anonymous: settings.anonymous === true }];
    settings.activeModelProfileId = 'default';
  }
  return settings.modelProfiles;
}
function publicProfiles(settings) {
  const profiles = ensureProfiles(settings).map(({ id, name, baseUrl, model, apiKey, visionEnabled, anonymous }) =>
    ({ id, name, baseUrl, model, hasKey: !!apiKey, visionEnabled: !!visionEnabled, anonymous: !!anonymous }));
  return { activeProfileId: settings.activeModelProfileId, profiles };
}
function profileFor(settings, id) {
  const profiles = ensureProfiles(settings);
  if (id === 'new') return null;
  const profile = profiles.find(p => p.id === (id || settings.activeModelProfileId));
  if (!profile) throw new Error('API 配置不存在，请重新打开模型设置');
  return profile;
}
function baseURL(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('请填写完整的 API 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('API 地址须为 HTTP(S) 地址，不能含密钥、查询参数或片段');
  return url.toString().replace(/\/+$/, '');
}
function modelID(value) {
  const model = String(value || '').trim();
  if (!model || model.length > 200 || /[\x00-\x1f]/.test(model)) throw new Error('请填写有效的模型 ID');
  return model;
}
function connection(settings, args) {
  const previous = profileFor(settings, args.profileId);
  const baseUrl = baseURL(args.baseUrl === undefined ? previous?.baseUrl : args.baseUrl);
  const anonymous = args.anonymous === undefined ? !!previous?.anonymous : args.anonymous === true;
  const suppliedKey = typeof args.apiKey === 'string' ? args.apiKey.trim() : '';
  const sameDestination = previous && baseUrl === previous.baseUrl;
  const apiKey = anonymous ? '' : (suppliedKey || (sameDestination ? previous.apiKey : ''));
  if (!apiKey && !anonymous) throw new Error('请为这个 API 地址填写密钥；免密本地服务请勾选「无需 API Key」');
  if (apiKey.length > 8192 || /[\r\n]/.test(apiKey)) throw new Error('API Key 格式不正确');
  return { previous, baseUrl, apiKey, anonymous };
}
function activate(settings, profile, profiles) {
  Object.assign(settings, { modelProfiles: profiles, activeModelProfileId: profile.id,
    baseUrl: profile.baseUrl, model: profile.model, apiKey: profile.apiKey,
    visionEnabled: profile.visionEnabled, anonymous: profile.anonymous });
}
function saveProfile(settings, args) {
  const { previous, ...endpoint } = connection(settings, args);
  const model = modelID(args.model);
  const profile = { ...endpoint, id: previous?.id || randomUUID(),
    name: String(args.name || previous?.name || '新的 API').trim().slice(0, 80), model,
    visionEnabled: args.visionEnabled === true };
  const profiles = ensureProfiles(settings).filter(p => p.id !== profile.id);
  profiles.push(profile);
  activate(settings, profile, profiles);
}
function selectModel(settings, args) {
  const previous = profileFor(settings, args.profileId);
  if (!previous) throw new Error('请先保存新的 API 配置');
  const model = modelID(args.model === undefined ? previous.model : args.model);
  const profile = { ...previous, model, visionEnabled: model === previous.model && previous.visionEnabled };
  activate(settings, profile, ensureProfiles(settings).map(p => p.id === profile.id ? profile : p));
}
async function discoverModels(settings, args, fetchImpl = fetch) {
  const { baseUrl, apiKey } = connection(settings, args);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, { method: 'GET', redirect: 'error',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(12000) });
  } catch (error) {
    throw new Error(`读取模型列表失败（${error.name === 'TimeoutError' ? '超时' : '连接失败'}）；可手动填写模型 ID`);
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`模型列表返回 HTTP ${response.status}；可检查地址/密钥，或手动填写模型 ID`); }
  let result;
  try { result = await response.json(); } catch { throw new Error('模型列表不是 JSON；请检查 API 地址'); }
  if (!Array.isArray(result.data)) throw new Error('服务未返回标准模型列表，可手动填写模型 ID');
  const ids = [...new Set(result.data.map(m => m?.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 200))].sort();
  return { baseUrl, models: ids.map(id => ({ id, imageGeneration: /^gpt-image(?:-|$)/.test(id) })) };
}
module.exports = { ensureProfiles, publicProfiles, saveProfile, selectModel, discoverModels };
